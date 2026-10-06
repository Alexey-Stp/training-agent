import { describe, it, expect, beforeEach } from 'vitest';
import type { Profile } from '@prisma/client';
import { RacePriority, RaceType, type Race } from '@triathlon/core';
import {
  handleRace,
  MSG_RACE_MOVE_USAGE,
  MSG_RACE_USAGE,
  MSG_REPROJECTION_COMING,
  parseRaceAddArgs,
  type RaceCommandDeps,
  type RaceMove,
  type RaceRecord,
} from '../src/race-command';

const TODAY = '2026-10-07';
const PROFILE: Profile = {
  id: 'profile-1',
  userId: 'user-1',
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};
const USER = { id: 'user-1', profile: PROFILE };

describe('parseRaceAddArgs', () => {
  it('parses date, type, priority and a multi-word name', () => {
    expect(parseRaceAddArgs(['2027-06-12', 'Olympic', 'a', 'Prague', 'Triathlon'], TODAY)).toEqual({
      ok: true,
      race: {
        date: '2027-06-12',
        type: RaceType.olympic,
        priority: RacePriority.A,
        name: 'Prague Triathlon',
      },
    });
  });

  it('requires all four parts', () => {
    expect(parseRaceAddArgs([], TODAY)).toEqual({ ok: false, error: MSG_RACE_USAGE });
    expect(parseRaceAddArgs(['2027-06-12', 'olympic', 'A'], TODAY)).toEqual({
      ok: false,
      error: MSG_RACE_USAGE,
    });
  });

  it.each([
    [['2027-02-30', 'olympic', 'A', 'X'], /not a yyyy-MM-dd/],
    [['12.06.2027', 'olympic', 'A', 'X'], /not a yyyy-MM-dd/],
    [[TODAY, 'olympic', 'A', 'X'], /after today/],
    [['2026-10-01', 'olympic', 'A', 'X'], /after today/],
    [
      ['2027-06-12', 'ironman', 'A', 'X'],
      /type must be one of: sprint, olympic, half, full, run, other/,
    ],
    [['2027-06-12', 'olympic', 'D', 'X'], /A, B or C/],
    [['2027-06-12', 'olympic', 'A', 'x'.repeat(101)], /100 characters/],
  ])('rejects %j', (args, error) => {
    const result = parseRaceAddArgs(args, TODAY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  });
});

describe('parseRaceAddArgs travel day', () => {
  it('takes an optional travel=<date> anywhere after the race', () => {
    const parsed = parseRaceAddArgs(
      ['2027-06-12', 'half', 'A', 'travel=2027-06-11', 'Prague', '70.3'],
      TODAY
    );
    expect(parsed).toEqual({
      ok: true,
      race: {
        date: '2027-06-12',
        type: RaceType.half,
        priority: RacePriority.A,
        name: 'Prague 70.3',
        travelDate: '2027-06-11',
      },
    });
  });

  it.each([
    ['travel=2027-6-11', 'is not a yyyy-MM-dd date'],
    ['travel=2027-06-12', '1 to 7 days before the race'],
    ['travel=2027-06-01', '1 to 7 days before the race'],
  ])('rejects %s', (token, message) => {
    const parsed = parseRaceAddArgs(['2027-06-12', 'half', 'A', 'Prague', token], TODAY);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(message);
  });
});

describe('handleRace', () => {
  let stored: RaceRecord[];
  let aRaceId: string | null;
  let queued: RaceMove[];
  let deps: RaceCommandDeps;

  beforeEach(() => {
    stored = [];
    aRaceId = null;
    queued = [];
    deps = {
      repo: {
        create: (_userId, race: Race) => {
          const record = { ...race, id: `r${(stored.length + 1).toString()}` };
          stored.push(record);
          return Promise.resolve(record);
        },
        listUpcoming: (_userId, fromDate) =>
          Promise.resolve(stored.filter((r) => r.date >= fromDate)),
        findByDate: (_userId, date) => Promise.resolve(stored.filter((r) => r.date === date)),
        moveDate: (_userId, raceId, date, travelDate) => {
          const race = stored.find((r) => r.id === raceId);
          if (race) Object.assign(race, { date, travelDate });
          return Promise.resolve(race !== undefined);
        },
      },
      activeARaceId: () => Promise.resolve(aRaceId),
      queueBlockReview: (_userId, move) => {
        queued.push(move);
        return Promise.resolve();
      },
      now: () => new Date('2026-10-07T10:00:00Z'),
    };
  });

  it('adds a race and suggests /season new for an A race', async () => {
    const reply = await handleRace(USER, ['add', '2027-06-12', 'olympic', 'A', 'Prague'], deps);
    expect(reply).toMatch(/^✅ Race added: Sat Jun 12, 2027 · A · olympic · Prague/);
    expect(reply).toContain('/season new');
    expect(stored).toHaveLength(1);
  });

  it('does not suggest a season for B and C races', async () => {
    const reply = await handleRace(USER, ['add', '2027-04-18', 'sprint', 'B', 'Brno'], deps);
    expect(reply).not.toContain('/season new');
  });

  it('does not store an invalid race', async () => {
    const reply = await handleRace(USER, ['add', '2027-06-12', 'olympic', 'Z', 'Prague'], deps);
    expect(reply).toMatch(/^❌/);
    expect(stored).toHaveLength(0);
  });

  it('lists upcoming races', async () => {
    expect(await handleRace(USER, ['list'], deps)).toMatch(/No upcoming races/);
    await handleRace(USER, ['add', '2027-06-12', 'olympic', 'A', 'Prague'], deps);
    expect(await handleRace(USER, ['list'], deps)).toContain(
      '• Sat Jun 12, 2027 · A · olympic · Prague'
    );
  });

  it('shows usage for anything else', async () => {
    expect(await handleRace(USER, [], deps)).toBe(MSG_RACE_USAGE);
    expect(await handleRace(USER, ['remove'], deps)).toBe(MSG_RACE_USAGE);
  });

  describe('/race move', () => {
    beforeEach(async () => {
      await handleRace(USER, ['add', '2027-06-12', 'half', 'A', 'Prague'], deps);
    });

    it('moves the A-race and queues a block review to re-project the season', async () => {
      aRaceId = 'r1';

      const reply = await handleRace(USER, ['move', '2027-06-12', '2027-06-26'], deps);

      const moved = '✅ Race moved: Sat Jun 26, 2027 · A · half · Prague';
      expect(reply).toBe([moved, '', MSG_REPROJECTION_COMING].join('\n'));
      expect(stored[0].date).toBe('2027-06-26');
      expect(queued).toEqual([{ raceId: 'r1', previousDate: '2027-06-12', newDate: '2027-06-26' }]);
    });

    it('keeps the travel day the same number of days before the moved race', async () => {
      await handleRace(
        USER,
        ['add', '2027-07-10', 'olympic', 'B', 'Lake', 'travel=2027-07-09'],
        deps
      );

      const reply = await handleRace(USER, ['move', '2027-07-10', '2027-07-17'], deps);

      expect(reply).toBe('✅ Race moved: Sat Jul 17, 2027 · B · olympic · Lake · ✈️ Fri Jul 16');
      expect(stored[1]).toMatchObject({ date: '2027-07-17', travelDate: '2027-07-16' });
    });

    it('only moves a race that is not the active season A-race', async () => {
      const reply = await handleRace(USER, ['move', '2027-06-12', '2027-06-26'], deps);

      expect(reply).toBe('✅ Race moved: Sat Jun 26, 2027 · A · half · Prague');
      expect(queued).toEqual([]);
    });

    it.each([
      [[], MSG_RACE_MOVE_USAGE],
      [['2027-06-12'], MSG_RACE_MOVE_USAGE],
      [['2027-06-12', '2027-02-30'], '❌ 2027-02-30 is not a yyyy-MM-dd date.'],
      [['2027-06-12', '2026-10-07'], '❌ The new race date must be after today.'],
      [['2027-06-12', '2027-06-12'], '❌ The race is already on 2027-06-12.'],
      [['2027-06-13', '2027-06-26'], '❌ No race on 2027-06-13. See /race list.'],
    ])('rejects %j', async (args, error) => {
      aRaceId = 'r1';
      expect(await handleRace(USER, ['move', ...args], deps)).toBe(error);
      expect(stored[0].date).toBe('2027-06-12');
      expect(queued).toEqual([]);
    });

    it('refuses to guess between two races on the same day', async () => {
      await handleRace(USER, ['add', '2027-06-12', 'sprint', 'C', 'Brno'], deps);
      expect(await handleRace(USER, ['move', '2027-06-12', '2027-06-26'], deps)).toMatch(
        /More than one race/
      );
    });
  });
});
