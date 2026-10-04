import { performance } from 'node:perf_hooks';
import { UnrecoverableError } from 'bullmq';
import { GrammyError } from 'grammy';
import { localToday, type RulesContext } from '@triathlon/core';
import {
  buildDailyContext,
  DAILY_PROMPT_VERSION,
  runCoachSuggestion,
  runRulesFallback,
  type CoachDecisionRecord,
  type CoachDecisionSink,
  type CoachDecisionSource,
  type DailyContextDeps,
  type DailyContextResult,
  type GuardrailConfig,
  type LlmProvider,
  type PlannedSessionSummary,
} from '@triathlon/ai';
import { coachPlanWindow, toCoachPlanSession } from '../coach-plan';
import type { IcuConnectionRecord } from '../icu-connect';
import { toTelegramMessage, type RichReply, type TelegramMessageOptions } from '../reply';
import { renderBrief } from './render';
import type { DailyBriefRun, DailyBriefRunRepo, StageTimings } from './run-store';
import type { BriefProfileRepo } from './scheduler';

/** How long a running pipeline holds the day's run before a retry may take it over */
export const BRIEF_LEASE_MS = 5 * 60_000;

export type BriefStage = 'wellness' | 'activity' | 'context' | 'suggest' | 'send';

export interface BriefLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface DailyBriefDeps {
  runs: DailyBriefRunRepo;
  profiles: BriefProfileRepo;
  /** wellness-sync `syncWellness`; throws when ICU is down */
  syncWellness(userId: string): Promise<unknown>;
  /** activity-sync `syncActivities`; throws when ICU is down */
  syncActivities(userId: string): Promise<unknown>;
  /** Sync cursors for the stale-data note */
  connections: { findByUserId(userId: string): Promise<IcuConnectionRecord | null> };
  /** Daily context reads; `planned` also gives the sessions the coach may change */
  context: DailyContextDeps;
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
  /** Wrapped in `withCallLog` */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  guardrailConfig?: GuardrailConfig;
  /** `AI_CONTEXT_TOKEN_BUDGET` */
  tokenBudget?: number;
  sendMessage(chatId: number, text: string, options: TelegramMessageOptions): Promise<unknown>;
  logger: BriefLogger;
  now(): Date;
}

export type DailyBriefResult =
  | { status: 'skipped'; reason: 'no_profile' | 'already_sent' }
  | {
      status: 'sent';
      date: string;
      /** A retry that only resent the brief stored by an earlier attempt */
      resumed: boolean;
      stale: boolean;
      source: CoachDecisionSource | null;
      timings: StageTimings;
    };

/** Another attempt holds today's run; thrown so the job retries after the lease. */
export class BriefInProgressError extends Error {
  constructor(userId: string, date: string) {
    super('Daily brief already running for ' + userId + ' on ' + date);
    this.name = 'BriefInProgressError';
  }
}

interface RunCtx {
  userId: string;
  date: string;
  deps: DailyBriefDeps;
  timings: StageTimings;
}

/** Runs one stage, recording and logging how long it took and whether it failed. */
async function stage<T>(ctx: RunCtx, name: BriefStage, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let outcome = 'ok';
  try {
    return await fn();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const ms = Math.round(performance.now() - start);
    ctx.timings[name] = ms;
    ctx.deps.logger.info(
      { userId: ctx.userId, date: ctx.date, stage: name, ms, outcome },
      'daily brief stage'
    );
  }
}

/** A sync stage: on failure the pipeline goes on with the data it has. */
async function syncStage(
  ctx: RunCtx,
  name: 'wellness' | 'activity',
  sync: (userId: string) => Promise<unknown>
): Promise<boolean> {
  try {
    await stage(ctx, name, () => sync(ctx.userId));
    return true;
  } catch (error) {
    ctx.deps.logger.warn(
      { userId: ctx.userId, date: ctx.date, stage: name, error },
      'daily brief: sync failed, continuing with stale data'
    );
    return false;
  }
}

/**
 * When the data of the failed syncs was last fresh: the oldest of their cursors, or null when
 * one never synced.
 */
async function dataAsOf(
  ctx: RunCtx,
  failed: { wellness: boolean; activity: boolean }
): Promise<Date | null> {
  const connection = await ctx.deps.connections.findByUserId(ctx.userId);
  const cursors = [
    ...(failed.wellness ? [connection?.lastWellnessSyncAt ?? null] : []),
    ...(failed.activity ? [connection?.lastActivitySyncAt ?? null] : []),
  ];
  if (cursors.includes(null)) return null;
  const times = cursors.map((c) => (c as Date).getTime());
  return new Date(Math.min(...times));
}

interface Inputs {
  daily: DailyContextResult | null;
  planned: PlannedSessionSummary[];
  rules: RulesContext;
}

/** The daily context, plan window and rules input; a failed context build leaves `daily` null. */
function loadInputs(ctx: RunCtx): Promise<Inputs> {
  const { deps, userId, date } = ctx;
  const window = coachPlanWindow(date);
  const daily = buildDailyContext(deps.context, userId, date, {
    tokenBudget: deps.tokenBudget,
  }).catch((error: unknown) => {
    deps.logger.warn({ userId, date, error }, 'daily brief: context build failed, rules only');
    return null;
  });
  return Promise.all([
    daily,
    deps.context.planned.listRange(userId, window.from, window.to),
    deps.getRulesContext(userId, date),
  ]).then(([d, planned, rules]) => ({ daily: d, planned, rules }));
}

/** LLM suggestion + guardrails (rules engine alone without a context); one CoachDecision. */
async function decide(
  ctx: RunCtx,
  inputs: Inputs
): Promise<{ record: CoachDecisionRecord; id: string }> {
  const { deps } = ctx;
  const written: { id?: string } = {};
  const sink: CoachDecisionSink = {
    async write(record) {
      written.id = await deps.decisions.write(record);
      return written.id;
    },
  };
  const aiDeps = {
    provider: deps.provider,
    decisions: sink,
    guardrailConfig: deps.guardrailConfig,
  };
  const input = {
    userId: ctx.userId,
    date: ctx.date,
    promptVersion: inputs.daily?.promptVersion ?? DAILY_PROMPT_VERSION,
    sessions: inputs.planned.map(toCoachPlanSession),
    context: inputs.rules,
  };
  const record = inputs.daily
    ? await runCoachSuggestion(aiDeps, { ...input, dailyPrompt: inputs.daily.prompt })
    : await runRulesFallback(aiDeps, input, 'internal_error');
  if (written.id === undefined) throw new Error('CoachDecision was not written');
  return { record, id: written.id };
}

/** Stages wellness → activity → context → suggest; stores the rendered brief on the run. */
async function prepareBrief(
  ctx: RunCtx,
  run: DailyBriefRun,
  timezone: string
): Promise<{ brief: RichReply; source: CoachDecisionSource; stale: boolean }> {
  const { deps } = ctx;
  const wellnessOk = await syncStage(ctx, 'wellness', (id) => deps.syncWellness(id));
  const activityOk = await syncStage(ctx, 'activity', (id) => deps.syncActivities(id));
  const stale = !wellnessOk || !activityOk;
  const asOf = stale ? await dataAsOf(ctx, { wellness: !wellnessOk, activity: !activityOk }) : null;

  const inputs = await stage(ctx, 'context', () => loadInputs(ctx));
  const { record, id } = await stage(ctx, 'suggest', () => decide(ctx, inputs));

  const brief = renderBrief({
    date: ctx.date,
    timezone,
    decision: record,
    decisionId: id,
    todaySessions: inputs.planned.filter((s) => s.date === ctx.date),
    stale,
    dataAsOf: asOf,
  });
  await deps.runs.saveBrief(run.id, {
    coachDecisionId: id,
    briefText: brief.text,
    briefKeyboard: brief.keyboard ?? null,
    stale,
    dataAsOf: asOf,
    stageTimings: ctx.timings,
  });
  return { brief, source: record.source, stale };
}

function storedBrief(run: DailyBriefRun): RichReply {
  const brief: RichReply = { text: run.briefText ?? '', html: true };
  if (run.briefKeyboard) brief.keyboard = run.briefKeyboard;
  return brief;
}

/** Telegram won't ever take this message: the bot is blocked or the chat is gone. */
function isPermanentSendError(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.name + ': ' + error.message : String(error);
}

async function sendBrief(ctx: RunCtx, chatId: number, brief: RichReply): Promise<void> {
  const message = toTelegramMessage(brief);
  try {
    await stage(ctx, 'send', () => ctx.deps.sendMessage(chatId, message.text, message.options));
  } catch (error) {
    if (isPermanentSendError(error)) throw new UnrecoverableError(errorText(error));
    throw error;
  }
}

async function runClaimed(
  ctx: RunCtx,
  run: DailyBriefRun,
  chatId: number,
  timezone: string
): Promise<DailyBriefResult> {
  const resumed = run.briefText !== null;
  const prepared = resumed ? null : await prepareBrief(ctx, run, timezone);
  await sendBrief(ctx, chatId, prepared?.brief ?? storedBrief(run));
  await ctx.deps.runs.markSent(run.id, ctx.deps.now(), { ...run.stageTimings, ...ctx.timings });
  return {
    status: 'sent',
    date: ctx.date,
    resumed,
    stale: prepared?.stale ?? run.stale,
    source: prepared?.source ?? null,
    timings: ctx.timings,
  };
}

/**
 * The morning pipeline of one athlete: wellness sync → activity sync → daily context →
 * coach suggestion (LLM + guardrails) → brief. Runs at most once per athlete and local day:
 * the `DailyBriefRun` row (userId, date) is claimed first, and a sent run is never redone.
 *
 * Degradation: a failed ICU sync leaves a stale-data note; an LLM failure (or a failed context
 * build) gives the rules-engine recommendation with `CoachDecision.source = 'fallback'`. A
 * failed send marks the run failed and rethrows, so the job retries; the retry resends the
 * stored brief without syncing or asking the coach again.
 */
export async function runDailyBrief(
  userId: string,
  deps: DailyBriefDeps
): Promise<DailyBriefResult> {
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  const now = deps.now();
  const date = localToday(now, profile.timezone);
  const claim = await deps.runs.claim(userId, date, now, BRIEF_LEASE_MS);
  if (claim.status === 'already_sent') return { status: 'skipped', reason: 'already_sent' };
  if (claim.status === 'in_progress') throw new BriefInProgressError(userId, date);

  const ctx: RunCtx = { userId, date, deps, timings: {} };
  try {
    const result = await runClaimed(ctx, claim.run, profile.telegramChatId, profile.timezone);
    deps.logger.info({ userId, date, ...result }, 'daily brief finished');
    return result;
  } catch (error) {
    const timings = { ...claim.run.stageTimings, ...ctx.timings };
    // Best effort: the job retries either way, and the run's lease expires on its own
    await deps.runs.markFailed(claim.run.id, errorText(error), timings).catch((e: unknown) => {
      deps.logger.warn({ userId, date, error: e }, 'daily brief: could not mark the run failed');
    });
    deps.logger.info(
      { userId, date, status: 'failed', timings: ctx.timings },
      'daily brief finished'
    );
    throw error;
  }
}
