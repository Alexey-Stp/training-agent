import {
  closeoutNotices,
  deviationPct,
  guessIntensity,
  localToday,
  matchActivities,
  type CloseoutActivity,
  type CloseoutNotice,
  type MatchResult,
} from '@triathlon/core';
import { toTelegramMessage, type TelegramMessageOptions } from '../reply';
import type {
  CloseoutDay,
  CloseoutDaySession,
  CloseoutRepo,
  CloseoutWrite,
  EveningCloseoutRun,
  EveningCloseoutRunRepo,
} from './closeout-store';
import { renderCloseout } from './closeout-render';
import { errorText, sendOrFail, timedStage, type RunLogger } from './run-helpers';
import type { StageTimings } from './run-store';
import type { BriefProfileRepo } from './scheduler';

/** How long a running close-out holds the day's run before a retry may take it over */
export const CLOSEOUT_LEASE_MS = 5 * 60_000;

export type CloseoutStage = 'activity' | 'match' | 'send';

export interface EveningCloseoutDeps {
  runs: EveningCloseoutRunRepo;
  profiles: BriefProfileRepo;
  closeout: CloseoutRepo;
  /** activity-sync `syncActivities`; throws when ICU is down */
  syncActivities(userId: string): Promise<unknown>;
  sendMessage(
    chatId: number,
    text: string,
    options: TelegramMessageOptions
  ): Promise<{ message_id: number }>;
  /** CLOSEOUT_DEVIATION_THRESHOLD_PCT */
  deviationThresholdPct: number;
  logger: RunLogger;
  now(): Date;
}

export interface CloseoutSummary {
  completed: number;
  skipped: number;
  unplanned: number;
  notices: number;
}

export type EveningCloseoutResult =
  | { status: 'skipped'; reason: 'no_profile' | 'already_done' }
  | { status: 'quiet'; date: string; summary: CloseoutSummary; timings: StageTimings }
  | {
      status: 'sent';
      date: string;
      /** A retry that only resent the message stored by an earlier attempt */
      resumed: boolean;
      /** null when resumed: the matching ran in the earlier attempt */
      summary: CloseoutSummary | null;
      timings: StageTimings;
    };

/** Another attempt holds today's run; thrown so the job retries after the lease. */
export class CloseoutInProgressError extends Error {
  constructor(userId: string, date: string) {
    super('Evening close-out already running for ' + userId + ' on ' + date);
    this.name = 'CloseoutInProgressError';
  }
}

interface RunCtx {
  userId: string;
  date: string;
  deps: EveningCloseoutDeps;
  timings: StageTimings;
}

function stage<T>(ctx: RunCtx, name: CloseoutStage, fn: () => Promise<T>): Promise<T> {
  return timedStage({ ...ctx, logger: ctx.deps.logger }, 'evening close-out stage', name, fn);
}

export interface ClosedDay {
  write: CloseoutWrite;
  notices: CloseoutNotice[];
  summary: CloseoutSummary;
}

/**
 * Matches the day and decides what to write and tell. A session the athlete changed in
 * intervals.icu (`modified_externally`) that no activity matched keeps its status: their
 * version wins, so it is neither marked skipped nor reported as missed.
 */
export function closeDay(day: CloseoutDay, deviationThresholdPct: number, now: Date): ClosedDay {
  const matched: MatchResult<CloseoutDaySession, CloseoutActivity> = matchActivities(
    day.sessions,
    day.activities
  );
  const result = {
    ...matched,
    skipped: matched.skipped.filter((s) => s.status !== 'modified_externally'),
  };
  const completed = result.matches.map(({ session, activity }) => ({
    sessionId: session.id,
    status: 'completed' as const,
    deviationPct: deviationPct(session.durationMin, activity.durationSec),
    actualIntensity: guessIntensity(activity, day.thresholds),
  }));
  const skipped = result.skipped.map((session) => ({
    sessionId: session.id,
    status: 'skipped' as const,
    deviationPct: null,
    actualIntensity: null,
  }));
  const linked = new Map(result.matches.map((m) => [m.activity.id, m.session.id]));
  const notices = closeoutNotices(result, { deviationThresholdPct });

  return {
    write: {
      sessions: [...completed, ...skipped],
      links: day.activities.map((a) => ({ activityId: a.id, sessionId: linked.get(a.id) ?? null })),
      closedOutAt: now,
    },
    notices,
    summary: {
      completed: completed.length,
      skipped: skipped.length,
      unplanned: result.unmatched.length,
      notices: notices.length,
    },
  };
}

async function sendText(ctx: RunCtx, chatId: number, text: string): Promise<void> {
  const message = toTelegramMessage({ text, html: true });
  await stage(ctx, 'send', () =>
    sendOrFail(() => ctx.deps.sendMessage(chatId, message.text, message.options))
  );
}

async function runClaimed(
  ctx: RunCtx,
  run: EveningCloseoutRun,
  chatId: number
): Promise<EveningCloseoutResult> {
  const { deps, userId, date } = ctx;
  const allTimings = () => ({ ...run.stageTimings, ...ctx.timings });

  if (run.messageText !== null) {
    await sendText(ctx, chatId, run.messageText);
    await deps.runs.markSent(run.id, deps.now(), allTimings());
    return { status: 'sent', date, resumed: true, summary: null, timings: ctx.timings };
  }

  // A failed sync fails the run: marking sessions skipped on stale data would be wrong
  await stage(ctx, 'activity', () => deps.syncActivities(userId));
  const closed = await stage(ctx, 'match', async () => {
    const day = await deps.closeout.listDay(userId, date);
    const result = closeDay(day, deps.deviationThresholdPct, deps.now());
    await deps.closeout.apply(userId, date, result.write);
    return result;
  });

  if (closed.notices.length === 0) {
    await deps.runs.markQuiet(run.id, allTimings());
    return { status: 'quiet', date, summary: closed.summary, timings: ctx.timings };
  }

  const text = renderCloseout(closed.notices);
  await deps.runs.saveMessage(run.id, text, allTimings());
  await sendText(ctx, chatId, text);
  await deps.runs.markSent(run.id, deps.now(), allTimings());
  return { status: 'sent', date, resumed: false, summary: closed.summary, timings: ctx.timings };
}

/**
 * The evening close-out of one athlete: final activity sync → match today's activities to
 * today's planned sessions (completed/skipped, deviation, intensity guess, unplanned flags) →
 * a short message only when something is notable (missed key session, duration off by more
 * than the threshold, unplanned workout). Quiet by default.
 *
 * Runs at most once per athlete and local day: the `EveningCloseoutRun` row (userId, date)
 * is claimed first, and a quiet or sent run is never redone. The message is stored before
 * the send, so a retry after a failed send resends it without matching again.
 */
export async function runEveningCloseout(
  userId: string,
  deps: EveningCloseoutDeps
): Promise<EveningCloseoutResult> {
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  const now = deps.now();
  const date = localToday(now, profile.timezone);
  const claim = await deps.runs.claim(userId, date, now, CLOSEOUT_LEASE_MS);
  if (claim.status === 'already_done') return { status: 'skipped', reason: 'already_done' };
  if (claim.status === 'in_progress') throw new CloseoutInProgressError(userId, date);

  const ctx: RunCtx = { userId, date, deps, timings: {} };
  try {
    const result = await runClaimed(ctx, claim.run, profile.telegramChatId);
    deps.logger.info({ userId, date, ...result }, 'evening close-out finished');
    return result;
  } catch (error) {
    const timings = { ...claim.run.stageTimings, ...ctx.timings };
    // Best effort: the job retries either way, and the run's lease expires on its own
    await deps.runs.markFailed(claim.run.id, errorText(error), timings).catch((e: unknown) => {
      deps.logger.warn({ userId, date, error: e }, 'evening close-out: could not mark failed');
    });
    deps.logger.info(
      { userId, date, status: 'failed', timings: ctx.timings },
      'evening close-out finished'
    );
    throw error;
  }
}
