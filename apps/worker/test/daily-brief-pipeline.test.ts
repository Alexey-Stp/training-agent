import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { GrammyError } from 'grammy';
import {
  Intensity,
  parseCoachDecision,
  Sport,
  type RulesContext,
  type UserProfile,
} from '@triathlon/core';
import {
  LlmServerError,
  MockProvider,
  type CoachDecisionRecord,
  type CoachDecisionSink,
  type CoachSuggestion,
  type DailyContextDeps,
  type PlannedSessionSummary,
  type WellnessDay,
} from '@triathlon/ai';
import { IcuServerError } from '@triathlon/integrations-icu';
import {
  BRIEF_LEASE_MS,
  BriefInProgressError,
  runDailyBrief,
  type DailyBriefDeps,
} from '../src/daily-loop/pipeline';
import type {
  CheckInRun,
  ClaimResult,
  DailyBriefRun,
  DailyBriefRunRepo,
  SavedBrief,
  SavedCheckIn,
  StageTimings,
} from '../src/daily-loop/run-store';
import type { BriefProfile } from '../src/daily-loop/scheduler';
import type { IcuConnectionRecord } from '../src/icu-connect';
import type { TelegramMessageOptions } from '../src/reply';

const USER_ID = 'user-1';
const CHAT_ID = 1001;
/** 06:30 in Prague (CEST, UTC+2) on Monday 2026-10-05 */
const NOW = new Date('2026-10-05T04:30:00Z');
const TODAY = '2026-10-05';
const BRIEF_PROFILE: BriefProfile = {
  telegramChatId: CHAT_ID,
  timezone: 'Europe/Prague',
  briefTime: null,
};
const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Mon',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
};
const LOW_READINESS: RulesContext = {
  last7dStats: { totalMinutes: 0, byDate: [] },
  todayWellness: {
    subjectiveReadiness: 2,
    sleepScore: null,
    hrv: null,
    restingHr: null,
    tsb: null,
  },
};
const LLM_MESSAGE = 'Ride the VO2 session as planned, you are fresh.';

function wellnessDay(date: string, values: Partial<WellnessDay> = {}): WellnessDay {
  return {
    date,
    hrv: null,
    restingHr: null,
    sleepHours: null,
    sleepScore: null,
    weightKg: null,
    ctl: null,
    atl: null,
    tsb: null,
    subjectiveReadiness: null,
    soreness: null,
    ...values,
  };
}

const DEVICE = { hrv: 62, restingHr: 48, sleepHours: 7.5 };

/** Device data on the asked day and too little HRV history for a baseline: no check-in */
function normalDay(_from: string, to: string): WellnessDay[] {
  return [wellnessDay(to, DEVICE)];
}

function planned(
  date: string,
  slot: string,
  sport: Sport,
  intensity: Intensity,
  durationMin: number,
  title: string
): PlannedSessionSummary {
  return {
    date,
    slot,
    sport,
    title,
    durationMin,
    intensity,
    status: 'pushed',
    externalChange: null,
  };
}

const WEEK: PlannedSessionSummary[] = [
  planned(TODAY, 'bike-0', Sport.bike, Intensity.z4, 60, 'VO2 5x4'),
  planned('2026-10-06', 'run-0', Sport.run, Intensity.z2, 45, 'Easy run'),
  planned('2026-10-08', 'run-0', Sport.run, Intensity.z4, 50, 'Threshold run'),
];

const KEEP: CoachSuggestion = {
  assessment: 'Fresh and recovered.',
  action: 'keep',
  changes: [],
  confidence: 0.9,
  athleteMessage: LLM_MESSAGE,
};

/** Same semantics as the Prisma repo: one row per (userId, date), claimed with a lease. */
type RunRow = DailyBriefRun & {
  userId: string;
  date: string;
  startedAt: Date | null;
  error: string | null;
  checkInMessageId: number | null;
};

class MemoryRuns implements DailyBriefRunRepo {
  readonly rows = new Map<string, RunRow>();

  claim(
    userId: string,
    date: string,
    now: Date,
    leaseMs: number,
    opts: { continuation?: boolean } = {}
  ): Promise<ClaimResult> {
    const key = userId + '|' + date;
    const row: RunRow = this.rows.get(key) ?? {
      id: 'run-' + key,
      userId,
      date,
      status: 'pending',
      coachDecisionId: null,
      briefText: null,
      briefKeyboard: null,
      stale: false,
      dataAsOf: null,
      stageTimings: {},
      checkInSentAt: null,
      startedAt: null,
      error: null,
      checkInMessageId: null,
    };
    this.rows.set(key, row);
    const leaseExpired =
      row.status === 'running' && (row.startedAt?.getTime() ?? 0) < now.getTime() - leaseMs;
    if (row.status === 'sent') return Promise.resolve({ status: 'already_sent' });
    if (row.status === 'awaiting_checkin' && !opts.continuation)
      return Promise.resolve({ status: 'awaiting_checkin' });
    if (row.status === 'running' && !leaseExpired)
      return Promise.resolve({ status: 'in_progress' });
    row.status = 'running';
    row.startedAt = now;
    return Promise.resolve({ status: 'claimed', run: structuredClone(row) });
  }

  saveBrief(id: string, brief: SavedBrief): Promise<void> {
    Object.assign(this.byId(id), structuredClone(brief));
    return Promise.resolve();
  }

  saveCheckIn(id: string, checkIn: SavedCheckIn): Promise<void> {
    Object.assign(this.byId(id), {
      status: 'awaiting_checkin',
      checkInMessageId: checkIn.messageId,
      checkInSentAt: checkIn.sentAt,
      stale: checkIn.stale,
      dataAsOf: checkIn.dataAsOf,
      stageTimings: checkIn.stageTimings,
    });
    return Promise.resolve();
  }

  findByCheckInMessage(userId: string, messageId: number): Promise<CheckInRun | null> {
    const row = [...this.rows.values()].find(
      (r) => r.userId === userId && r.checkInMessageId === messageId
    );
    return Promise.resolve(row ? { id: row.id, date: row.date, status: row.status } : null);
  }

  markSent(id: string, _sentAt: Date, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { status: 'sent', stageTimings });
    return Promise.resolve();
  }

  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { status: 'failed', error, stageTimings });
    return Promise.resolve();
  }

  only(): RunRow {
    expect(this.rows.size).toBe(1);
    return [...this.rows.values()][0];
  }

  private byId(id: string) {
    const row = [...this.rows.values()].find((r) => r.id === id);
    if (!row) throw new Error('No run ' + id);
    return row;
  }
}

class MemoryDecisions implements CoachDecisionSink {
  readonly records: CoachDecisionRecord[] = [];

  write(record: CoachDecisionRecord): Promise<string> {
    this.records.push(record);
    return Promise.resolve('dec' + this.records.length.toString());
  }
}

function contextDeps(
  sessions: PlannedSessionSummary[],
  wellness: (from: string, to: string) => WellnessDay[] = normalDay
): DailyContextDeps {
  return {
    profiles: { findProfile: () => Promise.resolve(PROFILE) },
    seasons: { findActiveSeason: () => Promise.resolve(null) },
    races: { listUpcoming: () => Promise.resolve([]) },
    wellness: {
      listRange: (_userId, from, to) =>
        Promise.resolve(wellness(from, to).filter((w) => w.date >= from && w.date <= to)),
    },
    activities: { listRange: () => Promise.resolve([]) },
    planned: {
      listRange: (_userId, from, to) =>
        Promise.resolve(sessions.filter((s) => s.date >= from && s.date <= to)),
    },
    decisions: { listRecent: () => Promise.resolve([]) },
  };
}

let calls: string[];
let runs: MemoryRuns;
let decisions: MemoryDecisions;
let connection: IcuConnectionRecord | null;
let sendMessage: ReturnType<
  typeof vi.fn<
    (
      chatId: number,
      text: string,
      options: TelegramMessageOptions
    ) => Promise<{ message_id: number }>
  >
>;
let scheduleCheckInTimeout: ReturnType<
  typeof vi.fn<(userId: string, date: string) => Promise<void>>
>;
let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function llm(...replies: (CoachSuggestion | Error)[]): MockProvider {
  const queue = [...replies];
  return new MockProvider({
    respond: () => {
      calls.push('llm');
      const next = queue.shift() ?? KEEP;
      if (next instanceof Error) throw next;
      return JSON.stringify(next);
    },
  });
}

function deps(overrides: Partial<DailyBriefDeps> = {}): DailyBriefDeps {
  return {
    runs,
    profiles: { findBriefProfile: () => Promise.resolve(BRIEF_PROFILE) },
    syncWellness: () => {
      calls.push('wellness');
      return Promise.resolve({ status: 'ok' });
    },
    syncActivities: () => {
      calls.push('activity');
      return Promise.resolve({ status: 'ok' });
    },
    connections: { findByUserId: () => Promise.resolve(connection) },
    context: contextDeps(WEEK),
    getRulesContext: () => Promise.resolve({ last7dStats: { totalMinutes: 0, byDate: [] } }),
    provider: llm(KEEP),
    decisions,
    sendMessage,
    scheduleCheckInTimeout,
    logger,
    now: () => NOW,
    ...overrides,
  };
}

const icuDown = () => Promise.reject(new IcuServerError(503, 3));

function sentText(call = 0): string {
  return sendMessage.mock.calls[call][1];
}

function blocked(): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed!',
    { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    'sendMessage',
    {}
  );
}

beforeEach(() => {
  calls = [];
  runs = new MemoryRuns();
  decisions = new MemoryDecisions();
  connection = {
    userId: USER_ID,
    icuAthleteId: 'i1',
    icuAthleteName: 'Jane',
    apiKeyCiphertext: 'x',
    apiKeyIv: 'y',
    lastActivitySyncAt: new Date('2026-10-04T06:30:00Z'),
    lastWellnessSyncAt: new Date('2026-10-03T04:30:00Z'),
  };
  sendMessage = vi.fn(() => {
    calls.push('send');
    return Promise.resolve({ message_id: 1 });
  });
  scheduleCheckInTimeout = vi.fn(() => {
    calls.push('timeout');
    return Promise.resolve();
  });
  logger = { info: vi.fn(), warn: vi.fn() };
});

describe('runDailyBrief', () => {
  it('runs every stage in order and sends one brief', async () => {
    const result = await runDailyBrief(USER_ID, deps());

    expect(calls).toEqual(['wellness', 'activity', 'llm', 'send']);
    expect(result).toMatchObject({
      status: 'sent',
      date: TODAY,
      resumed: false,
      stale: false,
      source: 'llm',
    });
    expect(decisions.records).toHaveLength(1);
    expect(decisions.records[0]).toMatchObject({ origin: 'daily', date: TODAY, source: 'llm' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(CHAT_ID);
    expect(sentText()).toContain('Morning brief: Mon 5 Oct');
    expect(sentText()).toContain('VO2 5x4 (60min • Z4)');
    expect(sentText()).toContain(LLM_MESSAGE);
    expect(sentText()).not.toContain('intervals.icu unavailable');
    expect(sentText()).toContain('🟢 Recovered');
    // No changes: only Discuss
    const options = sendMessage.mock.calls[0][2];
    expect(options.parse_mode).toBe('HTML');
    expect(
      options.reply_markup?.inline_keyboard.flat().map((b) => parseCoachDecision(b.callback_data))
    ).toEqual([{ answer: 'discuss', decisionId: 'dec1' }]);
    expect(runs.only()).toMatchObject({ status: 'sent', coachDecisionId: 'dec1', stale: false });
  });

  it('adds Apply/Keep plan buttons when the coach changes the plan', async () => {
    await runDailyBrief(
      USER_ID,
      deps({
        provider: llm(new LlmServerError(503)),
        getRulesContext: () => Promise.resolve(LOW_READINESS),
      })
    );

    const keyboard = sendMessage.mock.calls[0][2].reply_markup?.inline_keyboard;
    expect(keyboard?.map((row) => row.map((b) => parseCoachDecision(b.callback_data)))).toEqual([
      [
        { answer: 'apply', decisionId: 'dec1' },
        { answer: 'keep', decisionId: 'dec1' },
      ],
      [{ answer: 'discuss', decisionId: 'dec1' }],
    ]);
    expect(sentText()).toContain('🔴 Low readiness (2/5)');
    expect(sentText()).toContain('<b>Proposed</b>');
  });

  describe('idempotency (one brief per athlete and local day)', () => {
    it('does nothing on a second trigger the same day', async () => {
      await runDailyBrief(USER_ID, deps());
      calls = [];

      const again = await runDailyBrief(
        USER_ID,
        deps({ now: () => new Date('2026-10-05T09:00:00Z') })
      );

      expect(again).toEqual({ status: 'skipped', reason: 'already_sent' });
      expect(calls).toEqual([]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(decisions.records).toHaveLength(1);
    });

    it('lets only one of two concurrent triggers run', async () => {
      const [a, b] = await Promise.allSettled([
        runDailyBrief(USER_ID, deps()),
        runDailyBrief(USER_ID, deps()),
      ]);

      expect(a.status).toBe('fulfilled');
      expect(b).toMatchObject({ status: 'rejected', reason: expect.any(BriefInProgressError) });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(decisions.records).toHaveLength(1);
    });

    it('takes over a run whose lease expired (the worker crashed mid-run)', async () => {
      await runs.claim(USER_ID, TODAY, NOW, BRIEF_LEASE_MS);

      await expect(runDailyBrief(USER_ID, deps())).rejects.toBeInstanceOf(BriefInProgressError);
      const later = new Date(NOW.getTime() + BRIEF_LEASE_MS + 1);
      const result = await runDailyBrief(USER_ID, deps({ now: () => later }));

      expect(result).toMatchObject({ status: 'sent', date: TODAY });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('skips an athlete without a profile', async () => {
      const result = await runDailyBrief(
        USER_ID,
        deps({ profiles: { findBriefProfile: () => Promise.resolve(null) } })
      );

      expect(result).toEqual({ status: 'skipped', reason: 'no_profile' });
      expect(runs.rows.size).toBe(0);
    });
  });

  describe('timezone and DST', () => {
    const dates = () => [...runs.rows.keys()].map((k) => k.split('|')[1]);

    it.each([
      // Spring forward (2026-03-29 02:00 CET → 03:00 CEST): 06:30 local moves from 05:30Z to 04:30Z
      [
        'spring forward',
        '2026-03-28T05:30:00Z',
        '2026-03-29T04:30:00Z',
        '2026-03-28',
        '2026-03-29',
      ],
      // Fall back (2026-10-25 03:00 CEST → 02:00 CET): 06:30 local moves from 04:30Z to 05:30Z
      ['fall back', '2026-10-24T04:30:00Z', '2026-10-25T05:30:00Z', '2026-10-24', '2026-10-25'],
    ])('keys each 06:30 run by its local date across %s', async (_label, before, after, d1, d2) => {
      await runDailyBrief(USER_ID, deps({ now: () => new Date(before) }));
      await runDailyBrief(USER_ID, deps({ now: () => new Date(after) }));

      expect(dates()).toEqual([d1, d2]);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('runs once on the fall-back day even if fired at both UTC offsets', async () => {
      // 04:30Z is 05:30 CET on 2026-10-25: the same local day as the 05:30Z (06:30 CET) run
      await runDailyBrief(USER_ID, deps({ now: () => new Date('2026-10-25T04:30:00Z') }));
      const second = await runDailyBrief(
        USER_ID,
        deps({ now: () => new Date('2026-10-25T05:30:00Z') })
      );

      expect(second).toEqual({ status: 'skipped', reason: 'already_sent' });
      expect(dates()).toEqual(['2026-10-25']);
    });

    it('uses the local date when UTC is still on the previous day', async () => {
      const result = await runDailyBrief(
        USER_ID,
        deps({ now: () => new Date('2026-10-05T22:30:00Z') })
      );

      expect(result).toMatchObject({ date: '2026-10-06' });
    });
  });

  describe('degradation', () => {
    it('still sends the brief when ICU is down, marked with the data age', async () => {
      const result = await runDailyBrief(
        USER_ID,
        deps({ syncWellness: icuDown, syncActivities: icuDown })
      );

      expect(result).toMatchObject({ status: 'sent', stale: true });
      // Oldest cursor of the failed syncs (wellness), in Prague time
      expect(sentText()).toContain('⚠️ intervals.icu unavailable: data as of 2026-10-03 06:30');
      expect(runs.only()).toMatchObject({
        stale: true,
        dataAsOf: new Date('2026-10-03T04:30:00Z'),
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'wellness' }),
        'daily brief: sync failed, continuing with stale data'
      );
    });

    it('dates the note by the sync that failed', async () => {
      await runDailyBrief(USER_ID, deps({ syncActivities: icuDown }));

      expect(sentText()).toContain('data as of 2026-10-04 08:30');
    });

    it('says never synced when the failed sync has no cursor', async () => {
      connection = { ...connection!, lastWellnessSyncAt: null };
      await runDailyBrief(USER_ID, deps({ syncWellness: icuDown }));

      expect(sentText()).toContain('data as of never synced');
    });

    it('falls back to the rules engine when the LLM errors', async () => {
      const result = await runDailyBrief(
        USER_ID,
        deps({
          provider: llm(new LlmServerError(503)),
          getRulesContext: () => Promise.resolve(LOW_READINESS),
        })
      );

      expect(result).toMatchObject({ status: 'sent', source: 'fallback' });
      expect(decisions.records).toHaveLength(1);
      expect(decisions.records[0]).toMatchObject({
        source: 'fallback',
        fallbackReason: 'llm_unavailable',
        finalAction: 'reduce',
      });
      expect(sentText()).toContain('standard safety rules');
      expect(sentText()).toContain('Z4 → Z2');
    });

    it('falls back to the rules engine when the context cannot be built', async () => {
      const context = contextDeps(WEEK);
      context.profiles.findProfile = () => Promise.reject(new Error('db hiccup'));
      const provider = llm();

      const result = await runDailyBrief(USER_ID, deps({ context, provider }));

      expect(result).toMatchObject({ status: 'sent', source: 'fallback' });
      expect(provider.calls).toHaveLength(0);
      expect(decisions.records[0]).toMatchObject({ fallbackReason: 'internal_error' });
      expect(sentText()).toContain('standard safety rules');
    });

    it('fails the run when the plan cannot be read, so the job retries', async () => {
      await expect(
        runDailyBrief(
          USER_ID,
          deps({ getRulesContext: () => Promise.reject(new Error('db down')) })
        )
      ).rejects.toThrow('db down');

      expect(sendMessage).not.toHaveBeenCalled();
      expect(runs.only()).toMatchObject({ status: 'failed', error: 'Error: db down' });
    });

    it('rethrows a failed send and resends the stored brief on retry', async () => {
      sendMessage.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      await expect(runDailyBrief(USER_ID, deps())).rejects.toThrow('ETIMEDOUT');
      expect(runs.only()).toMatchObject({ status: 'failed', coachDecisionId: 'dec1' });
      const firstText = sentText();
      calls = [];

      const retry = await runDailyBrief(USER_ID, deps());

      expect(retry).toMatchObject({ status: 'sent', resumed: true, source: null });
      expect(calls).toEqual(['send']);
      expect(sentText(1)).toBe(firstText);
      expect(decisions.records).toHaveLength(1);
      expect(runs.only().status).toBe('sent');
    });

    it('resends the stored buttons on retry', async () => {
      sendMessage.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      const fallback = {
        provider: llm(new LlmServerError(503)),
        getRulesContext: () => Promise.resolve(LOW_READINESS),
      };

      await expect(runDailyBrief(USER_ID, deps(fallback))).rejects.toThrow();
      await runDailyBrief(USER_ID, deps(fallback));

      expect(sendMessage.mock.calls[1][2]).toEqual(sendMessage.mock.calls[0][2]);
    });

    it('does not retry when the athlete blocked the bot', async () => {
      sendMessage.mockRejectedValueOnce(blocked());

      await expect(runDailyBrief(USER_ID, deps())).rejects.toBeInstanceOf(UnrecoverableError);
      expect(runs.only().status).toBe('failed');
    });
  });

  it('logs the timing of every stage', async () => {
    await runDailyBrief(USER_ID, deps({ syncWellness: icuDown }));

    const stages = logger.info.mock.calls
      .filter(([, msg]) => msg === 'daily brief stage')
      .map(([obj]) => obj as { stage: string; ms: number; outcome: string });
    expect(stages.map((s) => [s.stage, s.outcome])).toEqual([
      ['wellness', 'error'],
      ['activity', 'ok'],
      ['checkin', 'ok'],
      ['context', 'ok'],
      ['suggest', 'ok'],
      ['send', 'ok'],
    ]);
    expect(stages.every((s) => Number.isInteger(s.ms) && s.ms >= 0)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        date: TODAY,
        status: 'sent',
        timings: expect.objectContaining({
          wellness: expect.any(Number),
          send: expect.any(Number),
        }) as unknown,
      }),
      'daily brief finished'
    );
    expect(Object.keys(runs.only().stageTimings).sort((a, b) => a.localeCompare(b))).toEqual([
      'activity',
      'checkin',
      'context',
      'send',
      'suggest',
      'wellness',
    ]);
  });
});

describe('morning check-in', () => {
  /** 30 days of HRV around 60 ± 1 ms before today, then today's reading */
  function hrvHistory(todayHrv: number): WellnessDay[] {
    const days = Array.from({ length: 30 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 5 + i)).toISOString().slice(0, 10);
      return wellnessDay(date, { hrv: i % 2 === 0 ? 59 : 61, restingHr: 48 });
    });
    return [...days, wellnessDay(TODAY, { hrv: todayHrv, restingHr: 48, sleepHours: 7 })];
  }

  function keyboardData(call = 0): string[][] {
    const keyboard = sendMessage.mock.calls[call][2].reply_markup?.inline_keyboard ?? [];
    return keyboard.map((row) => row.map((b) => b.callback_data));
  }

  it('sends the check-in first when today has no wellness row, and waits', async () => {
    const result = await runDailyBrief(USER_ID, deps({ context: contextDeps(WEEK, () => []) }));

    expect(result).toEqual({ status: 'awaiting_checkin', date: TODAY, reason: 'no_data' });
    expect(calls).toEqual(['wellness', 'activity', 'timeout', 'send']);
    expect(scheduleCheckInTimeout).toHaveBeenCalledWith(USER_ID, TODAY);
    expect(sentText()).toContain('Quick check-in');
    expect(keyboardData()).toEqual([
      ['ci:r:1', 'ci:r:2', 'ci:r:3', 'ci:r:4', 'ci:r:5'],
      ['ci:s:0', 'ci:s:1', 'ci:s:2'],
    ]);
    expect(decisions.records).toHaveLength(0);
    expect(runs.only()).toMatchObject({
      status: 'awaiting_checkin',
      checkInMessageId: 1,
      checkInSentAt: NOW,
      briefText: null,
    });
  });

  it.each([
    ['low', 50],
    ['high', 70],
  ])('sends the check-in when HRV is %s (more than 1 SD off the baseline)', async (_, hrv) => {
    const result = await runDailyBrief(
      USER_ID,
      deps({ context: contextDeps(WEEK, () => hrvHistory(hrv)) })
    );

    expect(result).toMatchObject({ status: 'awaiting_checkin', reason: 'hrv_deviation' });
  });

  it('sends no check-in when wellness is complete and normal', async () => {
    const result = await runDailyBrief(
      USER_ID,
      deps({ context: contextDeps(WEEK, () => hrvHistory(60)) })
    );

    expect(result).toMatchObject({ status: 'sent' });
    expect(calls).toEqual(['wellness', 'activity', 'llm', 'send']);
    expect(scheduleCheckInTimeout).not.toHaveBeenCalled();
    expect(sentText()).not.toContain('check-in');
  });

  it('skips other triggers of the day while the check-in is out', async () => {
    const context = contextDeps(WEEK, () => []);
    await runDailyBrief(USER_ID, deps({ context }));
    calls = [];

    const retry = await runDailyBrief(USER_ID, deps({ context }));

    expect(retry).toEqual({ status: 'skipped', reason: 'awaiting_checkin' });
    expect(calls).toEqual([]);
  });

  it('sends the brief with "No check-in today" after the timeout, without syncing again', async () => {
    const context = contextDeps(WEEK, () => []);
    await runDailyBrief(USER_ID, deps({ context, syncActivities: icuDown }));
    calls = [];

    const later = new Date(NOW.getTime() + 15 * 60_000);
    const result = await runDailyBrief(USER_ID, deps({ context, now: () => later }), {
      checkInDate: TODAY,
    });

    expect(result).toMatchObject({ status: 'sent', date: TODAY, stale: true });
    expect(calls).toEqual(['llm', 'send']);
    expect(sentText(1)).toContain('No check-in today.');
    // Freshness of the first run's sync
    expect(sentText(1)).toContain('intervals.icu unavailable');
    expect(runs.only().status).toBe('sent');
  });

  it('puts the answers in the prompt when the athlete answered', async () => {
    let wellness: WellnessDay[] = [];
    const context = contextDeps(WEEK, () => wellness);
    await runDailyBrief(USER_ID, deps({ context }));
    wellness = [wellnessDay(TODAY, { subjectiveReadiness: 4, soreness: 1 })];

    const provider = llm(KEEP);
    await runDailyBrief(USER_ID, deps({ context, provider }), { checkInDate: TODAY });

    expect(provider.calls[0].prompt).toContain('Check-in: readiness 4/5, soreness mild.');
    expect(sentText(1)).not.toContain('No check-in today.');
  });

  it('finishes the brief for the check-in date even after local midnight', async () => {
    await runDailyBrief(USER_ID, deps({ context: contextDeps(WEEK, () => []) }));

    const nextDay = new Date('2026-10-05T22:05:00Z');
    const result = await runDailyBrief(
      USER_ID,
      deps({ context: contextDeps(WEEK, () => []), now: () => nextDay }),
      { checkInDate: TODAY }
    );

    expect(result).toMatchObject({ status: 'sent', date: TODAY });
  });

  it('does not wait for a check-in the athlete already answered', async () => {
    const answered = [wellnessDay(TODAY, { subjectiveReadiness: 3, soreness: 0 })];
    const result = await runDailyBrief(
      USER_ID,
      deps({ context: contextDeps(WEEK, () => answered) })
    );

    expect(result).toMatchObject({ status: 'sent' });
    expect(scheduleCheckInTimeout).not.toHaveBeenCalled();
  });
});
