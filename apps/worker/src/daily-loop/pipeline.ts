import { performance } from 'node:perf_hooks';
import { UnrecoverableError } from 'bullmq';
import { GrammyError } from 'grammy';
import { addDaysIso, localToday, type RulesContext } from '@triathlon/core';
import {
  buildDailyContext,
  DAILY_PROMPT_VERSION,
  HRV_BASELINE_DAYS,
  hrvBaseline,
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
import { checkInReason, renderCheckIn, type CheckInReason } from './checkin';
import { readinessVerdict } from './readiness';
import { renderBrief } from './render';
import type { DailyBriefRun, DailyBriefRunRepo, StageTimings } from './run-store';
import type { BriefProfileRepo } from './scheduler';

/** How long a running pipeline holds the day's run before a retry may take it over */
export const BRIEF_LEASE_MS = 5 * 60_000;

export type BriefStage = 'wellness' | 'activity' | 'checkin' | 'context' | 'suggest' | 'send';

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
  sendMessage(
    chatId: number,
    text: string,
    options: TelegramMessageOptions
  ): Promise<{ message_id: number }>;
  /**
   * Queues the continuation that finishes the brief after the check-in timeout. Idempotent per
   * (userId, date); an answered check-in promotes it early.
   */
  scheduleCheckInTimeout(userId: string, date: string): Promise<void>;
  logger: BriefLogger;
  now(): Date;
}

export type DailyBriefResult =
  | { status: 'skipped'; reason: 'no_profile' | 'already_sent' | 'awaiting_checkin' }
  /** The check-in went out; the continuation job sends the brief */
  | { status: 'awaiting_checkin'; date: string; reason: CheckInReason }
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

interface Freshness {
  /** An ICU sync failed: data as of `dataAsOf` (null: never synced) */
  stale: boolean;
  dataAsOf: Date | null;
}

/** Stages wellness → activity; a failed sync only makes the data stale. */
async function syncAll(ctx: RunCtx): Promise<Freshness> {
  const { deps } = ctx;
  const wellnessOk = await syncStage(ctx, 'wellness', (id) => deps.syncWellness(id));
  const activityOk = await syncStage(ctx, 'activity', (id) => deps.syncActivities(id));
  const stale = !wellnessOk || !activityOk;
  const asOf = stale ? await dataAsOf(ctx, { wellness: !wellnessOk, activity: !activityOk }) : null;
  return { stale, dataAsOf: asOf };
}

/** Telegram won't ever take this message: the bot is blocked or the chat is gone. */
function isPermanentSendError(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.name + ': ' + error.message : String(error);
}

/** A send Telegram will never accept fails the job without retries. */
async function sendOrFail<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (isPermanentSendError(error)) throw new UnrecoverableError(errorText(error));
    throw error;
  }
}

/**
 * Sends the check-in when today's data calls for it and records it on the run; null when the
 * brief can go out straight away. The timeout is queued before the send, so a check-in never
 * goes out without a continuation behind it.
 */
async function askCheckIn(
  ctx: RunCtx,
  run: DailyBriefRun,
  chatId: number,
  freshness: Freshness
): Promise<CheckInReason | null> {
  const { deps, userId, date } = ctx;
  const from = addDaysIso(date, -HRV_BASELINE_DAYS);
  const rows = await deps.context.wellness.listRange(userId, from, date);
  const today = rows.find((row) => row.date === date) ?? null;
  const reason = checkInReason(today, hrvBaseline(rows, date));
  if (reason === null) return null;

  await deps.scheduleCheckInTimeout(userId, date);
  const message = toTelegramMessage(
    renderCheckIn({
      subjectiveReadiness: today?.subjectiveReadiness ?? null,
      soreness: today?.soreness ?? null,
    })
  );
  const sent = await sendOrFail(() => deps.sendMessage(chatId, message.text, message.options));
  await deps.runs.saveCheckIn(run.id, {
    messageId: sent.message_id,
    sentAt: deps.now(),
    ...freshness,
    stageTimings: { ...run.stageTimings, ...ctx.timings },
  });
  return reason;
}

/** The check-in went out and the athlete answered neither question. */
async function checkInMissed(ctx: RunCtx, run: DailyBriefRun): Promise<boolean> {
  if (run.checkInSentAt === null) return false;
  const rows = await ctx.deps.context.wellness.listRange(ctx.userId, ctx.date, ctx.date);
  const today = rows.find((row) => row.date === ctx.date);
  return (today?.subjectiveReadiness ?? null) === null && (today?.soreness ?? null) === null;
}

interface Inputs {
  daily: DailyContextResult | null;
  planned: PlannedSessionSummary[];
  rules: RulesContext;
  checkInMissed: boolean;
}

/** The daily context, plan window and rules input; a failed context build leaves `daily` null. */
function loadInputs(ctx: RunCtx, run: DailyBriefRun): Promise<Inputs> {
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
    checkInMissed(ctx, run),
  ]).then(([d, planned, rules, missed]) => ({
    daily: d,
    planned,
    rules,
    checkInMissed: missed,
  }));
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

interface PreparedBrief {
  brief: RichReply;
  source: CoachDecisionSource;
  stale: boolean;
}

/** Stages context → suggest; stores the rendered brief on the run. */
async function prepareBrief(
  ctx: RunCtx,
  run: DailyBriefRun,
  timezone: string,
  freshness: Freshness
): Promise<PreparedBrief> {
  const { deps } = ctx;
  const inputs = await stage(ctx, 'context', () => loadInputs(ctx, run));
  const { record, id } = await stage(ctx, 'suggest', () => decide(ctx, inputs));

  const brief = renderBrief({
    date: ctx.date,
    timezone,
    decision: record,
    decisionId: id,
    planned: inputs.planned,
    readiness: readinessVerdict(
      inputs.rules.todayWellness,
      inputs.daily?.context.wellness.hrv ?? null
    ),
    stale: freshness.stale,
    dataAsOf: freshness.dataAsOf,
    checkInMissed: inputs.checkInMissed,
  });
  await deps.runs.saveBrief(run.id, {
    coachDecisionId: id,
    briefText: brief.text,
    briefKeyboard: brief.keyboard ?? null,
    stale: freshness.stale,
    dataAsOf: freshness.dataAsOf,
    stageTimings: ctx.timings,
  });
  return { brief, source: record.source, stale: freshness.stale };
}

type FreshOutcome =
  { kind: 'checkin'; reason: CheckInReason } | { kind: 'brief'; prepared: PreparedBrief };

/**
 * A new run syncs and may stop at the check-in. A run whose check-in is out reuses the
 * freshness of that sync and only finishes the brief.
 */
async function prepareFresh(
  ctx: RunCtx,
  run: DailyBriefRun,
  chatId: number,
  timezone: string
): Promise<FreshOutcome> {
  if (run.checkInSentAt !== null) {
    const freshness = { stale: run.stale, dataAsOf: run.dataAsOf };
    return { kind: 'brief', prepared: await prepareBrief(ctx, run, timezone, freshness) };
  }
  const freshness = await syncAll(ctx);
  const reason = await stage(ctx, 'checkin', () => askCheckIn(ctx, run, chatId, freshness));
  if (reason !== null) return { kind: 'checkin', reason };
  return { kind: 'brief', prepared: await prepareBrief(ctx, run, timezone, freshness) };
}

function storedBrief(run: DailyBriefRun): RichReply {
  const brief: RichReply = { text: run.briefText ?? '', html: true };
  if (run.briefKeyboard) brief.keyboard = run.briefKeyboard;
  return brief;
}

async function sendBrief(ctx: RunCtx, chatId: number, brief: RichReply): Promise<void> {
  const message = toTelegramMessage(brief);
  await stage(ctx, 'send', () =>
    sendOrFail(() => ctx.deps.sendMessage(chatId, message.text, message.options))
  );
}

async function runClaimed(
  ctx: RunCtx,
  run: DailyBriefRun,
  chatId: number,
  timezone: string
): Promise<DailyBriefResult> {
  const resumed = run.briefText !== null;
  let prepared: PreparedBrief | null = null;
  if (!resumed) {
    const outcome = await prepareFresh(ctx, run, chatId, timezone);
    if (outcome.kind === 'checkin') {
      return { status: 'awaiting_checkin', date: ctx.date, reason: outcome.reason };
    }
    prepared = outcome.prepared;
  }
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

export interface DailyBriefOptions {
  /** Set by the check-in continuation job: the local date its check-in was asked for */
  checkInDate?: string;
}

/**
 * The morning pipeline of one athlete: wellness sync → activity sync → check-in (only when
 * today's device wellness is missing or HRV is off its baseline) → daily context → coach
 * suggestion (LLM + guardrails) → brief. Runs at most once per athlete and local day: the
 * `DailyBriefRun` row (userId, date) is claimed first, and a sent run is never redone.
 *
 * Check-in: the run stops after sending it (`awaiting_checkin`). A delayed continuation job
 * (`options.checkInDate`), promoted as soon as both answers are in, finishes the brief with
 * the freshness of the first run's sync; until then other triggers of that day are skipped.
 *
 * Degradation: a failed ICU sync leaves a stale-data note; an LLM failure (or a failed context
 * build) gives the rules-engine recommendation with `CoachDecision.source = 'fallback'`. A
 * failed send marks the run failed and rethrows, so the job retries; the retry resends the
 * stored brief without syncing or asking the coach again.
 */
export async function runDailyBrief(
  userId: string,
  deps: DailyBriefDeps,
  options: DailyBriefOptions = {}
): Promise<DailyBriefResult> {
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  const now = deps.now();
  const continuation = options.checkInDate !== undefined;
  const date = options.checkInDate ?? localToday(now, profile.timezone);
  const claim = await deps.runs.claim(userId, date, now, BRIEF_LEASE_MS, { continuation });
  if (claim.status === 'already_sent') return { status: 'skipped', reason: 'already_sent' };
  if (claim.status === 'awaiting_checkin') return { status: 'skipped', reason: 'awaiting_checkin' };
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
