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

/** The rows `patches` change: the snapshot an Apply rolls back to. Tombstones are new rows. */
export function patchedRows(
  rows: readonly PlannedSessionRecord[],
  patches: readonly CoachPatch[]
): PlannedSessionRecord[] {
  const ids = new Set(patches.flatMap((p) => (p.kind === 'tombstone' ? [] : [p.id])));
  return rows.filter((r) => ids.has(r.id));
}

/**
 * One write that undoes an applied coach decision:
 * - `delete`: a row the apply created (a tombstone where a moved session was)
 * - `restore`: a changed row back to its snapshot
 * - `recreate`: a snapshot row that is gone
 */
export type RollbackPatch =
  | { kind: 'delete'; id: string }
  | { kind: 'restore'; row: PlannedSessionRecord }
  | { kind: 'recreate'; row: PlannedSessionRecord };

/** Statuses where the athlete's intervals.icu version wins: a rollback leaves them as they were */
const KEEP_STATUSES: ReadonlySet<PlannedSessionRecord['status']> = new Set([
  'modified_externally',
  'completed',
  'skipped',
]);

/**
 * A changed row back to its snapshot. Whether the failed push already reached ICU for it is
 * unknown (an ICU call may succeed and the DB write after it fail), so a row with an ICU
 * event goes back to draft and the next push writes the snapshot content again. A cancelled
 * row also forgets its event id: the push adopts the event by external_id, or recreates it
 * when the delete got through.
 */
function restoreOf(snap: PlannedSessionRecord, current: PlannedSessionRecord): RollbackPatch {
  const cancelled = current.deletedAt !== null;
  const icuEventId = cancelled ? null : current.icuEventId;
  const inIcu = icuEventId !== null || snap.icuEventId !== null;
  const status = KEEP_STATUSES.has(snap.status) || !inIcu ? snap.status : 'draft';
  return {
    kind: 'restore',
    row: { ...snap, icuEventId, pushedHash: cancelled ? null : current.pushedHash, status },
  };
}

/**
 * The writes that undo the decision `decisionId` after its push failed: `snapshot` holds the
 * changed rows as they were before the apply (`patchedRows`), `current` the rows now (a
 * window covering the snapshot and the apply's new dates).
 */
export function buildRollbackPatches(
  snapshot: readonly PlannedSessionRecord[],
  current: readonly PlannedSessionRecord[],
  decisionId: string
): RollbackPatch[] {
  const snapIds = new Set(snapshot.map((r) => r.id));
  const byId = new Map(current.map((r) => [r.id, r]));
  const deletes: RollbackPatch[] = current
    .filter((r) => r.coachDecisionId === decisionId && !snapIds.has(r.id))
    .map((r) => ({ kind: 'delete', id: r.id }));
  const restores = snapshot.map((snap): RollbackPatch => {
    const row = byId.get(snap.id);
    if (row) return restoreOf(snap, row);
    return {
      kind: 'recreate',
      row: { ...snap, status: 'draft', icuEventId: null, pushedHash: null },
    };
  });
  return [...deletes, ...restores];
}
