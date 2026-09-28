import { addDays, format } from 'date-fns';
import type { PlannedSessionDraft } from '@triathlon/core';

export type PlannedSessionStatus =
  'draft' | 'pushed' | 'modified_externally' | 'completed' | 'skipped';

/** A stored PlannedSession row. */
export interface PlannedSessionRecord extends PlannedSessionDraft {
  id: string;
  userId: string;
  /** draft = local changes not in intervals.icu yet. */
  status: PlannedSessionStatus;
  icuEventId: number | null;
  /** hashIcuEvent of the event ICU returned after our last write. */
  pushedHash: string | null;
  /** Why reconcile flagged the session (e.g. "moved to 2026-10-02"). */
  externalChange: string | null;
  /** Local tombstone: set when the session left the plan but its ICU event still exists. */
  deletedAt: Date | null;
  updatedAt: Date;
}

export interface PlanDiff {
  creates: PlannedSessionDraft[];
  /** New content for existing rows (tombstones included). They go back to draft, not deleted. */
  updates: { id: string; data: PlannedSessionDraft }[];
  /** Pushed sessions no longer in the plan: tombstoned until push deletes the ICU event. */
  softDeletes: string[];
  /** Never-pushed sessions no longer in the plan. */
  hardDeletes: string[];
}

export interface PlanStoreRepo {
  /** All of the user's rows dated from..to (inclusive), tombstones included. */
  listWindow(userId: string, from: string, to: string): Promise<PlannedSessionRecord[]>;
  /** Applies the diff atomically. */
  applyPlan(userId: string, diff: PlanDiff, now: Date): Promise<void>;
}

export interface PlanStoreDeps {
  repo: PlanStoreRepo;
  now(): Date;
}

export const PLAN_DAYS = 7;

/** Statuses the plan generator never overwrites: the athlete's version wins. */
const PROTECTED_STATUSES = new Set<PlannedSessionStatus>([
  'modified_externally',
  'completed',
  'skipped',
]);

/** JSON with sorted object keys: Postgres JSONB does not keep key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

function isSameContent(row: PlannedSessionDraft, draft: PlannedSessionDraft): boolean {
  return (
    row.sport === draft.sport &&
    row.title === draft.title &&
    row.description === draft.description &&
    row.durationMin === draft.durationMin &&
    row.intensity === draft.intensity &&
    stableJson(row.steps) === stableJson(draft.steps)
  );
}

const keyOf = (s: { date: string; slot: string }) => `${s.date}|${s.slot}`;

/**
 * Diffs the regenerated plan against the stored rows of the same window, matching on
 * (date, slot). Unchanged rows are not written. Changed rows go back to draft and keep
 * their ICU event id, so the next push updates the same event.
 */
export function diffPlan(
  existing: PlannedSessionRecord[],
  drafts: PlannedSessionDraft[]
): PlanDiff {
  const rows = new Map(existing.map((row) => [keyOf(row), row]));
  const diff: PlanDiff = { creates: [], updates: [], softDeletes: [], hardDeletes: [] };

  for (const draft of drafts) {
    const row = rows.get(keyOf(draft));
    rows.delete(keyOf(draft));
    if (!row) diff.creates.push(draft);
    else if (PROTECTED_STATUSES.has(row.status)) continue;
    else if (row.deletedAt !== null || !isSameContent(row, draft)) {
      diff.updates.push({ id: row.id, data: draft });
    }
  }

  // Rows left over are no longer in the plan
  for (const row of rows.values()) {
    if (PROTECTED_STATUSES.has(row.status) || row.deletedAt !== null) continue;
    if (row.icuEventId !== null) diff.softDeletes.push(row.id);
    else diff.hardDeletes.push(row.id);
  }

  return diff;
}

/** Oldest and newest date of a non-empty row list, for ICU `oldest`/`newest` queries. */
export function dateRange(rows: { date: string }[]): [oldest: string, newest: string] {
  const dates = rows.map((row) => row.date).sort((a, b) => a.localeCompare(b));
  return [dates[0], dates.at(-1) ?? dates[0]];
}

export function planWindowEnd(today: string): string {
  return format(addDays(new Date(`${today}T00:00:00`), PLAN_DAYS - 1), 'yyyy-MM-dd');
}

/**
 * Stores the plan for the window starting `today` (athlete-local) and returns the
 * window's rows afterwards. Rows before today are history and are left alone.
 */
export async function materializePlan(
  userId: string,
  today: string,
  drafts: PlannedSessionDraft[],
  deps: PlanStoreDeps
): Promise<PlannedSessionRecord[]> {
  const end = planWindowEnd(today);
  const inWindow = drafts.filter((d) => d.date >= today && d.date <= end);
  const existing = await deps.repo.listWindow(userId, today, end);
  const diff = diffPlan(existing, inWindow);

  const changes =
    diff.creates.length + diff.updates.length + diff.softDeletes.length + diff.hardDeletes.length;
  if (changes === 0) return existing;

  await deps.repo.applyPlan(userId, diff, deps.now());
  return deps.repo.listWindow(userId, today, end);
}
