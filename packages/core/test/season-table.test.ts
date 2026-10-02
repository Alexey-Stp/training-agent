import { describe, it, expect } from 'vitest';
import { escapeHtml, formatSeasonTable, TrainingBlock, TrainingBlockType } from '../src/season';

function block(
  order: number,
  type: TrainingBlockType,
  startDate: string,
  weeks: number
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus: 'test',
    targetWeeklyHours: 9.5,
    targetSwimM: 3750,
    targetBikeH: 5.25,
    targetRunKm: 21.6,
    targetCtl: null,
  };
}

describe('formatSeasonTable', () => {
  const table = formatSeasonTable([
    block(2, TrainingBlockType.build, '2026-11-30', 4),
    block(1, TrainingBlockType.base, '2026-10-05', 8),
  ]);
  const lines = table.split('\n');

  it('has a header and one row per block, in block order', () => {
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^# Type\s+Dates\s+Wk h\/wk Swim\s+Bike\s+Run$/);
    expect(lines[1]).toMatch(/^1 base/);
    expect(lines[2]).toMatch(/^2 build/);
  });

  it('shows start and inclusive end dates, weeks and weekly targets', () => {
    expect(lines[1]).toContain('05.10-29.11');
    expect(lines[2]).toContain('30.11-27.12');
    expect(lines[1]).toMatch(/\b8\s+9\.5\s+3\.8k\s+5\.3h\s+22km$/);
  });

  it('aligns columns', () => {
    const at = (line: string, text: string) => line.indexOf(text);
    expect(at(lines[1], '05.10')).toBe(at(lines[0], 'Dates'));
    expect(lines[1].indexOf('km') + 2).toBe(lines[2].indexOf('km') + 2);
  });
});

describe('escapeHtml', () => {
  it('escapes the characters Telegram HTML parse mode reserves', () => {
    expect(escapeHtml('Tom & Jerry <Half>')).toBe('Tom &amp; Jerry &lt;Half&gt;');
  });
});
