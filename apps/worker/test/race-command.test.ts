import { describe, it, expect, beforeEach } from 'vitest';
import type { Profile } from '@prisma/client';
import { RacePriority, RaceType, type Race } from '@triathlon/core';
import {
  handleRace,
  MSG_RACE_USAGE,
  parseRaceAddArgs,
  type RaceCommandDeps,
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

describe('handleRace', () => {
  let stored: RaceRecord[];
  let deps: RaceCommandDeps;

  beforeEach(() => {
    stored = [];
    deps = {
      repo: {
        create: (_userId, race: Race) => {
          const record = { ...race, id: `r${(stored.length + 1).toString()}` };
          stored.push(record);
          return Promise.resolve(record);
        },
        listUpcoming: (_userId, fromDate) =>
          Promise.resolve(stored.filter((r) => r.date >= fromDate)),
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
});
