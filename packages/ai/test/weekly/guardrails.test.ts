import { Intensity } from '@triathlon/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEEKLY_GUARDRAIL_CONFIG,
  expandBlockAdjustment,
  runWeeklyGuardrails,
  weeklyAction,
  type CoachPlanSession,
  type SessionDiff,
  type WeeklyGuardrailInput,
} from '../../src';
import {
  FULL_CATCH_UP,
  NEXT_LONG_RIDE,
  NEXT_LONG_RUN,
  nextWeek,
  PARTIAL_CATCH_UP,
  REVIEW_DATE,
  reviewedWeekContext,
} from './fixtures';

function input(overrides: Partial<WeeklyGuardrailInput> = {}): WeeklyGuardrailInput {
  return {
    date: REVIEW_DATE,
    sessions: nextWeek(),
    context: reviewedWeekContext(),
    changes: [],
    blockAdjustment: null,
    ...overrides,
  };
}

const total = (sessions: CoachPlanSession[]) => sessions.reduce((sum, s) => sum + s.durationMin, 0);

describe('runWeeklyGuardrails', () => {
  it('accepts a partial catch-up within the ramp cap', () => {
    const result = runWeeklyGuardrails(input({ changes: [PARTIAL_CATCH_UP] }));
    expect(result.verdict).toBe('accept');
    expect(result.changes).toEqual([PARTIAL_CATCH_UP]);
    expect(total(result.sessions)).toBe(645);
  });

  it('rejects a catch-up over the ramp cap even when the weekly load cap allows it', () => {
    const result = runWeeklyGuardrails(
      input({ changes: [FULL_CATCH_UP], context: reviewedWeekContext(1000) })
    );
    expect(result.verdict).toBe('reject');
    expect(result.changes).toEqual([]);
    expect(result.reasons).toEqual([
      'Next week would grow by 180 min to 780 min: catch-up exceeds the 8% ramp cap (648 min)',
    ]);
    expect(total(result.sessions)).toBe(600);
  });

  it('rejects a catch-up the weekly load cap forbids', () => {
    const result = runWeeklyGuardrails(input({ changes: [FULL_CATCH_UP] }));
    expect(result.verdict).toBe('reject');
    expect(result.reasons.join('\n')).toContain('660');
  });

  it('honours a configured ramp cap', () => {
    const config = { ...DEFAULT_WEEKLY_GUARDRAIL_CONFIG, maxRamp: 0.05 };
    const result = runWeeklyGuardrails(input({ changes: [PARTIAL_CATCH_UP] }), config);
    expect(result.verdict).toBe('reject');
  });

  it('rejects changes and a block adjustment together', () => {
    const result = runWeeklyGuardrails(
      input({
        changes: [PARTIAL_CATCH_UP],
        blockAdjustment: { kind: 'scale_volume', factor: 0.9, reason: 'tired' },
      })
    );
    expect(result.verdict).toBe('reject');
    expect(result.reasons[0]).toMatch(/not both/);
  });

  it('keeps the daily integrity checks: a stale before value rejects', () => {
    const stale: SessionDiff = { ...PARTIAL_CATCH_UP, before: 180 };
    expect(runWeeklyGuardrails(input({ changes: [stale] })).verdict).toBe('reject');
  });

  it('clamps a cut over 50% instead of cancelling', () => {
    const cut: SessionDiff = {
      sessionId: NEXT_LONG_RUN,
      field: 'durationMin',
      before: 135,
      after: 0,
    };
    const result = runWeeklyGuardrails(input({ changes: [cut] }));
    expect(result.verdict).toBe('clamp');
    expect(result.changes).toEqual([{ ...cut, after: 70 }]);
  });

  it('turns a block adjustment into duration changes', () => {
    const result = runWeeklyGuardrails(
      input({ blockAdjustment: { kind: 'scale_volume', factor: 0.8, reason: 'recovery' } })
    );
    expect(result.verdict).toBe('accept');
    expect(result.changes).toHaveLength(6);
    expect(total(result.sessions)).toBeLessThan(600);
  });
});

describe('expandBlockAdjustment', () => {
  it('rounds towards the original so the week stays within the factor', () => {
    const up = expandBlockAdjustment(
      { kind: 'scale_volume', factor: 1.08, reason: 'catch up' },
      nextWeek(),
      REVIEW_DATE
    );
    const sessions = nextWeek();
    const added = up.reduce(
      (sum, d) => sum + (d.field === 'durationMin' ? d.after - d.before : 0),
      0
    );
    expect(added).toBeLessThanOrEqual(total(sessions) * 0.08);
    expect(up.find((d) => d.sessionId === NEXT_LONG_RIDE)).toEqual({
      sessionId: NEXT_LONG_RIDE,
      field: 'durationMin',
      before: 210,
      after: 225,
    });
  });

  it('skips locked sessions and sessions before today', () => {
    const sessions = nextWeek();
    sessions[0].status = 'modified_externally';
    const diffs = expandBlockAdjustment(
      { kind: 'scale_volume', factor: 0.7, reason: 'r' },
      sessions,
      '2026-10-07'
    );
    expect(diffs.map((d) => d.sessionId)).toEqual([
      '2026-10-07/run-1',
      '2026-10-08/run-1',
      NEXT_LONG_RIDE,
      NEXT_LONG_RUN,
    ]);
  });
});

describe('weeklyAction', () => {
  it('names the change for the decision log', () => {
    expect(weeklyAction([])).toBe('keep');
    expect(weeklyAction([PARTIAL_CATCH_UP])).toBe('adjust');
    expect(weeklyAction([{ ...PARTIAL_CATCH_UP, after: 180 }])).toBe('reduce');
    expect(
      weeklyAction([
        {
          sessionId: NEXT_LONG_RIDE,
          field: 'intensity',
          before: Intensity.z2,
          after: Intensity.z3,
        },
      ])
    ).toBe('adjust');
    expect(
      weeklyAction([
        { sessionId: NEXT_LONG_RIDE, field: 'date', before: '2026-10-10', after: '2026-10-11' },
      ])
    ).toBe('move');
  });
});
