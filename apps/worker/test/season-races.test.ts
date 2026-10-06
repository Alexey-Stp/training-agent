import { describe, it, expect, vi } from 'vitest';
import { RacePriority, RaceType, type Race } from '@triathlon/core';
import { racesForRange } from '../src/season-races';

const race = (date: string, priority: RacePriority): Race => ({
  date,
  name: date,
  priority,
  type: RaceType.olympic,
});

describe('racesForRange', () => {
  const stored = [
    race('2026-10-01', RacePriority.C),
    race('2026-10-10', RacePriority.B),
    race('2026-10-29', RacePriority.C),
    race('2026-10-28', RacePriority.C),
    race('2027-06-12', RacePriority.A),
  ];
  const repo = {
    listUpcoming: vi.fn((_userId: string, fromDate: string) =>
      Promise.resolve(stored.filter((r) => r.date >= fromDate))
    ),
  };
  const range = { from: '2026-10-08', to: '2026-10-21' };

  it('loads races a week past both ends of the range', async () => {
    const races = await racesForRange(repo, 'u1', { aRace: null }, range);
    expect(repo.listUpcoming).toHaveBeenCalledWith('u1', '2026-10-01');
    expect(races.map((r) => r.date)).toEqual(['2026-10-01', '2026-10-10', '2026-10-28']);
  });

  it("keeps the season's A-race and treats any other A-race like a B-race", async () => {
    const wide = { from: '2027-06-01', to: '2027-06-14' };
    const own = await racesForRange(repo, 'u1', { aRace: stored[4] }, wide);
    const other = await racesForRange(repo, 'u1', { aRace: null }, wide);
    expect(own.map((r) => r.priority)).toEqual([RacePriority.A]);
    expect(other.map((r) => r.priority)).toEqual([RacePriority.B]);
  });
});
