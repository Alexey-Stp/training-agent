import type { SessionDiff } from './schema';
import type { CoachPlanSession } from './types';

/** `bike "VO2 5x4" 2026-10-06`, or the bare id for a session the plan doesn't have. */
export function sessionLabel(id: string, sessions: readonly CoachPlanSession[]): string {
  const session = sessions.find((s) => s.id === id);
  if (!session) return id;
  return session.sport + ' "' + session.title + '" ' + session.date;
}

export function describeChange(diff: SessionDiff, sessions: readonly CoachPlanSession[]): string {
  const label = sessionLabel(diff.sessionId, sessions);
  switch (diff.field) {
    case 'durationMin':
      if (diff.after === 0) return label + ': cancelled';
      return `${label}: ${diff.before.toString()} → ${diff.after.toString()} min`;
    case 'intensity':
      return `${label}: ${diff.before.toUpperCase()} → ${diff.after.toUpperCase()}`;
    case 'date':
      return `${label}: moved to ${diff.after}`;
    case 'sport':
      return `${label}: ${diff.before} → ${diff.after}`;
  }
}

/** One deterministic line for the decision log and the next day's context. */
export function summarizeChanges(
  changes: readonly SessionDiff[],
  sessions: readonly CoachPlanSession[]
): string {
  if (changes.length === 0) return 'No changes, plan kept';
  return changes.map((c) => describeChange(c, sessions)).join('; ');
}

/** The athlete message when the final changes are not the LLM's own (clamped, or a fallback). */
export function renderSafeMessage(
  changes: readonly SessionDiff[],
  sessions: readonly CoachPlanSession[],
  notes: readonly string[]
): string {
  const head =
    changes.length === 0
      ? ['Keep your plan as it is.']
      : ['Plan update:', ...changes.map((c) => '• ' + describeChange(c, sessions))];
  const why = notes.length === 0 ? [] : ['', 'Why:', ...notes.map((n) => '• ' + n)];
  return [...head, ...why].join('\n');
}
