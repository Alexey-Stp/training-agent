import { describe, it, expect } from 'vitest';
import { buildWorkoutSteps, Intensity, Sport, type PlannedSessionDraft } from '@triathlon/core';
import { buildCoachPatches, buildRollbackPatches, patchedRows } from '../src/coach-plan';
import { MemoryPlanRepo } from './planned-session-fakes';

function draft(date: string, slot: string, sport: Sport, title = 'Session'): PlannedSessionDraft {
  const base = {
    date,
    slot,
    sport,
    title,
    description: null,
    durationMin: 60,
    intensity: Intensity.z2,
  };
  return { ...base, steps: buildWorkoutSteps(base) };
}

describe('buildCoachPatches', () => {
  it('moves a session to the first free slot on the new day, counting tombstones', () => {
    const repo = new MemoryPlanRepo();
    const ride = repo.insert(draft('2026-10-11', 'bike-0', Sport.bike, 'Long ride'));
    const saturday = [
      repo.insert(draft('2026-10-10', 'bike-0', Sport.bike)),
      repo.insert(draft('2026-10-10', 'bike-1', Sport.bike), { deletedAt: new Date() }),
    ];

    const patches = buildCoachPatches(
      [ride, ...saturday],
      [{ sessionId: '2026-10-11/bike-0', field: 'date', before: '2026-10-11', after: '2026-10-10' }]
    );

    expect(patches).toMatchObject([
      { kind: 'update', id: ride.id, session: { date: '2026-10-10', slot: 'bike-2' } },
      { kind: 'tombstone', session: { date: '2026-10-11', slot: 'bike-0', title: 'Long ride' } },
    ]);
  });

  it('combines several changes to one session and renames a sport swap', () => {
    const repo = new MemoryPlanRepo();
    const run = repo.insert(draft('2026-10-07', 'run-0', Sport.run, 'Easy run'));

    const [patch] = buildCoachPatches(
      [run],
      [
        { sessionId: '2026-10-07/run-0', field: 'sport', before: Sport.run, after: Sport.bike },
        { sessionId: '2026-10-07/run-0', field: 'durationMin', before: 60, after: 45 },
      ]
    );

    expect(patch).toMatchObject({
      kind: 'update',
      session: { sport: Sport.bike, durationMin: 45, title: 'bike instead of Easy run' },
    });
  });

  it('cancels at 0 minutes and skips sessions that are not stored', () => {
    const repo = new MemoryPlanRepo();
    const run = repo.insert(draft('2026-10-07', 'run-0', Sport.run));

    const patches = buildCoachPatches(
      [run],
      [
        { sessionId: '2026-10-07/run-0', field: 'durationMin', before: 60, after: 0 },
        { sessionId: '2026-10-08/run-0', field: 'durationMin', before: 60, after: 30 },
      ]
    );

    expect(patches).toEqual([{ kind: 'cancel', id: run.id }]);
  });
});

describe('buildRollbackPatches', () => {
  const DECISION = 'dec1';

  it('deletes the rows the apply created and restores the changed ones', () => {
    const repo = new MemoryPlanRepo();
    const before = repo.insert(draft('2026-10-11', 'bike-0', Sport.bike, 'Long ride'));
    const moved = { ...before, date: '2026-10-10', coachDecisionId: DECISION };
    const tombstone = repo.insert(draft('2026-10-11', 'bike-0', Sport.bike, 'Long ride'), {
      deletedAt: new Date(),
      coachDecisionId: DECISION,
    });
    const other = repo.insert(draft('2026-10-10', 'run-0', Sport.run), {
      deletedAt: new Date(),
      coachDecisionId: 'older',
    });

    const patches = buildRollbackPatches([before], [moved, tombstone, other], DECISION);

    expect(patches).toEqual([
      { kind: 'delete', id: tombstone.id },
      { kind: 'restore', row: before },
    ]);
  });

  it('sends a session with an ICU event back to draft for a re-push', () => {
    const repo = new MemoryPlanRepo();
    const pushed = repo.insert(draft('2026-10-07', 'run-0', Sport.run), {
      status: 'pushed',
      icuEventId: 5000,
      pushedHash: 'h1',
    });
    const now = { ...pushed, durationMin: 45, status: 'pushed' as const, pushedHash: 'h2' };

    const [patch] = buildRollbackPatches([pushed], [now], DECISION);

    expect(patch).toEqual({
      kind: 'restore',
      row: { ...pushed, status: 'draft', icuEventId: 5000, pushedHash: 'h2' },
    });
  });

  it('lets push adopt or recreate the event of a cancelled session', () => {
    const repo = new MemoryPlanRepo();
    const pushed = repo.insert(draft('2026-10-07', 'run-0', Sport.run), {
      status: 'pushed',
      icuEventId: 5000,
      pushedHash: 'h1',
    });
    const cancelled = { ...pushed, deletedAt: new Date(), coachDecisionId: DECISION };

    const [patch] = buildRollbackPatches([pushed], [cancelled], DECISION);

    expect(patch).toEqual({
      kind: 'restore',
      row: { ...pushed, status: 'draft', icuEventId: null, pushedHash: null },
    });
  });

  it('keeps the athlete’s version and unpushed drafts as they were', () => {
    const repo = new MemoryPlanRepo();
    const external = repo.insert(draft('2026-10-07', 'run-0', Sport.run), {
      status: 'modified_externally',
      icuEventId: 5000,
      pushedHash: 'h1',
    });
    const local = repo.insert(draft('2026-10-08', 'swim-0', Sport.swim));

    const patches = buildRollbackPatches([external, local], [external, local], DECISION);

    expect(patches.map((p) => (p.kind === 'delete' ? null : p.row.status))).toEqual([
      'modified_externally',
      'draft',
    ]);
  });

  it('recreates a snapshot row that is gone', () => {
    const repo = new MemoryPlanRepo();
    const row = repo.insert(draft('2026-10-07', 'run-0', Sport.run), { icuEventId: 5000 });

    expect(buildRollbackPatches([row], [], DECISION)).toEqual([
      { kind: 'recreate', row: { ...row, status: 'draft', icuEventId: null, pushedHash: null } },
    ]);
  });
});

describe('patchedRows', () => {
  it('is the rows an update or cancel touches', () => {
    const repo = new MemoryPlanRepo();
    const a = repo.insert(draft('2026-10-07', 'run-0', Sport.run));
    const b = repo.insert(draft('2026-10-08', 'run-0', Sport.run));
    const c = repo.insert(draft('2026-10-09', 'run-0', Sport.run));

    const rows = patchedRows(
      [a, b, c],
      [
        { kind: 'update', id: a.id, session: draft('2026-10-07', 'run-0', Sport.run) },
        { kind: 'cancel', id: c.id },
        { kind: 'tombstone', session: draft('2026-10-08', 'run-0', Sport.run) },
      ]
    );

    expect(rows).toEqual([a, c]);
  });
});
