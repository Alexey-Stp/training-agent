import { describe, expect, it } from 'vitest';
import { buildDailyContext, estimateTokens } from '../../src';
import { DATE, fakeDeps, fatiguedAthlete, preRaceAthlete, USER_ID } from './fixtures';

const build = (tokenBudget: number) =>
  buildDailyContext(fakeDeps(fatiguedAthlete()), USER_ID, DATE, { tokenBudget });

describe('token budget', () => {
  it('estimates about 4 characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('leaves a prompt under budget untouched', async () => {
    const { prompt, context } = await build(100_000);
    expect(context.truncation).toEqual({
      budgetTokens: 100_000,
      estimatedTokens: estimateTokens(prompt),
      historyDaysOmitted: 0,
      decisionsOmitted: 0,
      trendDaysOmitted: 0,
      overBudget: false,
    });
    expect(prompt).not.toContain('omitted for the token budget');
  });

  it('drops the oldest history days first', async () => {
    const full = await build(100_000);
    const { prompt, context } = await build(full.context.truncation.estimatedTokens - 50);

    expect(context.truncation.historyDaysOmitted).toBeGreaterThan(0);
    expect(context.truncation.decisionsOmitted).toBe(0);
    expect(context.truncation.trendDaysOmitted).toBe(0);
    expect(context.history[0].date > full.context.history[0].date).toBe(true);
    expect(context.history.at(-1)?.date).toBe('2026-10-02');
    expect(prompt).toMatch(/\(\d+ older days omitted for the token budget\)/);
    expect(context.truncation.estimatedTokens).toBeLessThanOrEqual(context.truncation.budgetTokens);
  });

  it('truncates history, then decisions, then the wellness trend, never the protected sections', async () => {
    const full = await build(100_000);
    const budgets = Array.from(
      { length: 60 },
      (_, i) => full.context.truncation.estimatedTokens - (i + 1) * 30
    ).filter((b) => b > 0);
    const results = await Promise.all(budgets.map(build));

    for (const { prompt, context } of results) {
      const t = context.truncation;
      if (t.decisionsOmitted > 0) expect(context.history).toEqual([]);
      if (t.trendDaysOmitted > 0) expect(context.decisions).toEqual([]);
      if (!t.overBudget) expect(t.estimatedTokens).toBeLessThanOrEqual(t.budgetTokens);
      expect(prompt).toContain('VO2 5x4'); // missed key session
      expect(prompt).toContain('Lake Half'); // A-race
      expect(prompt).toContain('moved to 2026-10-05'); // externally modified
      expect(prompt).toContain('2026-10-06 Tue'); // last upcoming day
      expect(prompt).toContain('Today: HRV 52 ms');
    }
    expect(results.some((r) => r.context.truncation.decisionsOmitted > 0)).toBe(true);
    expect(results.some((r) => r.context.truncation.trendDaysOmitted > 0)).toBe(true);
  });

  it('flags a prompt that is still over budget once everything truncatable is gone', async () => {
    const { prompt, context } = await buildDailyContext(fakeDeps(preRaceAthlete()), USER_ID, DATE, {
      tokenBudget: 10,
    });
    expect(context.truncation).toMatchObject({
      overBudget: true,
      historyDaysOmitted: 14,
      decisionsOmitted: 3,
      trendDaysOmitted: 7,
    });
    expect(context.history).toEqual([]);
    expect(prompt).toContain('Regional Olympic');
    expect(prompt).toContain('Season Closer Sprint');
    expect(prompt).toContain('taper (focus: freshen up), week 2 of 2');
  });
});
