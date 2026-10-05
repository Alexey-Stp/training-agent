import { describe, it, expect } from 'vitest';
import { coachDecisionData, seasonDecisionData } from '@triathlon/core';
import { routeCoachDecision } from '../src/coach-callbacks';

const DECISION = 'cmg1x2y3z0000abcd1234efgh';

describe('routeCoachDecision', () => {
  it('apply enqueues coach_apply for the decision', () => {
    expect(routeCoachDecision(coachDecisionData('apply', DECISION))).toMatchObject({
      commandName: 'coach_apply',
      args: [DECISION],
    });
  });

  it('keep enqueues coach_keep for the decision', () => {
    expect(routeCoachDecision(coachDecisionData('keep', DECISION))).toMatchObject({
      commandName: 'coach_keep',
      args: [DECISION],
    });
  });

  it('discuss enqueues coach_discuss for the decision', () => {
    expect(routeCoachDecision(coachDecisionData('discuss', DECISION))).toMatchObject({
      commandName: 'coach_discuss',
      args: [DECISION],
    });
  });

  it('ignores other buttons', () => {
    expect(routeCoachDecision(seasonDecisionData('save', DECISION))).toBeNull();
    expect(routeCoachDecision('sn:h:10')).toBeNull();
  });
});
