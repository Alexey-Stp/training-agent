import { describe, expect, it } from 'vitest';
import { buildBlockPrompt } from '../../src';
import { blockInput } from './fixtures';

describe('block-v1 prompt', () => {
  it.each([
    ['under-compliance', 70],
    ['compliant', 98],
  ])('renders the %s block', async (name, pct) => {
    const prompt = buildBlockPrompt(blockInput(pct));
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    await expect(prompt).toMatchFileSnapshot('./__snapshots__/block-' + name + '.md');
  });

  it('renders a race move without a valid re-projection', () => {
    const prompt = buildBlockPrompt(
      blockInput(90, {
        trigger: 'race_move',
        previousRaceDate: '2026-11-15',
        proposed: null,
        proposalIssue: 'race 2026-10-10 leaves 0 whole weeks',
      })
    );
    expect(prompt).toContain('moved the A-race from 2026-11-15 to 2026-11-15');
    expect(prompt).toContain('No re-projection is possible: race 2026-10-10 leaves 0 whole weeks.');
  });

  it('is byte-stable for the same input', () => {
    expect(buildBlockPrompt(blockInput(70))).toBe(buildBlockPrompt(blockInput(70)));
  });
});
