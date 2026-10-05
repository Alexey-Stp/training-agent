import { describe, it, expect } from 'vitest';
import { coachDecisionData, isDecisionExpired, parseCoachDecision } from '../src/coach-chat';

const DECISION_ID = 'cmg1x2y3z0000abcd1234efgh';

describe('coach decision callback data', () => {
  it('round-trips every answer', () => {
    for (const answer of ['apply', 'keep', 'discuss'] as const) {
      expect(parseCoachDecision(coachDecisionData(answer, DECISION_ID))).toEqual({
        answer,
        decisionId: DECISION_ID,
      });
    }
  });

  it('fits Telegram callback data (64 bytes)', () => {
    expect(Buffer.byteLength(coachDecisionData('apply', 'x'.repeat(40)))).toBeLessThanOrEqual(64);
  });

  it('rejects other data', () => {
    for (const data of [
      '',
      'cc',
      'cc:a',
      'cc:a:',
      'cc:x:abc',
      'sd:a:abc',
      'cc:a:abc:extra',
      'cc:k:ab-c',
      `cc:a:${'x'.repeat(41)}`,
      'sd:save:abc',
    ]) {
      expect(parseCoachDecision(data)).toBeNull();
    }
  });

  it('uses d for Discuss', () => {
    expect(coachDecisionData('discuss', DECISION_ID)).toBe('cc:d:' + DECISION_ID);
  });
});

describe('isDecisionExpired', () => {
  const issued = new Date('2026-10-05T06:30:00Z');

  it('keeps buttons alive up to the TTL', () => {
    expect(isDecisionExpired(issued, new Date('2026-10-06T06:30:00Z'), 24)).toBe(false);
  });

  it('expires them after the TTL', () => {
    expect(isDecisionExpired(issued, new Date('2026-10-06T06:30:01Z'), 24)).toBe(true);
    expect(isDecisionExpired(issued, new Date('2026-10-05T08:30:01Z'), 2)).toBe(true);
  });
});
