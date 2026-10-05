import { describe, it, expect } from 'vitest';
import {
  SORENESS_LEVELS,
  checkInData,
  parseCheckInAnswer,
  parseCheckInData,
  sorenessLabel,
} from '../src/checkin';

describe('check-in callback data', () => {
  it('round-trips every readiness and soreness value', () => {
    for (const value of [1, 2, 3, 4, 5]) {
      expect(parseCheckInData(checkInData('r', value))).toEqual({ field: 'r', value });
    }
    for (const value of Object.values(SORENESS_LEVELS)) {
      expect(parseCheckInData(checkInData('s', value))).toEqual({ field: 's', value });
    }
  });

  it('formats as ci:<field>:<value>', () => {
    expect(checkInData('r', 4)).toBe('ci:r:4');
    expect(checkInData('s', SORENESS_LEVELS.mild)).toBe('ci:s:1');
  });

  it('rejects other data', () => {
    for (const data of [
      '',
      'ci',
      'ci:r',
      'ci:r:',
      'ci:r:0',
      'ci:r:6',
      'ci:s:3',
      'ci:x:1',
      'ci:r:1:extra',
      'ci:r:01',
      'ci:r:-1',
      'cc:a:abc',
      'sd:save:abc',
    ]) {
      expect(parseCheckInData(data)).toBeNull();
    }
  });

  it('validates job args the same way', () => {
    expect(parseCheckInAnswer('s', '2')).toEqual({ field: 's', value: 2 });
    expect(parseCheckInAnswer('s', undefined)).toBeNull();
    expect(parseCheckInAnswer(undefined, '2')).toBeNull();
  });
});

describe('sorenessLabel', () => {
  it('maps the stored scale', () => {
    expect(sorenessLabel(0)).toBe('none');
    expect(sorenessLabel(1)).toBe('mild');
    expect(sorenessLabel(2)).toBe('severe');
  });

  it('returns null for null and values off the scale', () => {
    expect(sorenessLabel(null)).toBeNull();
    expect(sorenessLabel(4)).toBeNull();
  });
});
