import { describe, it, expect } from 'vitest';
import type { RulesContext } from '@triathlon/core';
import type { HrvBaseline } from '@triathlon/ai';
import { readinessVerdict } from '../src/daily-loop/readiness';

type Wellness = NonNullable<RulesContext['todayWellness']>;

function wellness(overrides: Partial<Wellness> = {}): Wellness {
  return {
    subjectiveReadiness: null,
    sleepScore: null,
    hrv: null,
    restingHr: null,
    tsb: null,
    ...overrides,
  };
}

function hrv(low: boolean): HrvBaseline {
  return { status: 'ok', samples: 20, mean: 60, sd: 5, today: low ? 50 : 62, low };
}

describe('readinessVerdict', () => {
  it('is red on a low check-in, like ReadinessDownshift', () => {
    expect(readinessVerdict(wellness({ subjectiveReadiness: 2 }), hrv(false))).toEqual({
      emoji: '🔴',
      sentence: 'Low readiness (2/5): keep today easy.',
    });
  });

  it('is red when HRV is low and fatigue is high', () => {
    expect(readinessVerdict(wellness({ tsb: -25 }), hrv(true)).emoji).toBe('🔴');
  });

  it('is yellow when HRV is low', () => {
    expect(readinessVerdict(wellness({ subjectiveReadiness: 4 }), hrv(true))).toEqual({
      emoji: '🟡',
      sentence: 'HRV is below your 30-day baseline: listen to your body today.',
    });
  });

  it('is yellow when fatigue builds', () => {
    expect(readinessVerdict(wellness({ tsb: -24.6 }), null)).toEqual({
      emoji: '🟡',
      sentence: 'Fatigue is building (form −25): keep the easy sessions easy.',
    });
  });

  it('is yellow on a so-so check-in', () => {
    expect(readinessVerdict(wellness({ subjectiveReadiness: 3 }), null).emoji).toBe('🟡');
  });

  it('is green with good data', () => {
    expect(readinessVerdict(wellness({ subjectiveReadiness: 4, tsb: 5 }), hrv(false))).toEqual({
      emoji: '🟢',
      sentence: 'Recovered: good to train as planned.',
    });
  });

  it('is neutral without any data', () => {
    expect(readinessVerdict(undefined, null).emoji).toBe('⚪');
    expect(readinessVerdict(wellness({ sleepScore: 80 }), null).emoji).toBe('⚪');
  });
});
