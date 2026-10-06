import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RacePriority, RaceType, Sport, type RunEffort } from '@triathlon/core';
import { MockProvider } from '@triathlon/ai';
import { IcuServerError } from '@triathlon/integrations-icu';
import type { StageTimings } from '../src/daily-loop/run-store';
import type { BriefProfile } from '../src/daily-loop/scheduler';
import type { PlannedSessionRecord } from '../src/plan-store';
import type { RaceRecord } from '../src/race-command';
import {
  RACE_BRIEF_LEASE_MS,
  RaceBriefInProgressError,
  runRaceBriefJob,
  type RaceBriefDeps,
} from '../src/races/race-brief';
import { NO_RUN_DATA_LINE, STALE_BRIEF_NOTE } from '../src/races/race-brief-render';
import type {
  RaceBriefClaimResult,
  RaceBriefKey,
  RaceBriefRun,
  RaceBriefRunRepo,
} from '../src/races/race-brief-store';

const USER_ID = 'user-1';
const CHAT_ID = 1001;
const PRAGUE: BriefProfile = {
  telegramChatId: CHAT_ID,
  timezone: 'Europe/Prague',
  briefTime: null,
  closeoutTime: null,
};
const RACE_DATE = '2026-10-17';
// 09:00 in Prague: T-7 is Sat 2026-10-10, T-1 is Fri 2026-10-16
const T7_NOW = new Date('2026-10-10T07:00:00Z');
const T1_NOW = new Date('2026-10-16T07:00:00Z');

function race(
  priority: RacePriority,
  type: RaceType = RaceType.half,
  date = RACE_DATE
): RaceRecord {
  return { id: 'race-' + priority, date, name: 'Prague Half', priority, type, travelDate: null };
}

const TONE = 'You are ready for this.\n---\nTrust your preparation.';

class MemoryRuns implements RaceBriefRunRepo {
  readonly rows = new Map<string, RaceBriefRun & { startedAt: Date | null; stale: boolean }>();

  private static keyOf(k: RaceBriefKey): string {
    return [k.userId, k.raceId, k.kind, k.raceDate].join('|');
  }

  claim(key: RaceBriefKey, now: Date, leaseMs: number): Promise<RaceBriefClaimResult> {
    const id = MemoryRuns.keyOf(key);
    const row = this.rows.get(id) ?? {
      id,
      status: 'pending' as const,
      briefText: null,
      stageTimings: {},
      startedAt: null,
      stale: false,
    };
    this.rows.set(id, row);
    const leaseExpired =
      row.status === 'running' && (row.startedAt?.getTime() ?? 0) < now.getTime() - leaseMs;
    if (row.status === 'pending' || row.status === 'failed' || leaseExpired) {
      Object.assign(row, { status: 'running', startedAt: now });
      return Promise.resolve({ status: 'claimed', run: structuredClone(row) });
    }
    return Promise.resolve({ status: row.status === 'running' ? 'in_progress' : 'already_sent' });
  }

  private row(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new Error('no run ' + id);
    return row;
  }

  saveBrief(id: string, briefText: string, stale: boolean): Promise<void> {
    Object.assign(this.row(id), { briefText, stale });
    return Promise.resolve();
  }

  markSent(id: string, _sentAt: Date, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.row(id), { status: 'sent', stageTimings });
    return Promise.resolve();
  }

  markFailed(id: string, _error: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.row(id), { status: 'failed', stageTimings });
    return Promise.resolve();
  }
}

const logger = { info: vi.fn(), warn: vi.fn() };

interface Setup {
  runs: MemoryRuns;
  provider: MockProvider;
  sent: { chatId: number; text: string; options: unknown }[];
  syncActivities: ReturnType<typeof vi.fn>;
  deps: RaceBriefDeps;
}

function setup(
  races: RaceRecord[],
  opts: {
    now?: Date;
    efforts?: RunEffort[];
    planned?: PlannedSessionRecord[];
    profile?: BriefProfile | null;
    ftp?: number | null;
    provider?: MockProvider;
  } = {}
): Setup {
  const runs = new MemoryRuns();
  const provider = opts.provider ?? new MockProvider({ respond: () => TONE });
  const sent: Setup['sent'] = [];
  const syncActivities = vi.fn(() => Promise.resolve());
  const deps: RaceBriefDeps = {
    runs,
    profiles: {
      findBriefProfile: () => Promise.resolve(opts.profile === undefined ? PRAGUE : opts.profile),
    },
    races: { findByDate: (_u, date) => Promise.resolve(races.filter((r) => r.date === date)) },
    planned: { listWindow: () => Promise.resolve(opts.planned ?? []) },
    getFtp: () => Promise.resolve(opts.ftp === undefined ? 300 : opts.ftp),
    runEfforts: { listRunEfforts: () => Promise.resolve(opts.efforts ?? []) },
    syncActivities,
    provider,
    sendMessage: (chatId, text, options) => {
      sent.push({ chatId, text, options });
      return Promise.resolve({ message_id: sent.length });
    },
    logger,
    now: () => opts.now ?? T1_NOW,
  };
  return { runs, provider, sent, syncActivities, deps };
}

const EFFORT: RunEffort = {
  date: '2026-10-06',
  durationSec: 50 * 60,
  distanceM: 10_000,
  avgHr: 160,
};

function plannedRow(date: string, sport: Sport, title: string, min: number): PlannedSessionRecord {
  return { date, sport, title, durationMin: min, deletedAt: null } as PlannedSessionRecord;
}

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
});

describe('T-1 brief of an A half-distance race', () => {
  it('shows the bike target from FTP and does not invent a run pace', async () => {
    const { deps, sent } = setup([race(RacePriority.A)]);

    const result = await runRaceBriefJob(USER_ID, deps);

    expect(result).toMatchObject({ status: 'done', date: '2026-10-16' });
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(CHAT_ID);
    expect(sent[0].options).toEqual({ parse_mode: 'HTML' });
    expect(sent[0].text).toContain('78–82% of FTP = 234–246 W (from FTP 300)');
    expect(sent[0].text).toContain(NO_RUN_DATA_LINE);
    expect(sent[0].text).toMatchSnapshot();
  });

  it('gives a run pace from a recent threshold effort and names its source', async () => {
    const { deps, sent } = setup([race(RacePriority.A)], { efforts: [EFFORT] });

    await runRaceBriefJob(USER_ID, deps);

    // 300 s/km threshold × 1.10 half factor, ±2%
    expect(sent[0].text).toContain('5:23/km to 5:37/km');
    expect(sent[0].text).toContain('best 20–60 min run, 2026-10-06 (10.0 km)');
    expect(sent[0].text).not.toContain(NO_RUN_DATA_LINE);
  });

  it('syncs activities first, and a failed sync only marks the brief stale', async () => {
    const { deps, sent, syncActivities } = setup([race(RacePriority.A)]);
    syncActivities.mockRejectedValueOnce(new IcuServerError(503, 'down'));

    await runRaceBriefJob(USER_ID, deps);

    expect(syncActivities).toHaveBeenCalledWith(USER_ID);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(STALE_BRIEF_NOTE);
  });

  it('keeps the numbers out of the LLM prompt reply: a reply with digits is replaced', async () => {
    const provider = new MockProvider({ respond: () => 'Hold 250 W.\n---\nGo.' });
    const { deps, sent } = setup([race(RacePriority.A)], { provider });

    await runRaceBriefJob(USER_ID, deps);

    expect(sent[0].text).not.toContain('250 W');
    expect(sent[0].text).toContain('234–246 W');
  });

  it('still sends when the LLM is down', async () => {
    const provider = new MockProvider({
      respond: () => {
        throw new Error('down');
      },
    });
    const { deps, sent } = setup([race(RacePriority.A)], { provider });

    await runRaceBriefJob(USER_ID, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Tomorrow is race day');
  });

  it('has no bike target for a running race', async () => {
    const { deps, sent } = setup([race(RacePriority.A, RaceType.run)]);

    await runRaceBriefJob(USER_ID, deps);

    expect(sent[0].text).not.toContain('FTP');
    expect(sent[0].text).not.toContain('Swim');
  });
});

describe('T-7 brief of an A-race', () => {
  it('has the week overview and the checklist, with no pacing numbers', async () => {
    const planned = [
      plannedRow('2026-10-12', Sport.run, 'Easy run', 40),
      plannedRow('2026-10-14', Sport.bike, 'Openers', 45),
    ];
    const { deps, sent, syncActivities } = setup([race(RacePriority.A)], {
      now: T7_NOW,
      planned,
    });

    await runRaceBriefJob(USER_ID, deps);

    expect(sent).toHaveLength(1);
    const text = sent[0].text;
    expect(text).toContain('Race week');
    expect(text).toContain('Mon 🏃 Easy run 40min');
    expect(text).toContain('<b>Gear</b>');
    expect(text).toContain('<b>Nutrition</b>');
    expect(text).toContain('<b>Admin</b>');
    expect(text).not.toContain('FTP');
    expect(syncActivities).not.toHaveBeenCalled();
    expect(text).toMatchSnapshot();
  });

  it('is skipped for B and C races', async () => {
    for (const priority of [RacePriority.B, RacePriority.C]) {
      const { deps, sent } = setup([race(priority)], { now: T7_NOW });

      const result = await runRaceBriefJob(USER_ID, deps);

      expect(result).toEqual({ status: 'done', date: '2026-10-10', briefs: [] });
      expect(sent).toHaveLength(0);
    }
  });
});

describe('B and C races', () => {
  it.each([RacePriority.B, RacePriority.C])(
    'get the shorter T-1 brief for a %s race',
    async (priority) => {
      const { deps, sent } = setup([race(priority)]);

      await runRaceBriefJob(USER_ID, deps);

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain('234–246 W');
      expect(sent[0].text).not.toContain('<b>Swim</b>');
      expect(sent[0].text).not.toContain('<b>Weather</b>');
      expect(sent[0].text).toMatchSnapshot();
    }
  );
});

describe('days without a due race', () => {
  it('sends nothing and does not call the LLM', async () => {
    const { deps, sent, provider } = setup([race(RacePriority.A)], {
      now: new Date('2026-10-13T07:00:00Z'),
    });

    const result = await runRaceBriefJob(USER_ID, deps);

    expect(result).toEqual({ status: 'done', date: '2026-10-13', briefs: [] });
    expect(sent).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('skips an athlete without a profile', async () => {
    const { deps } = setup([race(RacePriority.A)], { profile: null });
    expect(await runRaceBriefJob(USER_ID, deps)).toEqual({
      status: 'skipped',
      reason: 'no_profile',
    });
  });
});

describe('idempotency', () => {
  it('sends a brief once, whatever the number of triggers', async () => {
    const { deps, sent, provider } = setup([race(RacePriority.A)]);

    await runRaceBriefJob(USER_ID, deps);
    const second = await runRaceBriefJob(USER_ID, deps);

    expect(sent).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(second).toMatchObject({
      briefs: [{ status: 'skipped', reason: 'already_sent' }],
    });
  });

  it('resends the stored brief after a failed send, with no second LLM call', async () => {
    const { deps, sent, provider, runs } = setup([race(RacePriority.A)]);
    const send = deps.sendMessage;
    deps.sendMessage = vi.fn().mockRejectedValueOnce(new Error('network')).mockImplementation(send);

    await expect(runRaceBriefJob(USER_ID, deps)).rejects.toThrow('network');
    expect([...runs.rows.values()][0].status).toBe('failed');
    const stored = [...runs.rows.values()][0].briefText;
    expect(stored).not.toBeNull();

    const retry = await runRaceBriefJob(USER_ID, deps);

    expect(retry).toMatchObject({ briefs: [{ status: 'sent', resumed: true }] });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(stored);
    expect(provider.calls).toHaveLength(1);
  });

  it('throws while another attempt holds the run, so the job retries', async () => {
    const { deps, runs } = setup([race(RacePriority.A)]);
    await runs.claim(
      { userId: USER_ID, raceId: 'race-A', kind: 't1', raceDate: RACE_DATE },
      new Date(T1_NOW.getTime() - RACE_BRIEF_LEASE_MS / 2),
      RACE_BRIEF_LEASE_MS
    );

    await expect(runRaceBriefJob(USER_ID, deps)).rejects.toBeInstanceOf(RaceBriefInProgressError);
  });

  it('briefs a moved race again for its new date', async () => {
    const first = setup([race(RacePriority.A)]);
    await runRaceBriefJob(USER_ID, first.deps);

    // The race moves one week later: a new key, so T-1 of the new date is sent too
    const moved = race(RacePriority.A, RaceType.half, '2026-10-24');
    const second = setup([moved], { now: new Date('2026-10-23T07:00:00Z') });
    second.deps.runs = first.runs;
    await runRaceBriefJob(USER_ID, second.deps);

    expect(second.sent).toHaveLength(1);
  });
});
