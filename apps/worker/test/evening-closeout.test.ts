import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { GrammyError } from 'grammy';
import { Intensity, Sport, type CloseoutActivity } from '@triathlon/core';
import { IcuServerError } from '@triathlon/integrations-icu';
import {
  CLOSEOUT_LEASE_MS,
  CloseoutInProgressError,
  runEveningCloseout,
  type EveningCloseoutDeps,
} from '../src/daily-loop/closeout';
import type {
  CloseoutClaimResult,
  CloseoutDay,
  CloseoutDaySession,
  CloseoutRepo,
  CloseoutWrite,
  EveningCloseoutRun,
  EveningCloseoutRunRepo,
} from '../src/daily-loop/closeout-store';
import { formatMinutes } from '../src/daily-loop/closeout-render';
import type { StageTimings } from '../src/daily-loop/run-store';
import type { BriefProfile } from '../src/daily-loop/scheduler';
import type { TelegramMessageOptions } from '../src/reply';

const USER_ID = 'user-1';
const CHAT_ID = 1001;
/** 20:30 in Prague (CEST, UTC+2) on Monday 2026-10-05 */
const NOW = new Date('2026-10-05T18:30:00Z');
const TODAY = '2026-10-05';
const PROFILE: BriefProfile = {
  telegramChatId: CHAT_ID,
  timezone: 'Europe/Prague',
  briefTime: null,
  closeoutTime: null,
};

type RunRow = EveningCloseoutRun & {
  userId: string;
  date: string;
  startedAt: Date | null;
  error: string | null;
  sentAt: Date | null;
};

/** Same semantics as the Prisma repo: one row per (userId, date), claimed with a lease. */
class MemoryRuns implements EveningCloseoutRunRepo {
  readonly rows = new Map<string, RunRow>();

  claim(userId: string, date: string, now: Date, leaseMs: number): Promise<CloseoutClaimResult> {
    const key = userId + '|' + date;
    const row = this.rows.get(key) ?? {
      id: 'run-' + date,
      userId,
      date,
      status: 'pending' as const,
      messageText: null,
      stageTimings: {},
      startedAt: null,
      error: null,
      sentAt: null,
    };
    this.rows.set(key, row);
    const leaseExpired =
      row.status === 'running' && (row.startedAt?.getTime() ?? 0) < now.getTime() - leaseMs;
    if (row.status === 'pending' || row.status === 'failed' || leaseExpired) {
      Object.assign(row, { status: 'running', startedAt: now, error: null });
      return Promise.resolve({ status: 'claimed', run: { ...row } });
    }
    return Promise.resolve({ status: row.status === 'running' ? 'in_progress' : 'already_done' });
  }

  private byId(id: string): RunRow {
    const row = [...this.rows.values()].find((r) => r.id === id);
    if (!row) throw new Error('no run ' + id);
    return row;
  }

  saveMessage(id: string, messageText: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { messageText, stageTimings });
    return Promise.resolve();
  }

  markQuiet(id: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { status: 'quiet', error: null, stageTimings });
    return Promise.resolve();
  }

  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { status: 'sent', sentAt, error: null, stageTimings });
    return Promise.resolve();
  }

  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { status: 'failed', error, stageTimings });
    return Promise.resolve();
  }

  only(): RunRow {
    const [row] = [...this.rows.values()];
    return row;
  }
}

type SessionRow = CloseoutDaySession & {
  date: string;
  deviationPct: number | null;
  actualIntensity: Intensity | null;
};

type ActivityRow = CloseoutActivity & {
  startDateLocal: string;
  plannedSessionId: string | null;
  closedOutAt: Date | null;
};

class MemoryCloseout implements CloseoutRepo {
  sessions: SessionRow[] = [];
  activities: ActivityRow[] = [];
  thresholds = { ftp: 300, lthr: 170 };
  readonly writes: CloseoutWrite[] = [];

  listDay(_userId: string, date: string): Promise<CloseoutDay> {
    return Promise.resolve({
      sessions: this.sessions.filter((s) => s.date === date).map((s) => ({ ...s })),
      activities: this.activities.filter((a) => a.startDateLocal === date).map((a) => ({ ...a })),
      thresholds: this.thresholds,
    });
  }

  apply(_userId: string, date: string, write: CloseoutWrite): Promise<void> {
    this.writes.push(write);
    for (const s of write.sessions) {
      const row = this.sessions.find((r) => r.id === s.sessionId && r.date === date && !r.deleted);
      if (row) Object.assign(row, s);
    }
    for (const link of write.links) {
      const row = this.activities.find((a) => a.id === link.activityId);
      if (row)
        Object.assign(row, { plannedSessionId: link.sessionId, closedOutAt: write.closedOutAt });
    }
    return Promise.resolve();
  }

  session(id: string): SessionRow {
    const row = this.sessions.find((s) => s.id === id);
    if (!row) throw new Error('no session ' + id);
    return row;
  }

  activity(id: string): ActivityRow {
    const row = this.activities.find((a) => a.id === id);
    if (!row) throw new Error('no activity ' + id);
    return row;
  }
}

function sessionRow(
  id: string,
  sport: Sport,
  durationMin: number,
  intensity: Intensity,
  title: string,
  extra: Partial<SessionRow> = {}
): SessionRow {
  return {
    id,
    date: TODAY,
    slot: sport + '-0',
    sport,
    title,
    durationMin,
    intensity,
    status: 'pushed',
    deleted: false,
    deviationPct: null,
    actualIntensity: null,
    ...extra,
  };
}

function activityRow(
  id: string,
  sport: Sport,
  durationMin: number,
  extra: Partial<ActivityRow> = {}
): ActivityRow {
  return {
    id,
    icuId: 'i' + id,
    sport,
    name: id,
    startTime: new Date('2026-10-05T15:00:00Z'),
    startDateLocal: TODAY,
    durationSec: durationMin * 60,
    avgHr: null,
    avgPower: null,
    plannedSessionId: null,
    closedOutAt: null,
    ...extra,
  };
}

let runs: MemoryRuns;
let closeout: MemoryCloseout;
let calls: string[];
let sendMessage: ReturnType<typeof vi.fn>;

function deps(overrides: Partial<EveningCloseoutDeps> = {}): EveningCloseoutDeps {
  return {
    runs,
    profiles: { findBriefProfile: () => Promise.resolve(PROFILE) },
    closeout,
    syncActivities: () => {
      calls.push('activity');
      return Promise.resolve();
    },
    sendMessage: sendMessage as unknown as EveningCloseoutDeps['sendMessage'],
    deviationThresholdPct: 25,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW,
    ...overrides,
  };
}

function sentText(): string {
  const [call] = sendMessage.mock.calls as [number, string, TelegramMessageOptions][];
  return call[1];
}

beforeEach(() => {
  runs = new MemoryRuns();
  closeout = new MemoryCloseout();
  calls = [];
  sendMessage = vi.fn(() => {
    calls.push('send');
    return Promise.resolve({ message_id: 42 });
  });
});

describe('runEveningCloseout: acceptance', () => {
  it('marks the VO2 ride done as planned completed and sends nothing', async () => {
    closeout.sessions = [sessionRow('vo2', Sport.bike, 60, Intensity.z5, 'VO2 5x4')];
    closeout.activities = [activityRow('ride', Sport.bike, 63, { avgPower: 280 })];

    const result = await runEveningCloseout(USER_ID, deps());

    expect(result).toMatchObject({
      status: 'quiet',
      summary: { completed: 1, skipped: 0, unplanned: 0, notices: 0 },
    });
    expect(closeout.session('vo2')).toMatchObject({
      status: 'completed',
      deviationPct: 5,
      actualIntensity: Intensity.z4,
    });
    expect(closeout.activity('ride')).toMatchObject({ plannedSessionId: 'vo2', closedOutAt: NOW });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runs.only().status).toBe('quiet');
    expect(calls).toEqual(['activity']);
  });

  it('marks a skipped long ride skipped and says so without judging', async () => {
    closeout.sessions = [sessionRow('long', Sport.bike, 180, Intensity.z2, 'Long ride')];

    const result = await runEveningCloseout(USER_ID, deps());

    expect(result).toMatchObject({ status: 'sent', summary: { skipped: 1, notices: 1 } });
    expect(closeout.session('long')).toMatchObject({ status: 'skipped', deviationPct: null });
    const text = sentText();
    expect(text).toContain('Long ride (3h)');
    expect(text).toContain('No problem');
    expect(text).toContain('weekly review');
    expect(runs.only()).toMatchObject({ status: 'sent', messageText: text, sentAt: NOW });
  });

  it('stores an unplanned run unmatched and flags it', async () => {
    closeout.activities = [activityRow('run', Sport.run, 45, { avgHr: 150 })];

    const result = await runEveningCloseout(USER_ID, deps());

    expect(result).toMatchObject({ status: 'sent', summary: { unplanned: 1 } });
    expect(closeout.activity('run')).toMatchObject({ plannedSessionId: null, closedOutAt: NOW });
    expect(sentText()).toContain('Unplanned run (45 min) logged. Flagged for the weekly review.');
  });
});

describe('runEveningCloseout: what gets reported', () => {
  it('reports a session far shorter than planned', async () => {
    closeout.sessions = [sessionRow('tempo', Sport.run, 50, Intensity.z3, 'Tempo run')];
    closeout.activities = [activityRow('run', Sport.run, 30)];

    await runEveningCloseout(USER_ID, deps());

    expect(closeout.session('tempo')).toMatchObject({ status: 'completed', deviationPct: -40 });
    expect(sentText()).toContain('Tempo run was 40% shorter than planned (30 of 50 min)');
  });

  it('stays quiet about a skipped easy session', async () => {
    closeout.sessions = [sessionRow('swim', Sport.swim, 45, Intensity.z2, 'Easy swim')];

    const result = await runEveningCloseout(USER_ID, deps());

    expect(result.status).toBe('quiet');
    expect(closeout.session('swim').status).toBe('skipped');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps an unmatched session the athlete changed in intervals.icu', async () => {
    closeout.sessions = [
      sessionRow('moved', Sport.bike, 180, Intensity.z2, 'Long ride', {
        status: 'modified_externally',
      }),
    ];

    const result = await runEveningCloseout(USER_ID, deps());

    expect(result.status).toBe('quiet');
    expect(closeout.session('moved').status).toBe('modified_externally');
  });

  it('leaves tombstoned sessions alone', async () => {
    closeout.sessions = [
      sessionRow('gone', Sport.run, 90, Intensity.z2, 'Long run', { deleted: true }),
    ];

    const result = await runEveningCloseout(USER_ID, deps());

    expect(result.status).toBe('quiet');
    expect(closeout.session('gone').status).toBe('pushed');
  });
});

describe('runEveningCloseout: idempotency', () => {
  it('does nothing on a second trigger after a quiet day', async () => {
    await runEveningCloseout(USER_ID, deps());
    const second = await runEveningCloseout(USER_ID, deps());

    expect(second).toEqual({ status: 'skipped', reason: 'already_done' });
    expect(closeout.writes).toHaveLength(1);
  });

  it('does not send twice after a sent close-out', async () => {
    closeout.sessions = [sessionRow('long', Sport.bike, 180, Intensity.z2, 'Long ride')];
    await runEveningCloseout(USER_ID, deps());
    await runEveningCloseout(USER_ID, deps());

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('resends the stored message on a retry after a failed send, without matching again', async () => {
    closeout.sessions = [sessionRow('long', Sport.bike, 180, Intensity.z2, 'Long ride')];
    sendMessage.mockRejectedValueOnce(new Error('network down'));

    await expect(runEveningCloseout(USER_ID, deps())).rejects.toThrow('network down');
    expect(runs.only()).toMatchObject({ status: 'failed' });
    const stored = runs.only().messageText;

    const retry = await runEveningCloseout(USER_ID, deps());

    expect(retry).toMatchObject({ status: 'sent', resumed: true, summary: null });
    expect(sendMessage).toHaveBeenLastCalledWith(CHAT_ID, stored, { parse_mode: 'HTML' });
    expect(closeout.writes).toHaveLength(1);
    expect(calls.filter((c) => c === 'activity')).toHaveLength(1);
  });

  it('throws while another attempt holds the lease, and takes over once it expires', async () => {
    await runs.claim(USER_ID, TODAY, NOW, CLOSEOUT_LEASE_MS);

    await expect(runEveningCloseout(USER_ID, deps())).rejects.toBeInstanceOf(
      CloseoutInProgressError
    );
    const later = new Date(NOW.getTime() + CLOSEOUT_LEASE_MS + 1000);
    const result = await runEveningCloseout(USER_ID, deps({ now: () => later }));
    expect(result.status).toBe('quiet');
  });
});

describe('runEveningCloseout: failures', () => {
  it('fails without writing anything when the final sync fails', async () => {
    closeout.sessions = [sessionRow('long', Sport.bike, 180, Intensity.z2, 'Long ride')];
    const syncActivities = () => Promise.reject(new IcuServerError(503, 3));

    await expect(runEveningCloseout(USER_ID, deps({ syncActivities }))).rejects.toBeInstanceOf(
      IcuServerError
    );
    expect(closeout.writes).toEqual([]);
    expect(closeout.session('long').status).toBe('pushed');
    expect(runs.only().status).toBe('failed');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('gives up without retries when the bot is blocked', async () => {
    closeout.activities = [activityRow('run', Sport.run, 45)];
    sendMessage.mockRejectedValueOnce(
      new GrammyError(
        'Forbidden',
        { ok: false, error_code: 403, description: 'bot was blocked by the user' },
        'sendMessage',
        {}
      )
    );

    await expect(runEveningCloseout(USER_ID, deps())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('skips athletes without a profile', async () => {
    const profiles = { findBriefProfile: () => Promise.resolve(null) };
    expect(await runEveningCloseout(USER_ID, deps({ profiles }))).toEqual({
      status: 'skipped',
      reason: 'no_profile',
    });
  });
});

describe('runEveningCloseout: timezone', () => {
  it('closes out the athlete-local day', async () => {
    // 00:30 on 2026-10-06 in Tokyo is still 2026-10-05 in UTC
    const tokyo = { ...PROFILE, timezone: 'Asia/Tokyo' };
    const now = new Date('2026-10-05T15:30:00Z');
    closeout.sessions = [
      sessionRow('today', Sport.run, 45, Intensity.z2, 'Easy run', { date: '2026-10-06' }),
    ];
    closeout.activities = [activityRow('run', Sport.run, 45, { startDateLocal: '2026-10-06' })];

    const result = await runEveningCloseout(
      USER_ID,
      deps({ profiles: { findBriefProfile: () => Promise.resolve(tokyo) }, now: () => now })
    );

    expect(result).toMatchObject({ status: 'quiet', date: '2026-10-06' });
    expect(closeout.session('today').status).toBe('completed');
  });
});

describe('formatMinutes', () => {
  it.each([
    [45, '45 min'],
    [60, '1h'],
    [90, '1h30'],
    [185, '3h05'],
  ])('%i → %s', (minutes, text) => {
    expect(formatMinutes(minutes)).toBe(text);
  });
});
