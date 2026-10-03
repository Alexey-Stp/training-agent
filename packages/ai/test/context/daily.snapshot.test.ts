import { describe, expect, it } from 'vitest';
import { buildDailyContext } from '../../src';
import {
  DATE,
  fakeDeps,
  fatiguedAthlete,
  freshAthlete,
  preRaceAthlete,
  USER_ID,
  type AthleteFixture,
} from './fixtures';

const FIXTURES: [string, () => AthleteFixture][] = [
  ['fresh', freshAthlete],
  ['fatigued', fatiguedAthlete],
  ['pre-race', preRaceAthlete],
];

describe('daily-v1 prompt snapshots', () => {
  it.each(FIXTURES)('renders the %s athlete', async (name, fixture) => {
    const { prompt, context } = await buildDailyContext(fakeDeps(fixture()), USER_ID, DATE);
    expect(context.truncation.overBudget).toBe(false);
    await expect(prompt).toMatchFileSnapshot('./__snapshots__/daily-' + name + '.md');
  });
});
