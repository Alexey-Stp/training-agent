import { describe, it, expect } from 'vitest';
import { Intensity, Sport } from '@triathlon/core';
import { describeSessionChanges, type SessionDiff } from '../../src';
import { hard, week } from './fixtures';

const VO2 = '2026-10-06/bike-1';
const THRESHOLD = '2026-10-08/run-1';

describe('describeSessionChanges', () => {
  it('puts all changes of one session on one line', () => {
    const sessions = [hard('2026-10-06', Sport.bike, 70, 'VO2')];
    const changes: SessionDiff[] = [
      { sessionId: VO2, field: 'durationMin', before: 70, after: 50 },
      { sessionId: VO2, field: 'intensity', before: Intensity.z5, after: Intensity.z3 },
    ];
    expect(describeSessionChanges(changes, sessions)).toEqual(['Bike VO2 70′→50′, Z5→Z3']);
  });

  it('keeps the order in which the changes first name each session', () => {
    const changes: SessionDiff[] = [
      { sessionId: THRESHOLD, field: 'date', before: '2026-10-08', after: '2026-10-09' },
      { sessionId: VO2, field: 'durationMin', before: 60, after: 0 },
      { sessionId: THRESHOLD, field: 'sport', before: Sport.run, after: Sport.bike },
    ];
    expect(describeSessionChanges(changes, week())).toEqual([
      'Run Threshold run moved to 2026-10-09, run→bike',
      'Bike VO2 5x4 cancelled',
    ]);
  });

  it('falls back to the session id for a session the plan lacks', () => {
    const changes: SessionDiff[] = [
      { sessionId: '2026-10-20/swim-0', field: 'durationMin', before: 45, after: 30 },
    ];
    expect(describeSessionChanges(changes, week())).toEqual(['2026-10-20/swim-0 45′→30′']);
  });

  it('is empty without changes', () => {
    expect(describeSessionChanges([], week())).toEqual([]);
  });
});
