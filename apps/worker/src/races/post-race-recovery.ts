import {
  addDaysIso,
  recoverySessions,
  recoveryWindow,
  toPlannedSessions,
  type PlannedSessionDraft,
} from '@triathlon/core';
import { pushPlannedSessions, type PlanPushDeps } from '../plan-push';
import { materializeRange, type PlanStoreDeps } from '../plan-store';
import type { RaceRecord } from '../race-command';

export interface RecoveryWindow {
  race: RaceRecord;
  from: string;
  to: string;
}

export type RecoveryResult =
  | { status: 'none' }
  | { status: 'not_connected' }
  | {
      status: 'ok';
      windows: RecoveryWindow[];
      created: number;
      updated: number;
      deleted: number;
    };

export interface RecoveryDeps {
  store: PlanStoreDeps;
  push: PlanPushDeps;
}

/**
 * The part of each past race's recovery block that is still ahead: from the day after the race
 * (or today, when later) to the block's end, cut short before the next race. Days before today
 * are history and are never touched.
 */
export function recoveryWindows(races: readonly RaceRecord[], today: string): RecoveryWindow[] {
  const sorted = [...races].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.flatMap((race) => {
    const block = recoveryWindow(race);
    if (!block || race.date >= today) return [];
    const next = sorted.find((r) => r.date > race.date);
    const from = block.from > today ? block.from : today;
    const to = next && addDaysIso(next.date, -1) < block.to ? addDaysIso(next.date, -1) : block.to;
    return from <= to ? [{ race, from, to }] : [];
  });
}

function draftsFor(window: RecoveryWindow): PlannedSessionDraft[] {
  const sessions = recoverySessions(window.race).filter(
    (s) => s.date >= window.from && s.date <= window.to
  );
  return toPlannedSessions({ startDate: window.from, sessions, warnings: [], appliedRules: [] });
}

/**
 * Replaces the planned sessions of every recovery window with the easy block (rest days hold
 * nothing) and pushes the change to ICU. The same sessions come out of the season expansion
 * (`applyRaceOverrides`), so the rolling publisher agrees with this. Diff-based: a second run
 * writes and pushes nothing. Rows the athlete changed (modified_externally, completed, skipped)
 * are kept by `materializeRange`.
 */
export async function applyRecoveryBlocks(
  userId: string,
  windows: readonly RecoveryWindow[],
  deps: RecoveryDeps
): Promise<RecoveryResult> {
  if (windows.length === 0) return { status: 'none' };
  // Checked first so nothing is stored for an athlete we can't push to
  if (!(await deps.push.repo.findConnection(userId))) return { status: 'not_connected' };

  await Promise.all(windows.map((w) => materializeRange(userId, w, draftsFor(w), deps.store)));
  const earliest = windows.map((w) => w.from).sort((a, b) => a.localeCompare(b))[0];
  const pushed = await pushPlannedSessions(userId, earliest, deps.push);
  if (pushed.status === 'not_connected') return { status: 'not_connected' };
  const { created, updated, deleted } = pushed;
  return { status: 'ok', windows: [...windows], created, updated, deleted };
}
