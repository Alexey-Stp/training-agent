import { describe, it, expect } from 'vitest';
import { coachDecisionData, parseCoachDecision } from '../src/coach-chat';

const DECISION_ID = 'cmg1x2y3z0000abcd1234efgh';

describe('coach decision callback data', () => {
  it('round-trips both answers', () => {
    for (const answer of ['apply', 'keep'] as const) {
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
});
