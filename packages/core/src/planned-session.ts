import { Intensity, Sport, WeekPlan } from './types';
import { buildWorkoutSteps, WorkoutBlock } from './workout';

/** A plan-generator session in PlannedSession shape (DB-managed and ICU fields excluded). */
export interface PlannedSessionDraft {
  date: string; // YYYY-MM-DD
  /** "<sport>-<n>": nth session of that sport on the date. Stable key across regenerations. */
  slot: string;
  sport: Sport;
  title: string;
  description: string | null;
  durationMin: number;
  intensity: Intensity;
  steps: WorkoutBlock[];
}

/** Converts the rules-applied week plan into PlannedSession rows. Rest days are not stored. */
export function toPlannedSessions(plan: WeekPlan): PlannedSessionDraft[] {
  const seen = new Map<string, number>();
  const drafts: PlannedSessionDraft[] = [];

  for (const s of plan.sessions) {
    if (s.sport === Sport.rest || s.durationMin <= 0) continue;

    const key = `${s.date}:${s.sport}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);

    drafts.push({
      date: s.date,
      slot: `${s.sport}-${n.toString()}`,
      sport: s.sport,
      title: s.title,
      description: s.notes ?? null,
      durationMin: s.durationMin,
      intensity: s.intensity,
      steps: buildWorkoutSteps(s),
    });
  }

  return drafts;
}
