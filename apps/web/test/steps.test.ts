import { describe, expect, it } from 'vitest';
import { Intensity, type WorkoutBlock } from '@triathlon/core';
import { parseSteps, stepLine } from '../src/plan/steps';
import { formatMinutes, parseDateParam } from '../src/plan/dates';

const INTERVALS: WorkoutBlock[] = [
  { kind: 'warmup', durationMin: 15, zone: Intensity.z2 },
  {
    kind: 'repeat',
    count: 5,
    work: { durationMin: 3, zone: Intensity.z5 },
    rest: { durationMin: 3, zone: Intensity.z1 },
  },
  { kind: 'cooldown', durationMin: 10, zone: Intensity.z1 },
];

describe('parseSteps', () => {
  it('accepts stored WorkoutBlock JSON', () => {
    expect(parseSteps(JSON.parse(JSON.stringify(INTERVALS)))).toEqual(INTERVALS);
  });

  it.each([
    ['not an array', { kind: 'steady' }],
    ['an unknown kind', [{ kind: 'sprint', durationMin: 5, zone: 'z5' }]],
    ['a bad zone', [{ kind: 'steady', durationMin: 5, zone: 'z9' }]],
    ['a zero duration', [{ kind: 'steady', durationMin: 0, zone: 'z2' }]],
    ['a repeat without rest', [{ kind: 'repeat', count: 3, work: { durationMin: 1, zone: 'z4' } }]],
    ['null', null],
  ])('returns null for %s', (_label, json) => {
    expect(parseSteps(json)).toBeNull();
  });
});

describe('stepLine', () => {
  it('labels every block kind with zone and duration', () => {
    expect(INTERVALS.map(stepLine)).toEqual([
      { label: 'Warmup', detail: '15′ Z2' },
      { label: 'Main set', detail: '5 × 3′ Z5 / 3′ Z1 easy' },
      { label: 'Cooldown', detail: '10′ Z1' },
    ]);
  });
});

describe('date helpers', () => {
  it('accepts only real calendar dates', () => {
    expect(parseDateParam('2026-10-06')).toBe('2026-10-06');
    expect(parseDateParam('2026-02-30')).toBeNull();
    expect(parseDateParam('2026-10-6')).toBeNull();
    expect(parseDateParam(['2026-10-06'])).toBeNull();
    expect(parseDateParam(undefined)).toBeNull();
  });

  it('formats minutes', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(95)).toBe('1h 35m');
  });
});
