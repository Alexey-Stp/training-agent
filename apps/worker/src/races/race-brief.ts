import {
  addDaysIso,
  buildPacingPlan,
  localToday,
  RACE_BRIEF_DAYS,
  raceBriefKind,
  type PacingPlan,
  type RaceBriefKind,
  type RunEffort,
} from '@triathlon/core';
import { runRaceBrief, type LlmProvider } from '@triathlon/ai';
import { errorText, sendOrFail, timedStage, type RunLogger } from '../daily-loop/run-helpers';
import type { StageTimings } from '../daily-loop/run-store';
import type { BriefProfileRepo } from '../daily-loop/scheduler';
import type { PlannedSessionRecord } from '../plan-store';
import type { RaceRecord, RaceRepo } from '../race-command';
import { toTelegramMessage, type TelegramMessageOptions } from '../reply';
import {
  renderRaceBrief,
  eveSections,
  sectionsToPlainText,
  weekOutSections,
  type BriefSection,
} from './race-brief-render';
import type { RaceBriefRun, RaceBriefRunRepo } from './race-brief-store';

/** How long a running brief holds its run before a retry may take it over */
export const RACE_BRIEF_LEASE_MS = 5 * 60_000;

/** Days back whose runs feed the run pace estimate (a little more than the core window) */
const RUN_EFFORT_LOOKBACK_DAYS = 100;
/** The week overview covers today..today+6 */
const WEEK_OVERVIEW_DAYS = 6;

export interface RaceBriefDeps {
  runs: RaceBriefRunRepo;
  profiles: BriefProfileRepo;
  races: Pick<RaceRepo, 'findByDate'>;
  planned: {
    listWindow(userId: string, from: string, to: string): Promise<PlannedSessionRecord[]>;
  };
  getFtp(userId: string): Promise<number | null>;
  runEfforts: { listRunEfforts(userId: string, from: string, to: string): Promise<RunEffort[]> };
  /** activity-sync `syncActivities`; throws when ICU is down */
  syncActivities(userId: string): Promise<unknown>;
  /** Wrapped in `withCallLog` */
  provider: LlmProvider;
  sendMessage(
    chatId: number,
    text: string,
    options: TelegramMessageOptions
  ): Promise<{ message_id: number }>;
  logger: RunLogger;
  now(): Date;
}

export type RaceBriefOutcome =
  | { raceId: string; kind: RaceBriefKind; status: 'skipped'; reason: 'already_sent' }
  | { raceId: string; kind: RaceBriefKind; status: 'sent'; resumed: boolean; stale: boolean };

export type RaceBriefResult =
  | { status: 'skipped'; reason: 'no_profile' }
  | { status: 'done'; date: string; briefs: RaceBriefOutcome[] };

/** Another attempt holds the brief's run; thrown so the job retries after the lease. */
export class RaceBriefInProgressError extends Error {
  constructor(userId: string, raceId: string, kind: RaceBriefKind) {
    super('Race brief already running for ' + userId + ', race ' + raceId + ', ' + kind);
    this.name = 'RaceBriefInProgressError';
  }
}

interface RaceCtx {
  userId: string;
  chatId: number;
  date: string;
  race: RaceRecord;
  kind: RaceBriefKind;
  deps: RaceBriefDeps;
  timings: StageTimings;
}

function stage<T>(ctx: RaceCtx, name: string, fn: () => Promise<T>): Promise<T> {
  return timedStage({ ...ctx, logger: ctx.deps.logger }, 'race brief stage', name, fn);
}

async function sendText(ctx: RaceCtx, text: string): Promise<void> {
  const message = toTelegramMessage({ text, html: true });
  await stage(ctx, 'send', () =>
    sendOrFail(() => ctx.deps.sendMessage(ctx.chatId, message.text, message.options))
  );
}

/** A failed sync only makes the pacing stale: the run efforts already stored are used. */
async function syncOrStale(ctx: RaceCtx): Promise<boolean> {
  try {
    await stage(ctx, 'activity', () => ctx.deps.syncActivities(ctx.userId));
    return false;
  } catch (error) {
    ctx.deps.logger.warn(
      { userId: ctx.userId, raceId: ctx.race.id, kind: ctx.kind, error: errorText(error) },
      'race brief: activity sync failed, brief is stale'
    );
    return true;
  }
}

async function loadPacing(ctx: RaceCtx): Promise<PacingPlan> {
  const { deps, userId, date } = ctx;
  const [ftp, runEfforts] = await Promise.all([
    deps.getFtp(userId),
    deps.runEfforts.listRunEfforts(userId, addDaysIso(date, -RUN_EFFORT_LOOKBACK_DAYS), date),
  ]);
  return buildPacingPlan({ raceType: ctx.race.type, ftp: ftp ?? 0, runEfforts, today: date });
}

async function buildSections(ctx: RaceCtx): Promise<{ sections: BriefSection[]; stale: boolean }> {
  const { deps, userId, date } = ctx;
  if (ctx.kind === 't7') {
    // The pacing numbers are for race eve: the week out needs the plan and the checklist
    const end = addDaysIso(date, WEEK_OVERVIEW_DAYS);
    const sessions = await deps.planned.listWindow(userId, date, end);
    return { sections: weekOutSections(ctx.race, sessions), stale: false };
  }
  const stale = await syncOrStale(ctx);
  return { sections: eveSections(ctx.race, await loadPacing(ctx)), stale };
}

async function compose(ctx: RaceCtx): Promise<{ text: string; stale: boolean }> {
  const { sections, stale } = await buildSections(ctx);
  const tone = await stage(ctx, 'tone', () =>
    runRaceBrief(
      { provider: ctx.deps.provider },
      {
        userId: ctx.userId,
        kind: ctx.kind,
        raceName: ctx.race.name,
        raceType: ctx.race.type,
        priority: ctx.race.priority,
        facts: sectionsToPlainText(sections),
        recentTrainingNote: '',
      }
    )
  );
  if (tone.fallbackReason) {
    ctx.deps.logger.warn(
      { userId: ctx.userId, raceId: ctx.race.id, reason: tone.fallbackReason, error: tone.error },
      'race brief: using the fixed tone text'
    );
  }
  const text = renderRaceBrief({
    kind: ctx.kind,
    race: ctx.race,
    text: tone.text,
    sections,
    stale,
  });
  return { text, stale };
}

async function runClaimed(ctx: RaceCtx, run: RaceBriefRun): Promise<RaceBriefOutcome> {
  const { deps, race, kind } = ctx;
  const allTimings = () => ({ ...run.stageTimings, ...ctx.timings });
  if (run.briefText !== null) {
    // A retry after a failed send: the stored brief, no new LLM call
    await sendText(ctx, run.briefText);
    await deps.runs.markSent(run.id, deps.now(), allTimings());
    return { raceId: race.id, kind, status: 'sent', resumed: true, stale: false };
  }
  const { text, stale } = await compose(ctx);
  await deps.runs.saveBrief(run.id, text, stale, allTimings());
  await sendText(ctx, text);
  await deps.runs.markSent(run.id, deps.now(), allTimings());
  return { raceId: race.id, kind, status: 'sent', resumed: false, stale };
}

async function briefRace(ctx: RaceCtx): Promise<RaceBriefOutcome> {
  const { deps, userId, race, kind } = ctx;
  const key = { userId, raceId: race.id, kind, raceDate: race.date };
  const claim = await deps.runs.claim(key, deps.now(), RACE_BRIEF_LEASE_MS);
  if (claim.status === 'already_sent') {
    return { raceId: race.id, kind, status: 'skipped', reason: 'already_sent' };
  }
  if (claim.status === 'in_progress') throw new RaceBriefInProgressError(userId, race.id, kind);
  try {
    return await runClaimed(ctx, claim.run);
  } catch (error) {
    const timings = { ...claim.run.stageTimings, ...ctx.timings };
    // Best effort: the job retries either way, and the run's lease expires on its own
    await deps.runs.markFailed(claim.run.id, errorText(error), timings).catch((e: unknown) => {
      deps.logger.warn({ userId, raceId: race.id, error: e }, 'race brief: could not mark failed');
    });
    throw error;
  }
}

interface DueBrief {
  race: RaceRecord;
  kind: RaceBriefKind;
}

/** The races whose T-7 (A only) or T-1 falls on `date`. */
async function dueBriefs(deps: RaceBriefDeps, userId: string, date: string): Promise<DueBrief[]> {
  const found = await Promise.all(
    Object.values(RACE_BRIEF_DAYS).map((days) =>
      deps.races.findByDate(userId, addDaysIso(date, days))
    )
  );
  return found.flat().flatMap((race) => {
    const kind = raceBriefKind(race, date);
    return kind ? [{ race, kind }] : [];
  });
}

/**
 * The daily race brief check of one athlete, at the local RACE_BRIEF_TIME: A-races get the T-7
 * overview + checklist and the T-1 pacing brief, B/C races only T-1. Nothing happens on days
 * without a due race.
 *
 * Numbers (bike watts, run pace, carbs) come from core and are rendered outside the LLM text,
 * which only sets the tone. Each (race, kind, race date) is sent once: the `RaceBriefRun` row is
 * claimed first and the brief is stored before the send, so a retry resends it as is.
 */
export async function runRaceBriefJob(
  userId: string,
  deps: RaceBriefDeps
): Promise<RaceBriefResult> {
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  const date = localToday(deps.now(), profile.timezone);
  const due = await dueBriefs(deps, userId, date);
  // At most one brief per due race: they are independent, each has its own run row, and a retry
  // skips the ones already sent
  const briefs: RaceBriefOutcome[] = await Promise.all(
    due.map(({ race, kind }) =>
      briefRace({
        userId,
        chatId: profile.telegramChatId,
        date,
        race,
        kind,
        deps,
        timings: {},
      })
    )
  );
  deps.logger.info({ userId, date, briefs }, 'race brief finished');
  return { status: 'done', date, briefs };
}
