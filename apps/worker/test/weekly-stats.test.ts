import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Intensity, Sport, type DateRange, type WeeklyStats } from '@triathlon/core';
import type { BriefProfile } from '../src/daily-loop/scheduler';
import { runWeeklyStats, type WeeklyStatsDeps } from '../src/reviews/weekly-stats';
import type { WeeklyStatsData, WeeklyStatsRepo } from '../src/reviews/weekly-stats-store';

// Monday 2026-10-05 06:00 in Prague: the run closes ISO week 2026-W40 (Sep 28 - Oct 4)
const NOW = new Date('2026-10-05T04:00:00Z');

const PRAGUE: BriefProfile = {
  telegramChatId: 1001,
  timezone: 'Europe/Prague',
  briefTime: null,
  closeoutTime: null,
};

interface StoredRow {
  userId: string;
  stats: WeeklyStats;
  computedAt: Date;
}

class MemoryWeeklyStats implements WeeklyStatsRepo {
  data: WeeklyStatsData = { sessions: [], activities: [], wellness: [], lthr: null };
  readonly ranges: DateRange[] = [];
  readonly rows = new Map<string, StoredRow>();

  loadRange(_userId: string, range: DateRange): Promise<WeeklyStatsData> {
    this.ranges.push(range);
    return Promise.resolve(this.data);
  }

  upsert(userId: string, stats: WeeklyStats, computedAt: Date): Promise<void> {
    this.rows.set(userId + '|' + stats.isoWeek, { userId, stats, computedAt });
    return Promise.resolve();
  }
}

let repo: MemoryWeeklyStats;
let profiles: Record<string, BriefProfile>;

function deps(overrides: Partial<WeeklyStatsDeps> = {}): WeeklyStatsDeps {
  return {
    profiles: { findBriefProfile: (userId) => Promise.resolve(profiles[userId] ?? null) },
    repo,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  repo = new MemoryWeeklyStats();
  profiles = { u1: PRAGUE };
});

describe('runWeeklyStats', () => {
  it('computes the ISO week before the local today', async () => {
    repo.data = {
      sessions: [
        {
          date: '2026-09-30',
          slot: 'run-1',
          sport: Sport.run,
          title: 'Threshold run',
          durationMin: 50,
          intensity: Intensity.z4,
          status: 'skipped',
          deleted: false,
        },
      ],
      activities: [],
      wellness: [],
      lthr: 165,
    };

    const result = await runWeeklyStats('u1', deps());

    expect(result.status).toBe('saved');
    expect(repo.ranges).toEqual([{ from: '2026-09-21', to: '2026-10-04' }]);
    const row = repo.rows.get('u1|2026-W40');
    expect(row?.computedAt).toEqual(NOW);
    expect(row?.stats).toMatchObject({
      isoWeek: '2026-W40',
      from: '2026-09-28',
      to: '2026-10-04',
      unplannedWeek: false,
      total: { plannedMin: 50, actualMin: 0, compliancePct: 0 },
    });
    expect(row?.stats.keySessions.missed.map((s) => s.title)).toEqual(['Threshold run']);
  });

  it('uses the athlete timezone to find today', async () => {
    // Sunday 23:30 UTC is already Monday in Prague, still Sunday in New York
    const now = () => new Date('2026-10-04T23:30:00Z');
    profiles.u2 = { ...PRAGUE, timezone: 'America/New_York' };

    await runWeeklyStats('u1', deps({ now }));
    await runWeeklyStats('u2', deps({ now }));

    expect([...repo.rows.keys()]).toEqual(['u1|2026-W40', 'u2|2026-W39']);
  });

  it('computes an explicit ISO week', async () => {
    await runWeeklyStats('u1', deps(), '2026-W38');

    expect(repo.ranges).toEqual([{ from: '2026-09-07', to: '2026-09-20' }]);
    expect(repo.rows.get('u1|2026-W38')?.stats.unplannedWeek).toBe(true);
  });

  it('replaces the row on a rerun', async () => {
    await runWeeklyStats('u1', deps());
    const later = new Date('2026-10-05T09:00:00Z');
    await runWeeklyStats('u1', deps({ now: () => later }));

    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get('u1|2026-W40')?.computedAt).toEqual(later);
  });

  it('skips an athlete without a profile', async () => {
    const result = await runWeeklyStats('nobody', deps());

    expect(result).toEqual({ status: 'skipped', reason: 'no_profile' });
    expect(repo.ranges).toEqual([]);
    expect(repo.rows.size).toBe(0);
  });

  it('rejects a malformed ISO week without writing', async () => {
    await expect(runWeeklyStats('u1', deps(), '2026-40')).rejects.toThrow(/Invalid ISO week/);
    expect(repo.rows.size).toBe(0);
  });
});
