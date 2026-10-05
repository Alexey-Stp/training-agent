import { describe, it, expect } from 'vitest';
import { isoWeekKey, isoWeekRange, nextIsoWeek, previousIsoWeek } from '../src/reviews/iso-week';

describe('isoWeekKey', () => {
  it('numbers a mid-year date', () => {
    expect(isoWeekKey('2026-10-05')).toBe('2026-W41');
    expect(isoWeekKey('2026-10-04')).toBe('2026-W40');
  });

  it('uses the ISO week-numbering year at year boundaries', () => {
    expect(isoWeekKey('2026-12-31')).toBe('2026-W53');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2027-01-04')).toBe('2027-W01');
    expect(isoWeekKey('2025-12-29')).toBe('2026-W01');
  });
});

describe('isoWeekRange', () => {
  it('returns Monday to Sunday', () => {
    expect(isoWeekRange('2026-W40')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(isoWeekRange('2026-W01')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect(isoWeekRange('2026-W53')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('round-trips with isoWeekKey', () => {
    const { from, to } = isoWeekRange('2027-W10');
    expect(isoWeekKey(from)).toBe('2027-W10');
    expect(isoWeekKey(to)).toBe('2027-W10');
  });

  it('rejects malformed keys and weeks the year lacks', () => {
    expect(() => isoWeekRange('2026-40')).toThrow(/Invalid ISO week/);
    expect(() => isoWeekRange('2026-W00')).toThrow(/Invalid ISO week/);
    expect(() => isoWeekRange('2025-W53')).toThrow(/Invalid ISO week/);
  });
});

describe('previousIsoWeek', () => {
  it('is the week before the one containing the date', () => {
    expect(previousIsoWeek('2026-10-05')).toBe('2026-W40');
    expect(previousIsoWeek('2026-10-11')).toBe('2026-W40');
    expect(previousIsoWeek('2027-01-06')).toBe('2026-W53');
  });
});

describe('nextIsoWeek', () => {
  it('is the week after the one containing the date', () => {
    expect(nextIsoWeek('2026-10-04')).toBe('2026-W41');
    expect(nextIsoWeek('2026-09-28')).toBe('2026-W41');
    expect(nextIsoWeek('2026-12-27')).toBe('2026-W53');
    expect(nextIsoWeek('2027-01-03')).toBe('2027-W01');
  });
});
