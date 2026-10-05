import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkoutSteps,
  computeWeeklyStats,
  Intensity,
  parseCoachDecision,
  Sport,
  type PlannedSessionDraft,
  type RulesContext,
  type WeeklyActivityInput,
  type WeeklyPlannedInput,
  type WeeklyStats,
} from '@triathlon/core';
import {
  MockProvider,
  NOTE_REJECTED,
  type CoachDecisionRecord,
  type CoachDecisionSink,
  type SessionDiff,
  type WeeklyReview,
} from '@triathlon/ai';
import { IcuServerError } from '@triathlon/integrations-icu';
import { GrammyError } from 'grammy';
import type { StageTimings } from '../src/daily-loop/run-store';
import type { BriefProfile } from '../src/daily-loop/scheduler';
import {
  runWeeklyReviewJob,
  WeeklyReviewInProgressError,
  WEEKLY_REVIEW_LEASE_MS,
  type WeeklyReviewDeps,
} from '../src/reviews/weekly-review';
import {
  renderWeeklyReport,
  STALE_NOTE,
  WEEKLY_REPORT_MAX_LINES,
} from '../src/reviews/weekly-review-render';
import type {
  SavedReport,
  WeeklyReviewClaimResult,
  WeeklyReviewRun,
  WeeklyReviewRunRepo,
} from '../src/reviews/weekly-review-store';
import type { WeeklyStatsData, WeeklyStatsRepo } from '../src/reviews/weekly-stats-store';
import { MemoryPlanRepo, USER_ID } from './planned-session-fakes';

// Sunday 2026-10-04 19:00 in Prague: the review of ISO week 2026-W40 (Sep 28 - Oct 4)
const NOW = new Date('2026-10-04T17:00:00Z');
const CHAT_ID = 1001;
const PRAGUE: BriefProfile = {
  telegramChatId: CHAT_ID,
  timezone: 'Europe/Prague',
  briefTime: null,
  closeoutTime: null,
};
/** The reviewed week was big enough that the 110% weekly load cap stays out of the way */
const CONTEXT: RulesContext = { last7dStats: { totalMinutes: 1000, byDate: [] } };

type Planned = [date: string, sport: Sport, min: number, intensity: Intensity, title: string];

/** 2026-W40, 600 min; Saturday's 180-min ride is the long one */
const THIS_WEEK: Planned[] = [
  ['2026-09-28', Sport.swim, 60, Intensity.z2, 'Aerobic swim'],
  ['2026-09-29', Sport.bike, 75, Intensity.z4, 'VO2 5x4'],
  ['2026-09-30', Sport.run, 60, Intensity.z2, 'Easy run'],
  ['2026-10-01', Sport.run, 60, Intensity.z4, 'Threshold run'],
  ['2026-10-02', Sport.swim, 60, Intensity.z2, 'Technique swim'],
  ['2026-10-03', Sport.bike, 180, Intensity.z2, 'Long ride'],
  ['2026-10-04', Sport.run, 105, Intensity.z2, 'Long run'],
];
const MISSED_RIDE = '2026-10-03';

function weekData(missed: string | null): WeeklyStatsData {
  const sessions: WeeklyPlannedInput[] = THIS_WEEK.map(
    ([date, sport, durationMin, intensity, title]) => ({
      date,
      slot: sport + '-1',
      sport,
      title,
      durationMin,
      intensity,
      status: date === missed ? 'skipped' : 'completed',
      deleted: false,
    })
  );
  const kmPerHour: Partial<Record<Sport, number>> = { swim: 2.5, bike: 30, run: 10 };
  const activities: WeeklyActivityInput[] = THIS_WEEK.filter(([date]) => date !== missed).map(
    ([date, sport, min]) => ({
      startDateLocal: date,
      sport,
      durationSec: min * 60,
      distanceM: Math.round((min / 60) * (kmPerHour[sport] ?? 0) * 1000),
      load: min,
      avgHr: 135,
    })
  );
  return { sessions, activities, wellness: [], lthr: 165 };
}

function draft(
  date: string,
  sport: Sport,
  durationMin: number,
  intensity: Intensity,
  title: string
): PlannedSessionDraft {
  const base = {
    date,
    slot: sport + '-1',
    sport,
    title,
    description: null,
    durationMin,
    intensity,
  };
  return { ...base, steps: buildWorkoutSteps(base) };
}

/** 2026-W41, 600 min */
const NEXT_WEEK: PlannedSessionDraft[] = [
  draft('2026-10-05', Sport.swim, 60, Intensity.z2, 'Aerobic swim'),
  draft('2026-10-06', Sport.bike, 75, Intensity.z4, 'VO2 5x4'),
  draft('2026-10-07', Sport.run, 60, Intensity.z2, 'Easy run'),
  draft('2026-10-08', Sport.run, 60, Intensity.z4, 'Threshold run'),
  draft('2026-10-10', Sport.bike, 210, Intensity.z2, 'Long ride'),
  draft('2026-10-11', Sport.run, 135, Intensity.z2, 'Long run'),
];
const NEXT_RIDE = '2026-10-10/bike-1';
/** +45 min: 645 of a 648-min cap (8%) */
const PARTIAL_CATCH_UP: SessionDiff = {
  sessionId: NEXT_RIDE,
  field: 'durationMin',
  before: 210,
  after: 255,
};
/** The whole missed ride on top: +180 min */
const FULL_CATCH_UP: SessionDiff = { ...PARTIAL_CATCH_UP, after: 390 };

function review(overrides: Partial<WeeklyReview> = {}): string {
  return JSON.stringify({
    summary: 'Strong run week, but the 180-min long ride was missed: 420 of 600 min.',
    wins: ['All three runs done, 37.5 km'],
    concerns: ['Bike 180 min short of plan'],
    nextWeekChanges: [PARTIAL_CATCH_UP],
    blockAdjustment: null,
    ...overrides,
  } satisfies WeeklyReview);
}

class MemoryRuns implements WeeklyReviewRunRepo {
  readonly rows = new Map<string, WeeklyReviewRun & { startedAt: Date | null; stale: boolean }>();

  claim(
    userId: string,
    isoWeek: string,
    now: Date,
    leaseMs: number
  ): Promise<WeeklyReviewClaimResult> {
    const key = userId + '|' + isoWeek;
    const row = this.rows.get(key) ?? {
      id: 'run-' + isoWeek,
      status: 'pending' as const,
      coachDecisionId: null,
      reportText: null,
      reportKeyboard: null,
      stageTimings: {},
      startedAt: null,
      stale: false,
    };
    this.rows.set(key, row);
    const leaseExpired =
      row.status === 'running' && (row.startedAt?.getTime() ?? 0) < now.getTime() - leaseMs;
    if (row.status === 'pending' || row.status === 'failed' || leaseExpired) {
      Object.assign(row, { status: 'running', startedAt: now });
      return Promise.resolve({ status: 'claimed', run: structuredClone(row) });
    }
    return Promise.resolve({ status: row.status === 'running' ? 'in_progress' : 'already_sent' });
  }

  only() {
    const [row] = [...this.rows.values()];
    return row;
  }

  saveReport(_id: string, report: SavedReport): Promise<void> {
    Object.assign(this.only(), report);
    return Promise.resolve();
  }

  markSent(_id: string, _sentAt: Date, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.only(), { status: 'sent', stageTimings });
    return Promise.resolve();
  }

  markFailed(_id: string, _error: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.only(), { status: 'failed', stageTimings });
    return Promise.resolve();
  }
}

class MemoryStats implements WeeklyStatsRepo {
  data = weekData(MISSED_RIDE);
  readonly saved: WeeklyStats[] = [];

  loadRange(): Promise<WeeklyStatsData> {
    return Promise.resolve(structuredClone(this.data));
  }

  upsert(_userId: string, stats: WeeklyStats): Promise<void> {
    this.saved.push(stats);
    return Promise.resolve();
  }
}

class MemoryDecisions implements CoachDecisionSink {
  readonly records: CoachDecisionRecord[] = [];

  write(record: CoachDecisionRecord): Promise<string> {
    this.records.push(record);
    return Promise.resolve('dec' + this.records.length.toString());
  }
}

function llm(...replies: (string | Error)[]): MockProvider {
  const queue = [...replies];
  return new MockProvider({
    respond: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('No scripted reply left');
      if (next instanceof Error) throw next;
      return next;
    },
  });
}

let runs: MemoryRuns;
let stats: MemoryStats;
let plan: MemoryPlanRepo;
let decisions: MemoryDecisions;
let sendMessage: ReturnType<typeof vi.fn>;
let syncActivities: ReturnType<typeof vi.fn>;

function deps(provider: MockProvider, overrides: Partial<WeeklyReviewDeps> = {}): WeeklyReviewDeps {
  return {
    runs,
    profiles: { findBriefProfile: (id) => Promise.resolve(id === USER_ID ? PRAGUE : null) },
    stats,
    seasons: { findActiveSeason: () => Promise.resolve(null) },
    planned: plan,
    syncActivities,
    getRulesContext: () => Promise.resolve(CONTEXT),
    provider,
    decisions,
    sendMessage: sendMessage as WeeklyReviewDeps['sendMessage'],
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW,
    ...overrides,
  };
}

function sentText(): string {
  return sendMessage.mock.calls[0][1] as string;
}

function sentKeyboard(): { text: string; callback_data: string }[][] {
  const options = sendMessage.mock.calls[0][2] as {
    reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  };
  return options.reply_markup?.inline_keyboard ?? [];
}

beforeEach(() => {
  runs = new MemoryRuns();
  stats = new MemoryStats();
  plan = new MemoryPlanRepo();
  for (const d of NEXT_WEEK) plan.insert(d);
  decisions = new MemoryDecisions();
  sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  syncActivities = vi.fn().mockResolvedValue(undefined);
});

describe('runWeeklyReviewJob: missed long ride', () => {
  it('quantifies the gap and offers a rules-compliant partial catch-up', async () => {
    const provider = llm(review());

    const result = await runWeeklyReviewJob(USER_ID, deps(provider));

    expect(result).toMatchObject({
      status: 'sent',
      isoWeek: '2026-W40',
      resumed: false,
      stale: false,
    });
    expect(syncActivities).toHaveBeenCalledWith(USER_ID);
    expect(stats.saved.map((s) => s.isoWeek)).toEqual(['2026-W40']);
    expect(provider.calls[0].prompt).toContain('- bike: 75 of 255 min (-180 min, 29%)');
    expect(provider.calls[0].prompt).toContain('`2026-10-10/bike-1`: bike 210 min Z2 "Long ride"');

    expect(decisions.records).toHaveLength(1);
    expect(decisions.records[0]).toMatchObject({
      origin: 'weekly',
      date: '2026-10-04',
      verdict: 'accept',
      finalAction: 'adjust',
      finalChanges: [PARTIAL_CATCH_UP],
    });

    const text = sentText();
    expect(text).toContain('🚴 Bike 75/255 min (−180) · 37.5 km');
    expect(text).toContain('🔑 Key 3/4 · missed Long ride');
    expect(text).toContain('• Bike Long ride 210′→255′');
    expect(text.split('\n').length).toBeLessThanOrEqual(WEEKLY_REPORT_MAX_LINES);
    expect(text).toMatchSnapshot();

    const buttons = sentKeyboard().flat();
    expect(buttons.map((b) => b.text)).toEqual([
      '✅ Apply next week',
      '➡️ Keep plan',
      '💬 Discuss',
    ]);
    expect(parseCoachDecision(buttons[0].callback_data)).toEqual({
      answer: 'apply',
      decisionId: 'dec1',
    });
    expect(runs.only()).toMatchObject({
      status: 'sent',
      coachDecisionId: 'dec1',
      reportText: text,
    });
  });

  it('rejects an over-aggressive catch-up: no Apply, the plan stays', async () => {
    const result = await runWeeklyReviewJob(
      USER_ID,
      deps(llm(review({ nextWeekChanges: [FULL_CATCH_UP] })))
    );

    expect(result.status).toBe('sent');
    expect(decisions.records[0]).toMatchObject({
      source: 'fallback',
      fallbackReason: 'guardrail_reject',
      verdict: 'reject',
      finalChanges: [],
    });
    expect(decisions.records[0].reasons.join('\n')).toContain('ramp cap');
    expect(sentText()).toContain(NOTE_REJECTED);
    expect(sentText()).toContain('No changes to next week.');
    expect(
      sentKeyboard()
        .flat()
        .map((b) => b.text)
    ).toEqual(['💬 Discuss']);
  });
});

describe('runWeeklyReviewJob: compliant week', () => {
  it('sends a positive report without changes', async () => {
    stats.data = weekData(null);
    const positive = review({
      summary: 'Every session done: 600 of 600 min, 117.5 km.',
      wins: ['Long ride and long run both complete', 'All key sessions hit'],
      concerns: [],
      nextWeekChanges: [],
    });

    await runWeeklyReviewJob(USER_ID, deps(llm(positive)));

    expect(decisions.records[0]).toMatchObject({ finalAction: 'keep', finalChanges: [] });
    const text = sentText();
    expect(text).toContain('🚴 Bike 255/255 min ✓');
    expect(text).toContain('✅ All key sessions hit');
    expect(text).not.toContain('⚠️');
    expect(
      sentKeyboard()
        .flat()
        .map((b) => b.text)
    ).toEqual(['💬 Discuss']);
    expect(text).toMatchSnapshot();
  });
});

describe('runWeeklyReviewJob: idempotency and failures', () => {
  it('resends the stored report on a retry after a failed send, with one decision', async () => {
    sendMessage.mockRejectedValueOnce(new Error('network down'));
    await expect(runWeeklyReviewJob(USER_ID, deps(llm(review())))).rejects.toThrow('network down');
    expect(runs.only().status).toBe('failed');

    const provider = llm();
    const result = await runWeeklyReviewJob(USER_ID, deps(provider));

    expect(result).toMatchObject({ status: 'sent', resumed: true, decisionId: 'dec1' });
    expect(decisions.records).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
    expect(sendMessage.mock.calls[1][1]).toBe(sendMessage.mock.calls[0][1]);
    expect(sendMessage.mock.calls[1][2]).toEqual(sendMessage.mock.calls[0][2]);
  });

  it('does nothing the second time in a week', async () => {
    await runWeeklyReviewJob(USER_ID, deps(llm(review())));
    const again = await runWeeklyReviewJob(USER_ID, deps(llm()));

    expect(again).toEqual({ status: 'skipped', reason: 'already_sent' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves a running review alone until its lease expires', async () => {
    await runs.claim(USER_ID, '2026-W40', NOW, WEEKLY_REVIEW_LEASE_MS);

    await expect(runWeeklyReviewJob(USER_ID, deps(llm()))).rejects.toBeInstanceOf(
      WeeklyReviewInProgressError
    );
    const later = new Date(NOW.getTime() + WEEKLY_REVIEW_LEASE_MS + 1);
    const result = await runWeeklyReviewJob(USER_ID, deps(llm(review()), { now: () => later }));
    expect(result.status).toBe('sent');
  });

  it('sends a stale report when intervals.icu is down', async () => {
    syncActivities.mockRejectedValue(new IcuServerError(503, 3));

    const result = await runWeeklyReviewJob(USER_ID, deps(llm(review())));

    expect(result).toMatchObject({ status: 'sent', stale: true });
    expect(sentText().split('\n')[1]).toBe(STALE_NOTE);
  });

  it('falls back to a stats-only report when the LLM is down', async () => {
    await runWeeklyReviewJob(USER_ID, deps(llm(new Error('boom'))));

    expect(decisions.records[0]).toMatchObject({ fallbackReason: 'llm_unavailable' });
    expect(sentText()).toContain('You trained 420 min of 600 min planned (70%).');
  });

  it('fails without retries when Telegram refuses the chat', async () => {
    const blocked = new GrammyError(
      'Forbidden',
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      'sendMessage',
      {}
    );
    sendMessage.mockRejectedValue(blocked);

    await expect(runWeeklyReviewJob(USER_ID, deps(llm(review())))).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
  });

  it('skips an athlete without a profile', async () => {
    expect(await runWeeklyReviewJob('nobody', deps(llm()))).toEqual({
      status: 'skipped',
      reason: 'no_profile',
    });
  });

  it('takes the ISO week of the athlete-local Sunday, not the UTC day', async () => {
    // 21:30 UTC is 23:30 on Sunday in Prague: still 2026-W40
    const lateSunday = new Date('2026-10-04T21:30:00Z');
    const result = await runWeeklyReviewJob(
      USER_ID,
      deps(llm(review()), { now: () => lateSunday })
    );
    expect(result).toMatchObject({ isoWeek: '2026-W40' });

    // 23:30 UTC Sunday is Monday 01:30 in Prague: the next ISO week
    const mondayLocal = new Date('2026-10-04T23:30:00Z');
    await runWeeklyReviewJob(USER_ID, deps(llm(review()), { now: () => mondayLocal }));
    expect([...runs.rows.keys()]).toEqual([USER_ID + '|2026-W40', USER_ID + '|2026-W41']);
  });
});

describe('renderWeeklyReport', () => {
  it('never takes more than 15 lines', () => {
    const many: SessionDiff[] = NEXT_WEEK.map((d) => ({
      sessionId: d.date + '/' + d.slot,
      field: 'durationMin',
      before: d.durationMin,
      after: d.durationMin - 10,
    }));
    const reply = renderWeeklyReport({
      stats: computeWeeklyStats({ isoWeek: '2026-W40', ...weekData(MISSED_RIDE) }),
      season: null,
      review: {
        summary: 'Line one\nline two',
        wins: ['a', 'b'],
        concerns: ['c', 'd'],
        note: 'clamped',
      },
      finalChanges: many,
      sessions: [],
      decisionId: 'dec1',
      stale: true,
    });
    const lines = reply.text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(WEEKLY_REPORT_MAX_LINES);
    expect(lines.at(-1)).toMatch(/^• \+\d+ more$/);
  });
});
