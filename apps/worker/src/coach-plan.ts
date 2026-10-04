import { addDaysIso, buildWorkoutSteps, type PlannedSessionDraft } from '@triathlon/core';
import { sessionKey, type CoachPlanSession, type SessionDiff } from '@triathlon/ai';
import type { PlannedSessionRecord } from './plan-store';

/** Days the coach may change in chat: today..today+6 */
export const COACH_PLAN_DAYS = 7;

export function coachPlanWindow(today: string): { from: string; to: string } {
  return { from: today, to: addDaysIso(today, COACH_PLAN_DAYS - 1) };
}

/** A planned session as the coach (prompt and guardrails) sees it. */
export function toCoachPlanSession(row: {
  date: string;
  slot: string;
  sport: CoachPlanSession['sport'];
  title: string;
  durationMin: number;
  intensity: CoachPlanSession['intensity'];
  status: CoachPlanSession['status'];
}): CoachPlanSession {
  return {
    id: sessionKey(row),
    date: row.date,
    slot: row.slot,
    sport: row.sport,
    title: row.title,
    durationMin: row.durationMin,
    intensity: row.intensity,
    status: row.status,
  };
}

/**
 * One write of an applied coach decision:
 * - `update`: new content for a session (and a new date and slot when it moved)
 * - `cancel`: the session is tombstoned
 * - `tombstone`: a placeholder at the (date, slot) a session moved away from, so the plan
 *   generator doesn't put it back there
 */
export type CoachPatch =
  | { kind: 'update'; id: string; session: PlannedSessionDraft }
  | { kind: 'cancel'; id: string }
  | { kind: 'tombstone'; session: PlannedSessionDraft };

/** First `<sport>-<n>` slot free on the date (core `toPlannedSessions` numbers from 0). */
function freeSlot(taken: Set<string>, date: string, sport: string): string {
  for (let n = 0; ; n++) {
    const slot = `${sport}-${n.toString()}`;
    if (!taken.has(`${date}|${slot}`)) return slot;
  }
}

function changesBySession(changes: readonly SessionDiff[]): Map<string, SessionDiff[]> {
  const grouped = new Map<string, SessionDiff[]>();
  for (const change of changes) {
    grouped.set(change.sessionId, [...(grouped.get(change.sessionId) ?? []), change]);
  }
  return grouped;
}

function draftOf(row: PlannedSessionRecord): PlannedSessionDraft {
  return {
    date: row.date,
    slot: row.slot,
    sport: row.sport,
    title: row.title,
    description: row.description,
    durationMin: row.durationMin,
    intensity: row.intensity,
    steps: row.steps,
  };
}

/** The row's content with every change applied; the slot is settled by the caller. */
function patched(row: PlannedSessionRecord, changes: readonly SessionDiff[]): PlannedSessionDraft {
  const next = draftOf(row);
  for (const change of changes) {
    if (change.field === 'date') next.date = change.after;
    if (change.field === 'durationMin') next.durationMin = change.after;
    if (change.field === 'intensity') next.intensity = change.after;
    if (change.field === 'sport') next.sport = change.after;
  }
  if (next.sport !== row.sport) next.title = `${next.sport} instead of ${row.title}`;
  next.steps = buildWorkoutSteps(next);
  return next;
}

function patchesFor(
  row: PlannedSessionRecord,
  changes: readonly SessionDiff[],
  taken: Set<string>
): CoachPatch[] {
  const session = patched(row, changes);
  if (session.durationMin === 0) return [{ kind: 'cancel', id: row.id }];
  if (session.date === row.date) return [{ kind: 'update', id: row.id, session }];

  session.slot = freeSlot(taken, session.date, session.sport);
  taken.add(`${session.date}|${session.slot}`);
  return [
    { kind: 'update', id: row.id, session },
    { kind: 'tombstone', session: draftOf(row) },
  ];
}

/**
 * The writes that apply `changes` (guardrail-checked `SessionDiff`s keyed by `sessionKey`) to
 * the stored rows. `rows` must include tombstones, which still hold their (date, slot).
 * Changes to a session that isn't stored (or is tombstoned) are skipped.
 */
export function buildCoachPatches(
  rows: readonly PlannedSessionRecord[],
  changes: readonly SessionDiff[]
): CoachPatch[] {
  const live = new Map(rows.filter((r) => r.deletedAt === null).map((r) => [sessionKey(r), r]));
  const taken = new Set(rows.map((r) => `${r.date}|${r.slot}`));
  const patches: CoachPatch[] = [];
  for (const [id, sessionChanges] of changesBySession(changes)) {
    const row = live.get(id);
    if (row) patches.push(...patchesFor(row, sessionChanges, taken));
  }
  return patches;
}
