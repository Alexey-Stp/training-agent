import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Intensity,
  RacePriority,
  RaceType,
  Sport,
  type PlannedSessionDraft,
  type RaceStreams,
} from '@triathlon/core';
import { MockProvider } from '@triathlon/ai';
import { IcuServerError, type IcuEvent } from '@triathlon/integrations-icu';
import type { StageTimings } from '../src/daily-loop/run-store';
import type { BriefProfile } from '../src/daily-loop/scheduler';
import type { RaceRecord } from '../src/race-command';
import {
  debriefDeadline,
  RaceDebriefInProgressError,
  runPostRaceJob,
  type PostRaceDeps,
  type RaceActivity,
} from '../src/races/post-race';
import { recoveryWindows } from '../src/races/post-race-recovery';
import { NO_ACTIVITY_QUESTION } from '../src/races/race-debrief-render';
import type {
  RaceDebriefClaimResult,
  RaceDebriefKey,
  RaceDebriefRun,
  RaceDebriefRunRepo,
  SaveDebriefInput,
} from '../src/races/race-debrief-store';
import { FakeIcuCalendar, KEY, MemoryPlanRepo, USER_ID } from './planned-session-fakes';

const CHAT_ID = 1001;
const PRAGUE: BriefProfile = {
  telegramChatId: CHAT_ID,
  timezone: 'Europe/Prague',
  briefTime: null,
  closeoutTime: null,
};
// Race on Sunday 2026-10-11. 09:30 Prague on the days after it:
const RACE_DATE = '2026-10-11';
const DAY_AFTER = new Date('2026-10-12T07:30:00Z');
const TWO_DAYS_AFTER = new Date('2026-10-13T07:30:00Z');
// Deadline: end of race day (Oct 12 00:00 Prague) + 48 h = Oct 14 00:00 Prague
const THREE_DAYS_AFTER = new Date('2026-10-14T07:30:00Z');

function race(
  priority: RacePriority,
  type: RaceType = RaceType.half,
  date = RACE_DATE,
  id = 'race-' + priority
): RaceRecord {
  return { id, date, name: 'Prague Half', priority, type, travelDate: null };
}

const TEXT = 'Solid race, well paced.\n---\n- Start a touch easier.\n- Fuel early.\n- Rest well.';

const SEC = 1800;
const time = Array.from({ length: SEC }, (_, i) => i);
const flat = (value: number, n = SEC) => Array.from({ length: n }, () => value);
const half = (a: number, b: number) => [...flat(a, SEC / 2), ...flat(b, SEC / 2)];

function activity(overrides: Partial<RaceActivity> = {}): RaceActivity {
  return {
    icuId: 'a1',
    sport: Sport.bike,
    startDateLocal: RACE_DATE,
    durationSec: SEC,
    distanceM: 15000,
    avgHr: 150,
    avgPower: 240,
    ...overrides,
  };
}

class MemoryDebriefs implements RaceDebriefRunRepo {
  readonly rows = new Map<
    string,
    RaceDebriefRun & { startedAt: Date | null; saved: SaveDebriefInput | null; reason?: string }
  >();

  private static keyOf(k: RaceDebriefKey): string {
    return [k.userId, k.raceId, k.raceDate].join('|');
  }

  claim(key: RaceDebriefKey, now: Date, leaseMs: number): Promise<RaceDebriefClaimResult> {
    const id = MemoryDebriefs.keyOf(key);
    const row = this.rows.get(id) ?? {
      id,
      status: 'pending' as const,
      debriefText: null,
      stageTimings: {},
      startedAt: null,
      saved: null,
    };
    this.rows.set(id, row);
    const leaseExpired =
      row.status === 'running' && (row.startedAt?.getTime() ?? 0) < now.getTime() - leaseMs;
    if (row.status === 'pending' || row.status === 'failed' || leaseExpired) {
      Object.assign(row, { status: 'running', startedAt: now });
      return Promise.resolve({ status: 'claimed', run: structuredClone(row) });
    }
    return Promise.resolve({ status: row.status === 'running' ? 'in_progress' : 'already_done' });
  }

  private row(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new Error('no run ' + id);
    return row;
  }

  saveDebrief(id: string, input: SaveDebriefInput): Promise<void> {
    Object.assign(this.row(id), { debriefText: input.debriefText, saved: input });
    return Promise.resolve();
  }

  markSent(id: string, _sentAt: Date, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.row(id), { status: 'sent', stageTimings });
    return Promise.resolve();
  }

  markSkipped(id: string, reason: string): Promise<void> {
    Object.assign(this.row(id), { status: 'skipped', reason });
    return Promise.resolve();
  }

  release(id: string): Promise<void> {
    Object.assign(this.row(id), { status: 'pending', startedAt: null });
    return Promise.resolve();
  }

  markFailed(id: string, _error: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.row(id), { status: 'failed', stageTimings });
    return Promise.resolve();
  }
}

const logger = { info: vi.fn(), warn: vi.fn() };

interface Setup {
  runs: MemoryDebriefs;
  repo: MemoryPlanRepo;
  icu: FakeIcuCalendar;
  provider: MockProvider;
  sent: { chatId: number; text: string }[];
  syncActivities: ReturnType<typeof vi.fn>;
  completeSpy: ReturnType<typeof vi.fn>;
  deps: PostRaceDeps;
}

interface SetupOptions {
  now?: Date;
  activities?: RaceActivity[];
  streams?: RaceStreams | null;
  streamsError?: Error;
  respond?: () => string;
  syncError?: Error;
  failSendOnce?: boolean;
  timeoutHours?: number;
}

function setup(races: RaceRecord[], opts: SetupOptions = {}): Setup {
  const runs = new MemoryDebriefs();
  const repo = new MemoryPlanRepo();
  const icu = new FakeIcuCalendar();
  const respond = vi.fn(opts.respond ?? (() => TEXT));
  const provider = new MockProvider({ respond });
  const sent: Setup['sent'] = [];
  let failSend = opts.failSendOnce ?? false;
  const syncActivities = vi.fn(() =>
    opts.syncError ? Promise.reject(opts.syncError) : Promise.resolve()
  );
  const now = () => opts.now ?? DAY_AFTER;
  const deps: PostRaceDeps = {
    runs,
    profiles: { findBriefProfile: () => Promise.resolve(PRAGUE) },
    races: {
      listUpcoming: (_userId, fromDate) => Promise.resolve(races.filter((r) => r.date >= fromDate)),
    },
    store: { repo, now },
    push: { repo, keys: [KEY], createClient: () => icu, now },
    activities: {
      listByDate: (_u, date) =>
        Promise.resolve((opts.activities ?? []).filter((a) => a.startDateLocal === date)),
    },
    getFtp: () => Promise.resolve(300),
    runEfforts: { listRunEfforts: () => Promise.resolve([]) },
    syncActivities,
    getStreams: () =>
      opts.streamsError
        ? Promise.reject(opts.streamsError)
        : Promise.resolve(opts.streams === undefined ? null : opts.streams),
    provider,
    sendMessage: (chatId, text) => {
      if (failSend) {
        failSend = false;
        return Promise.reject(new Error('telegram down'));
      }
      sent.push({ chatId, text });
      return Promise.resolve({ message_id: sent.length });
    },
    debriefTimeoutHours: opts.timeoutHours ?? 48,
    logger,
    now,
  };
  return { runs, repo, icu, provider, sent, syncActivities, completeSpy: respond, deps };
}

function seededDraft(date: string, slot = 'run-0', title = 'Threshold Run'): PlannedSessionDraft {
  return {
    date,
    slot,
    sport: Sport.run,
    title,
    description: null,
    durationMin: 60,
    intensity: Intensity.z4,
    steps: [],
  };
}

/** A row the athlete already has on their ICU calendar. */
function seedPushed(s: Setup, date: string, id: number, slot = 'run-0'): void {
  s.repo.insert(seededDraft(date, slot), { status: 'pushed', icuEventId: id, pushedHash: 'h' });
  s.icu.events.set(id, { id, start_date_local: date + 'T00:00:00' } as unknown as IcuEvent);
}

async function windowRows(s: Setup, from: string, to: string) {
  const rows = await s.repo.listWindow(USER_ID, from, to);
  return rows.filter((r) => r.deletedAt === null);
}

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
});

describe('recovery windows', () => {
  it('starts the day after the race and never before today', () => {
    const races = [race(RacePriority.A, RaceType.full)];
    expect(recoveryWindows(races, '2026-10-12')).toMatchObject([
      { from: '2026-10-12', to: '2026-10-25' },
    ]);
    expect(recoveryWindows(races, '2026-10-16')).toMatchObject([
      { from: '2026-10-16', to: '2026-10-25' },
    ]);
  });

  it('is empty on race day, after the block, and for a 0-day recovery', () => {
    expect(recoveryWindows([race(RacePriority.A, RaceType.full)], RACE_DATE)).toEqual([]);
    expect(recoveryWindows([race(RacePriority.A, RaceType.full)], '2026-10-26')).toEqual([]);
    expect(recoveryWindows([race(RacePriority.C, RaceType.sprint)], '2026-10-12')).toEqual([]);
  });

  it('stops before the next race', () => {
    const races = [
      race(RacePriority.A, RaceType.full),
      race(RacePriority.B, RaceType.sprint, '2026-10-18', 'next'),
    ];
    expect(recoveryWindows(races, '2026-10-12')[0]).toMatchObject({ to: '2026-10-17' });
  });
});

describe('recovery block', () => {
  it('A full: replaces the planned sessions of the next 14 days with Z1 and rest on ICU', async () => {
    const s = setup([race(RacePriority.A, RaceType.full)]);
    seedPushed(s, '2026-10-13', 9001);
    seedPushed(s, '2026-10-16', 9002);
    seedPushed(s, '2026-10-24', 9003);
    // Before the window: history, not touched
    seedPushed(s, RACE_DATE, 9000);

    const result = await runPostRaceJob(USER_ID, s.deps);

    expect(result).toMatchObject({ status: 'done', recovery: { status: 'ok' } });
    const rows = await windowRows(s, '2026-10-12', '2026-10-25');
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.date)).toEqual([
      '2026-10-15',
      '2026-10-17',
      '2026-10-19',
      '2026-10-21',
      '2026-10-23',
      '2026-10-25',
    ]);
    expect(rows.every((r) => r.intensity === Intensity.z1)).toBe(true);
    expect(rows.every((r) => r.status === 'pushed' && r.icuEventId !== null)).toBe(true);
    // The old hard sessions are gone from ICU, the race day's event is still there
    expect([...s.icu.events.keys()]).toContain(9000);
    for (const id of [9001, 9002, 9003]) expect(s.icu.events.has(id)).toBe(false);
    expect(s.icu.events.size).toBe(7);
  });

  it('is idempotent: a second run writes nothing and makes no ICU calls', async () => {
    const s = setup([race(RacePriority.A, RaceType.full)]);
    seedPushed(s, '2026-10-16', 9002);
    await runPostRaceJob(USER_ID, s.deps);
    const calls = s.icu.calls.length;
    const rows = await windowRows(s, '2026-10-12', '2026-10-25');

    const again = await runPostRaceJob(USER_ID, s.deps);

    expect(again).toMatchObject({
      recovery: { status: 'ok', created: 0, updated: 0, deleted: 0 },
    });
    expect(s.icu.calls.slice(calls).filter((c) => !c.startsWith('list'))).toEqual([]);
    expect(await windowRows(s, '2026-10-12', '2026-10-25')).toEqual(rows);
  });

  it('keeps a session the athlete edited in ICU', async () => {
    const s = setup([race(RacePriority.A, RaceType.full)]);
    s.repo.insert(seededDraft('2026-10-16'), {
      status: 'modified_externally',
      icuEventId: 9002,
      pushedHash: 'h',
    });

    await runPostRaceJob(USER_ID, s.deps);

    expect(s.repo.get('2026-10-16', 'run-0')?.status).toBe('modified_externally');
  });

  it.each([
    [RacePriority.B, RaceType.half, 2],
    [RacePriority.B, RaceType.sprint, 1],
    [RacePriority.C, RaceType.half, 1],
  ])('%s %s: %i easy sessions', async (priority, type, sessions) => {
    const s = setup([race(priority, type)]);
    await runPostRaceJob(USER_ID, s.deps);
    const rows = await windowRows(s, '2026-10-12', '2026-10-30');
    expect(rows).toHaveLength(sessions);
    expect(rows.every((r) => r.intensity === Intensity.z1)).toBe(true);
  });

  it('does nothing for a C sprint', async () => {
    const s = setup([race(RacePriority.C, RaceType.sprint)]);
    const result = await runPostRaceJob(USER_ID, s.deps);
    expect(result).toMatchObject({ recovery: { status: 'none' } });
    expect(s.icu.calls).toEqual([]);
  });

  it('skips an athlete without an ICU connection', async () => {
    const s = setup([race(RacePriority.A, RaceType.full)]);
    s.repo.connection = null;
    const result = await runPostRaceJob(USER_ID, s.deps);
    expect(result).toMatchObject({ recovery: { status: 'not_connected' } });
    expect(await windowRows(s, '2026-10-12', '2026-10-25')).toEqual([]);
  });
});

describe('debrief', () => {
  it('power tier: compares NP with the T-1 target and names the split', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      activities: [activity()],
      streams: { timeSec: time, watts: half(255, 225), heartrate: half(140, 150) },
    });

    const result = await runPostRaceJob(USER_ID, s.deps);

    expect(result).toMatchObject({ debriefs: [{ status: 'sent', resumed: false }] });
    expect(s.sent).toHaveLength(1);
    const text = s.sent[0].text;
    expect(text).toMatch(/NP 24\d W vs T-1 target 234–246 W: within the band/);
    expect(text).toContain('positive split (second half slower)');
    expect(text).toContain('Takeaways');
    expect(text).toContain('1. Start a touch easier.');
    const saved = [...s.runs.rows.values()][0].saved;
    expect(saved?.tier).toBe('power');
    expect(saved?.takeaways).toHaveLength(3);
  });

  it('hr tier: heart rate and speed only on a run race', async () => {
    const s = setup([race(RacePriority.A, RaceType.run)], {
      activities: [activity({ sport: Sport.run, avgPower: null })],
      streams: { timeSec: time, velocity: half(3.2, 2.8), heartrate: half(150, 160) },
    });

    await runPostRaceJob(USER_ID, s.deps);

    const text = s.sent[0].text;
    expect(text).toContain('No power stream');
    expect(text).toContain('positive split');
    expect(text).toContain('Pace by half: 5:13/km then 5:57/km');
    expect([...s.runs.rows.values()][0].saved?.tier).toBe('hr');
  });

  it('none tier: averages only when there are no streams', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      activities: [activity()],
      streams: null,
    });

    await runPostRaceJob(USER_ID, s.deps);

    expect(s.sent[0].text).toContain('only whole-activity averages');
    expect(s.sent[0].text).toContain('Average power 240 W vs T-1 target 234–246 W');
    expect([...s.runs.rows.values()][0].saved?.tier).toBe('none');
  });

  it('falls back to averages when the streams call fails', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      activities: [activity()],
      streamsError: new IcuServerError(500, 'GET /activity/:id/streams', 'boom'),
    });

    await runPostRaceJob(USER_ID, s.deps);

    expect(s.sent).toHaveLength(1);
    expect([...s.runs.rows.values()][0].saved?.tier).toBe('none');
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('streams'));
  });

  it('debriefs the longest activity of race day', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      activities: [
        activity({ icuId: 'warmup', durationSec: 600 }),
        activity({ icuId: 'race', durationSec: 9000 }),
        activity({ icuId: 'yesterday', startDateLocal: '2026-10-10', durationSec: 20000 }),
      ],
    });

    await runPostRaceJob(USER_ID, s.deps);

    expect([...s.runs.rows.values()][0].saved?.activityIcuId).toBe('race');
  });

  it('uses the fixed text when the LLM states a number the code did not compute', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      activities: [activity()],
      respond: () => 'You rode 999 W.\n---\n- a\n- b\n- c',
    });

    await runPostRaceJob(USER_ID, s.deps);

    expect(s.sent[0].text).not.toContain('999');
    expect(s.sent[0].text).toContain('Congratulations on finishing');
  });

  it('is sent once: a later run does nothing', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], { activities: [activity()] });
    await runPostRaceJob(USER_ID, s.deps);
    const again = await runPostRaceJob(USER_ID, s.deps);

    expect(s.sent).toHaveLength(1);
    expect(again).toMatchObject({ debriefs: [{ status: 'skipped', reason: 'already_done' }] });
    expect(s.completeSpy).toHaveBeenCalledTimes(1);
  });

  it('resends the stored debrief after a failed send, with no second LLM call', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      activities: [activity()],
      failSendOnce: true,
    });

    await expect(runPostRaceJob(USER_ID, s.deps)).rejects.toThrow('telegram down');
    expect(s.sent).toHaveLength(0);
    const result = await runPostRaceJob(USER_ID, s.deps);

    expect(result).toMatchObject({ debriefs: [{ status: 'sent', resumed: true }] });
    expect(s.sent).toHaveLength(1);
    expect(s.completeSpy).toHaveBeenCalledTimes(1);
  });

  it('throws while another attempt holds the run', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], { activities: [activity()] });
    await s.runs.claim({ userId: USER_ID, raceId: 'race-A', raceDate: RACE_DATE }, DAY_AFTER, 1);
    // The lease of the first claim is still valid
    await expect(
      runPostRaceJob(USER_ID, { ...s.deps, now: () => DAY_AFTER })
    ).rejects.toBeInstanceOf(RaceDebriefInProgressError);
  });

  it('does not debrief on race day or long after the timeout', async () => {
    const onRaceDay = setup([race(RacePriority.A, RaceType.half)], {
      now: new Date('2026-10-11T18:00:00Z'),
      activities: [activity()],
    });
    await runPostRaceJob(USER_ID, onRaceDay.deps);
    expect(onRaceDay.sent).toEqual([]);
    expect(onRaceDay.runs.rows.size).toBe(0);

    const late = setup([race(RacePriority.A, RaceType.half)], {
      now: new Date('2026-10-20T07:30:00Z'),
      activities: [activity()],
    });
    await runPostRaceJob(USER_ID, late.deps);
    expect(late.sent).toEqual([]);
    expect(late.runs.rows.size).toBe(0);
  });
});

describe('48 h fallback', () => {
  it('computes the deadline from the end of race day in the athlete timezone', () => {
    expect(debriefDeadline({ date: RACE_DATE }, 'Europe/Prague', 48).toISOString()).toBe(
      '2026-10-13T22:00:00.000Z'
    );
  });

  it.each([DAY_AFTER, TWO_DAYS_AFTER])(
    'waits while the activity may still sync (%s)',
    async (now) => {
      const s = setup([race(RacePriority.A, RaceType.half)], { now });

      const result = await runPostRaceJob(USER_ID, s.deps);

      expect(result).toMatchObject({ debriefs: [{ status: 'waiting' }] });
      expect(s.sent).toEqual([]);
      expect([...s.runs.rows.values()][0].status).toBe('pending');
    }
  );

  it('after 48 h logs the skip and asks if they raced, once', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], { now: THREE_DAYS_AFTER });

    const first = await runPostRaceJob(USER_ID, s.deps);
    const second = await runPostRaceJob(USER_ID, s.deps);

    expect(first).toMatchObject({ debriefs: [{ status: 'skipped', reason: 'no_activity' }] });
    expect(second).toMatchObject({ debriefs: [{ status: 'skipped', reason: 'already_done' }] });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain('Did you race?');
    expect(s.sent[0].text).toContain(NO_ACTIVITY_QUESTION.slice(0, 30));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ raceId: 'race-A' }),
      'race debrief skipped: no race activity synced in time'
    );
    expect(s.completeSpy).not.toHaveBeenCalled();
  });

  it('keeps waiting when the sync failed: no activity proves nothing then', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      now: THREE_DAYS_AFTER,
      syncError: new IcuServerError(503, 'GET /athlete/:id/activities', 'down'),
    });

    const result = await runPostRaceJob(USER_ID, s.deps);

    expect(result).toMatchObject({ debriefs: [{ status: 'waiting' }] });
    expect(s.sent).toEqual([]);
  });

  it('debriefs a race activity that syncs on the last day', async () => {
    const s = setup([race(RacePriority.A, RaceType.half)], {
      now: TWO_DAYS_AFTER,
      activities: [activity()],
    });
    await runPostRaceJob(USER_ID, s.deps);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain('Debrief');
  });
});
