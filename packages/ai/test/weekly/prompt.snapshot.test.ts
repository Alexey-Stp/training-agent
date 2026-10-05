import { describe, expect, it } from 'vitest';
import { buildWeeklyPrompt } from '../../src';
import { compliantWeek, missedLongRideWeek, reviewInput } from './fixtures';

describe('weekly-v1 prompt', () => {
  it.each([
    ['missed-long-ride', missedLongRideWeek],
    ['compliant', compliantWeek],
  ])('renders the %s week', async (name, stats) => {
    const prompt = buildWeeklyPrompt(reviewInput(stats()));
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    await expect(prompt).toMatchFileSnapshot('./__snapshots__/weekly-' + name + '.md');
  });

  it('is byte-stable for the same input', () => {
    const input = reviewInput(missedLongRideWeek());
    expect(buildWeeklyPrompt(input)).toBe(
      buildWeeklyPrompt({ ...input, sessions: [...input.sessions].reverse() })
    );
  });
});
