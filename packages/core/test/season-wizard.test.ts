import { describe, it, expect } from 'vitest';
import {
  isWeakSportChoice,
  parseSeasonDecision,
  parseWeeklyHours,
  seasonDecisionData,
} from '../src/season-wizard';

const DRAFT_ID = 'cmg1x2y3z0000abcd1234efgh';

describe('season decision callback data', () => {
  it('round-trips every decision', () => {
    for (const decision of ['save', 'replace', 'cancel'] as const) {
      expect(parseSeasonDecision(seasonDecisionData(decision, DRAFT_ID))).toEqual({
        decision,
        draftId: DRAFT_ID,
      });
    }
  });

  it('fits Telegram callback data (64 bytes)', () => {
    expect(Buffer.byteLength(seasonDecisionData('replace', 'x'.repeat(40)))).toBeLessThanOrEqual(
      64
    );
  });

  it('rejects other data', () => {
    for (const data of [
      '',
      'sd',
      'sd:save',
      'sd:save:',
      'sd:delete:abc',
      'xx:save:abc',
      'sd:save:abc:extra',
      'sd:save:ab-c',
      `sd:save:${'x'.repeat(41)}`,
      'sn:h:10',
    ]) {
      expect(parseSeasonDecision(data)).toBeNull();
    }
  });
});

describe('parseWeeklyHours', () => {
  it('accepts whole and half hours within 3..30, with an optional h', () => {
    expect(parseWeeklyHours('10')).toBe(10);
    expect(parseWeeklyHours(' 12h ')).toBe(12);
    expect(parseWeeklyHours('7.5')).toBe(7.5);
    expect(parseWeeklyHours('7,5 H')).toBe(7.5);
    expect(parseWeeklyHours('3')).toBe(3);
    expect(parseWeeklyHours('30')).toBe(30);
  });

  it('rejects anything else', () => {
    for (const value of ['', 'ten', '2', '31', '-5', '10.25', '1e1', '10 hours', '100']) {
      expect(parseWeeklyHours(value)).toBeNull();
    }
  });
});

describe('isWeakSportChoice', () => {
  it('knows the four answers', () => {
    expect(['swim', 'bike', 'run', 'none'].every(isWeakSportChoice)).toBe(true);
    expect(isWeakSportChoice('strength')).toBe(false);
    expect(isWeakSportChoice('Bike')).toBe(false);
  });
});
