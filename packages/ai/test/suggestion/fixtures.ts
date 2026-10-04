import { Intensity, Sport, type RulesContext } from '@triathlon/core';
import {
  MockProvider,
  sessionKey,
  type CoachDecisionRecord,
  type CoachDecisionSink,
  type CoachPlanSession,
  type CoachSuggestion,
  type SessionDiff,
} from '../../src';

/** A Monday */
export const TODAY = '2026-10-05';
export const USER_ID = 'user-1';
export const DAILY_PROMPT = '# Daily coaching context: 2026-10-05\n\n(context)\n';

// Same shape as the rules-engine fixtures in packages/core/test/rules-engine.test.ts
export const NO_HISTORY: RulesContext = { last7dStats: { totalMinutes: 0, byDate: [] } };

export function readiness(subjectiveReadiness: number): RulesContext {
  return {
    ...NO_HISTORY,
    todayWellness: { subjectiveReadiness, sleepScore: null, hrv: null, restingHr: null, tsb: null },
  };
}

export function lastWeekMinutes(totalMinutes: number): RulesContext {
  return { last7dStats: { totalMinutes, byDate: [] } };
}

function session(
  date: string,
  sport: Sport,
  intensity: Intensity,
  durationMin: number,
  title: string
): CoachPlanSession {
  const slot = sport + '-1';
  return {
    id: sessionKey({ date, slot }),
    date,
    slot,
    sport,
    title,
    durationMin,
    intensity,
    status: 'pushed',
  };
}

export function hard(
  date: string,
  sport: Sport,
  durationMin = 60,
  title = 'Hard'
): CoachPlanSession {
  return session(date, sport, Intensity.z4, durationMin, title);
}

export function easy(
  date: string,
  sport: Sport,
  durationMin = 60,
  title = 'Easy'
): CoachPlanSession {
  return session(date, sport, Intensity.z2, durationMin, title);
}

/** Mon..Sun with no hard-hard pair; Friday is a rest day. 380 min in total. */
export function week(): CoachPlanSession[] {
  return [
    easy('2026-10-05', Sport.swim, 45, 'Aerobic swim'),
    hard('2026-10-06', Sport.bike, 60, 'VO2 5x4'),
    easy('2026-10-07', Sport.run, 45, 'Easy run'),
    hard('2026-10-08', Sport.run, 50, 'Threshold run'),
    easy('2026-10-10', Sport.bike, 120, 'Long ride'),
    easy('2026-10-11', Sport.run, 60, 'Long run'),
  ];
}

export const MON_SWIM = '2026-10-05/swim-1';
export const TUE_BIKE = '2026-10-06/bike-1';
export const WED_RUN = '2026-10-07/run-1';
export const THU_RUN = '2026-10-08/run-1';
export const SAT_BIKE = '2026-10-10/bike-1';

export function suggestion(
  changes: SessionDiff[],
  overrides: Partial<CoachSuggestion> = {}
): CoachSuggestion {
  return {
    assessment: 'Fatigue is building after a big weekend.',
    action: 'reduce',
    changes,
    confidence: 0.8,
    athleteMessage: 'Take it a bit easier this week.',
    ...overrides,
  };
}

export const REDUCE_SAT: SessionDiff = {
  sessionId: SAT_BIKE,
  field: 'durationMin',
  before: 120,
  after: 90,
};

/** Moves the threshold run next to Tuesday's VO2 ride */
export const HARD_HARD_MOVE: SessionDiff = {
  sessionId: THU_RUN,
  field: 'date',
  before: '2026-10-08',
  after: '2026-10-07',
};

/** A provider that plays back `replies` in order; an Error reply is thrown. */
export function scripted(...replies: (string | Error)[]): MockProvider {
  const queue = [...replies];
  return new MockProvider({
    respond: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('No scripted reply left');
      if (next instanceof Error) throw next;
      return next;
    },
  });
}

export class FakeDecisionSink implements CoachDecisionSink {
  readonly records: CoachDecisionRecord[] = [];

  write(record: CoachDecisionRecord): Promise<string> {
    this.records.push(record);
    return Promise.resolve('decision-' + this.records.length.toString());
  }
}
