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

/** One change of a session, without its label: `70′→50′`, `Z5→Z3`, `moved to 2026-10-07`. */
function changePart(diff: SessionDiff): string {
  switch (diff.field) {
    case 'durationMin':
      if (diff.after === 0) return 'cancelled';
      return diff.before.toString() + '′→' + diff.after.toString() + '′';
    case 'intensity':
      return diff.before.toUpperCase() + '→' + diff.after.toUpperCase();
    case 'date':
      return 'moved to ' + diff.after;
    case 'sport':
      return diff.before + '→' + diff.after;
  }
}

/** `Bike VO2 5x4`, or the bare id for a session the plan doesn't have. */
function shortLabel(id: string, sessions: readonly CoachPlanSession[]): string {
  const session = sessions.find((s) => s.id === id);
  if (!session) return id;
  return session.sport.charAt(0).toUpperCase() + session.sport.slice(1) + ' ' + session.title;
}

/**
 * One line per changed session, in the order the changes first name it, for the athlete:
 * `Bike VO2 5x4 70′→50′, Z5→Z3`.
 */
export function describeSessionChanges(
  changes: readonly SessionDiff[],
  sessions: readonly CoachPlanSession[]
): string[] {
  const parts = new Map<string, string[]>();
  for (const diff of changes) {
    const list = parts.get(diff.sessionId) ?? [];
    list.push(changePart(diff));
    parts.set(diff.sessionId, list);
  }
  return [...parts].map(([id, list]) => shortLabel(id, sessions) + ' ' + list.join(', '));
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
