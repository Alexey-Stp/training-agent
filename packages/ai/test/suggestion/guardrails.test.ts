import { Intensity, Sport } from '@triathlon/core';
import { describe, expect, it } from 'vitest';
import {
  deterministicRecommendation,
  runGuardrails,
  type CoachPlanSession,
  type GuardrailInput,
  type SessionDiff,
} from '../../src';
import {
  easy,
  hard,
  HARD_HARD_MOVE,
  lastWeekMinutes,
  MON_SWIM,
  NO_HISTORY,
  readiness,
  REDUCE_SAT,
  SAT_BIKE,
  suggestion,
  TODAY,
  TUE_BIKE,
  WED_RUN,
  week,
} from './fixtures';

function input(changes: SessionDiff[], overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    date: TODAY,
    sessions: week(),
    context: NO_HISTORY,
    suggestion: suggestion(changes),
    ...overrides,
  };
}

function find(sessions: CoachPlanSession[], id: string): CoachPlanSession | undefined {
  return sessions.find((s) => s.id === id);
}

describe('runGuardrails', () => {
  it('accepts a safe reduction and applies it', () => {
    const result = runGuardrails(input([REDUCE_SAT]));

    expect(result).toMatchObject({ verdict: 'accept', reasons: [], changes: [REDUCE_SAT] });
    expect(find(result.sessions, SAT_BIKE)?.durationMin).toBe(90);
  });

  it('clamps an 80% reduction to 50%', () => {
    const cut: SessionDiff = { sessionId: TUE_BIKE, field: 'durationMin', before: 60, after: 12 };
    const result = runGuardrails(input([cut]));

    expect(result.verdict).toBe('clamp');
    expect(result.changes).toEqual([{ ...cut, after: 30 }]);
    expect(result.reasons).toEqual([
      'bike "VO2 5x4" 2026-10-06 cut to 30 min, not 12: one change never removes more than 50% of a session',
    ]);
    expect(find(result.sessions, TUE_BIKE)?.durationMin).toBe(30);
  });

  it('rounds the clamped duration up to 5 minutes', () => {
    const cut: SessionDiff = { sessionId: WED_RUN, field: 'durationMin', before: 45, after: 10 };
    expect(runGuardrails(input([cut])).changes).toEqual([{ ...cut, after: 25 }]);
  });

  it('lets action rest cancel a session but clamps a cancel under any other action', () => {
    const cancel: SessionDiff = { sessionId: TUE_BIKE, field: 'durationMin', before: 60, after: 0 };
    const rest = runGuardrails({
      ...input([]),
      suggestion: suggestion([cancel], { action: 'rest' }),
    });
    expect(rest).toMatchObject({ verdict: 'accept', changes: [cancel] });

    expect(runGuardrails(input([cancel])).changes).toEqual([{ ...cancel, after: 30 }]);
  });

  it('rejects a move that creates hard sessions on consecutive days', () => {
    const result = runGuardrails(input([HARD_HARD_MOVE]));

    expect(result.verdict).toBe('reject');
    expect(result.changes).toEqual([]);
    expect(result.reasons).toEqual(['Hard sessions on consecutive days (2026-10-06, 2026-10-07)']);
    expect(result.sessions).toEqual(week());
  });

  it('rejects an intensity upgrade that creates hard-hard days', () => {
    const upgrade: SessionDiff = {
      sessionId: WED_RUN,
      field: 'intensity',
      before: Intensity.z2,
      after: Intensity.z4,
    };
    const result = runGuardrails(input([upgrade]));
    expect(result.verdict).toBe('reject');
    expect(result.reasons).toHaveLength(2);
  });

  it('rejects moving a hard session onto today when readiness is low', () => {
    const move: SessionDiff = {
      sessionId: TUE_BIKE,
      field: 'date',
      before: '2026-10-06',
      after: TODAY,
    };
    const result = runGuardrails(input([move], { context: readiness(2) }));
    expect(result.verdict).toBe('reject');
    expect(result.reasons).toEqual(['Hard session on 2026-10-05 despite low readiness (2/5)']);
  });

  it('drops a move onto a rest day', () => {
    const move: SessionDiff = {
      sessionId: WED_RUN,
      field: 'date',
      before: '2026-10-07',
      after: '2026-10-09',
    };
    const result = runGuardrails(input([move, REDUCE_SAT]));

    expect(result.verdict).toBe('clamp');
    expect(result.changes).toEqual([REDUCE_SAT]);
    expect(result.reasons).toEqual([
      'run "Easy run" 2026-10-07 stays on 2026-10-07: 2026-10-09 is a rest day',
    ]);
  });

  it('drops a sport change that turns a rest placeholder into training', () => {
    const restDay: CoachPlanSession = {
      ...easy('2026-10-09', Sport.rest, 0, 'Rest'),
      id: '2026-10-09/rest-1',
      slot: 'rest-1',
    };
    const toRun: SessionDiff = {
      sessionId: restDay.id,
      field: 'sport',
      before: Sport.rest,
      after: Sport.run,
    };
    const result = runGuardrails(input([toRun], { sessions: [...week(), restDay] }));
    expect(result).toMatchObject({ verdict: 'clamp', changes: [] });
  });

  it('drops intensity increases at readiness 2 but not at 3', () => {
    const upgrade: SessionDiff = {
      sessionId: SAT_BIKE,
      field: 'intensity',
      before: Intensity.z2,
      after: Intensity.z3,
    };
    const low = runGuardrails(input([upgrade], { context: readiness(2) }));
    expect(low).toMatchObject({ verdict: 'clamp', changes: [] });
    expect(low.reasons[0]).toContain('no intensity increases while readiness is low (2/5)');

    const ok = runGuardrails(input([upgrade], { context: readiness(3) }));
    expect(ok).toMatchObject({ verdict: 'accept', changes: [upgrade] });
  });

  it.each<[string, SessionDiff, Partial<GuardrailInput>, string]>([
    [
      'an unknown session',
      { sessionId: '2026-10-09/swim-1', field: 'durationMin', before: 30, after: 20 },
      {},
      'Unknown session 2026-10-09/swim-1',
    ],
    [
      'a stale before value',
      { ...REDUCE_SAT, before: 150 },
      {},
      'Stale change to 2026-10-10/bike-1: durationMin is 120, not 150',
    ],
    [
      'a session before today',
      { sessionId: MON_SWIM, field: 'durationMin', before: 45, after: 30 },
      { date: '2026-10-06' },
      "2026-10-05/swim-1 is in the past and can't change",
    ],
    [
      'a move into the past',
      { sessionId: WED_RUN, field: 'date', before: '2026-10-07', after: '2026-10-04' },
      {},
      "2026-10-07/run-1 can't move into the past (2026-10-04)",
    ],
    [
      'a locked session',
      REDUCE_SAT,
      {
        sessions: week().map((s) =>
          s.id === SAT_BIKE ? { ...s, status: 'modified_externally' as const } : s
        ),
      },
      "2026-10-10/bike-1 is modified_externally and can't change",
    ],
  ])('rejects %s', (_label, diff, overrides, reason) => {
    const result = runGuardrails(input([diff], overrides));
    expect(result).toMatchObject({ verdict: 'reject', changes: [], reasons: [reason] });
  });

  it('rejects two changes to the same field of a session', () => {
    const result = runGuardrails(input([REDUCE_SAT, { ...REDUCE_SAT, after: 100 }]));
    expect(result.verdict).toBe('reject');
    expect(result.reasons).toContain('More than one change to 2026-10-10/bike-1 durationMin');
  });

  it('never mutates its input', () => {
    const sessions = week();
    const changes = [REDUCE_SAT, HARD_HARD_MOVE];
    runGuardrails(input([REDUCE_SAT], { sessions }));
    runGuardrails(input(changes, { sessions }));
    expect(sessions).toEqual(week());
    expect(changes).toEqual([REDUCE_SAT, HARD_HARD_MOVE]);
  });

  it('does not blame the LLM for a hard-hard pair the plan already had', () => {
    const sessions = [...week(), hard('2026-10-07', Sport.swim, 45, 'Swim intervals')];
    expect(runGuardrails(input([REDUCE_SAT], { sessions })).verdict).toBe('accept');
  });

  it('rejects making an over-cap week longer, but accepts shortening it', () => {
    // The week plans 380 min; the cap is 110% of 300 = 330
    const context = lastWeekMinutes(300);
    const longer: SessionDiff = { ...REDUCE_SAT, after: 150 };
    expect(runGuardrails(input([longer], { context })).verdict).toBe('reject');
    expect(runGuardrails(input([REDUCE_SAT], { context })).verdict).toBe('accept');
  });
});

describe('deterministicRecommendation', () => {
  it('keeps a plan the rules engine has nothing to change in', () => {
    expect(deterministicRecommendation(TODAY, week(), NO_HISTORY)).toEqual({
      action: 'keep',
      changes: [],
      notes: [],
    });
  });

  it("downgrades today's hard session when readiness is low", () => {
    const sessions = [hard(TODAY, Sport.bike, 60, 'VO2 5x4'), easy('2026-10-06', Sport.run)];
    const rec = deterministicRecommendation(TODAY, sessions, readiness(2));

    expect(rec.action).toBe('reduce');
    expect(rec.changes).toEqual([
      { sessionId: '2026-10-05/bike-1', field: 'intensity', before: 'z4', after: 'z2' },
    ]);
    expect(rec.notes[0]).toContain('Low readiness detected (2/5)');
  });

  it('downgrades the second of two consecutive hard days', () => {
    const sessions = [...week(), hard('2026-10-07', Sport.swim, 45, 'Swim intervals')];
    const rec = deterministicRecommendation(TODAY, sessions, NO_HISTORY);
    expect(rec.changes).toEqual([
      { sessionId: '2026-10-07/swim-1', field: 'intensity', before: 'z4', after: 'z2' },
    ]);
  });

  it('never proposes changes to locked or past sessions', () => {
    const sessions = [
      hard('2026-10-04', Sport.bike),
      { ...hard(TODAY, Sport.run), status: 'completed' as const },
    ];
    expect(deterministicRecommendation(TODAY, sessions, NO_HISTORY).changes).toEqual([]);
  });
});
