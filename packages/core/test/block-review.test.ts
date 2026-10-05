import { describe, it, expect } from 'vitest';
import { blockReviewData, parseBlockReview } from '../src/block-review';
import { formatBlockDiff, TrainingBlock, TrainingBlockType } from '../src/season';

describe('block review callback data', () => {
  it('round-trips confirm and decline', () => {
    expect(blockReviewData('confirm', 'clx1abc')).toBe('br:c:clx1abc');
    expect(parseBlockReview('br:c:clx1abc')).toEqual({ answer: 'confirm', runId: 'clx1abc' });
    expect(parseBlockReview(blockReviewData('decline', 'r1'))).toEqual({
      answer: 'decline',
      runId: 'r1',
    });
  });

  it('rejects other data', () => {
    expect(parseBlockReview('cc:a:clx1abc')).toBeNull();
    expect(parseBlockReview('br:x:clx1abc')).toBeNull();
    expect(parseBlockReview('br:c:')).toBeNull();
    expect(parseBlockReview('br:c:a:b')).toBeNull();
    expect(parseBlockReview('br:c:' + 'a'.repeat(41))).toBeNull();
  });

  it('stays under 64 bytes for a cuid', () => {
    expect(Buffer.byteLength(blockReviewData('decline', 'c'.repeat(40)))).toBeLessThan(64);
  });
});

function block(
  order: number,
  type: TrainingBlockType,
  startDate: string,
  weeks: number,
  hours: number
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus: '',
    targetWeeklyHours: hours,
    targetSwimM: 4000,
    targetBikeH: hours / 2,
    targetRunKm: 20,
    targetCtl: null,
  };
}

describe('formatBlockDiff', () => {
  const old = [
    block(1, TrainingBlockType.base, '2026-09-07', 4, 8),
    block(2, TrainingBlockType.build, '2026-10-05', 4, 10),
    block(3, TrainingBlockType.taper, '2026-11-02', 1, 6),
  ];
  const fresh = [
    old[0],
    { ...old[1], targetWeeklyHours: 7 },
    { ...old[2], targetWeeklyHours: 4.5 },
  ];

  it('shows only the blocks after the freeze, before and after', () => {
    const diff = formatBlockDiff(old, fresh, '2026-10-04');
    expect(diff.before).toContain('build');
    expect(diff.before).not.toContain('base');
    expect(diff.after).toContain('7.0');
    expect(diff.summary).toBe('Next block: 10.0 → 7.0 h/wk · remaining 46.0 → 32.5 h');
  });
});
