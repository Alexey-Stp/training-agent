import { describe, it, expect } from 'vitest';
import { checkInData, coachDecisionData, seasonDecisionData } from '@triathlon/core';
import { checkInJobId, routeCheckIn } from '../src/checkin-callbacks';

describe('routeCheckIn', () => {
  it('maps a readiness button to checkin_answer', () => {
    expect(routeCheckIn(checkInData('r', 4))).toEqual({
      commandName: 'checkin_answer',
      args: ['r', '4'],
      toast: 'Saved',
    });
  });

  it('maps a soreness button to checkin_answer', () => {
    expect(routeCheckIn(checkInData('s', 2))).toMatchObject({ args: ['s', '2'] });
  });

  it('ignores other buttons', () => {
    expect(routeCheckIn(coachDecisionData('apply', 'abc'))).toBeNull();
    expect(routeCheckIn(seasonDecisionData('save', 'abc'))).toBeNull();
    expect(routeCheckIn('ci:r:9')).toBeNull();
  });
});

describe('checkInJobId', () => {
  it('differs per button on the same message', () => {
    const readiness = routeCheckIn(checkInData('r', 4));
    const soreness = routeCheckIn(checkInData('s', 1));
    if (!readiness || !soreness) throw new Error('not routed');
    expect(checkInJobId(42, 777, readiness)).toBe('cb-42-777-r4');
    expect(checkInJobId(42, 777, soreness)).toBe('cb-42-777-s1');
  });
});
