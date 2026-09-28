import { describe, it, expect } from 'vitest';
import { buildWorkoutSteps, Intensity, Sport } from '@triathlon/core';
import type { PlannedSessionDraft } from '@triathlon/core';
import { diffPlan, materializePlan, planWindowEnd } from '../src/plan-store';
import { MemoryPlanRepo, USER_ID } from './planned-session-fakes';

const TODAY = '2026-09-28';

function draft(
  date: string,
  slot: string,
  overrides: Partial<PlannedSessionDraft> = {}
): PlannedSessionDraft {
  const base = {
    date,
    slot,
    sport: Sport.run,
    title: 'Run Intervals',
    description: 'Warm up 15min, 5x3min Z4 (2min rest), cool down',
    durationMin: 55,
    intensity: Intensity.z4,
    ...overrides,
  };
  return { ...base, steps: buildWorkoutSteps(base), ...overrides };
}

const deps = (repo: MemoryPlanRepo) => ({ repo, now: () => new Date('2026-09-28T08:00:00Z') });

describe('diffPlan', () => {
  it('creates new sessions and leaves unchanged ones alone', () => {
    const repo = new MemoryPlanRepo();
    const kept = repo.insert(draft(TODAY, 'run-0'), { status: 'pushed', icuEventId: 1 });

    const diff = diffPlan([kept], [draft(TODAY, 'run-0'), draft('2026-09-29', 'bike-0')]);

    expect(diff.creates.map((d) => d.slot)).toEqual(['bike-0']);
    expect(diff).toMatchObject({ updates: [], softDeletes: [], hardDeletes: [] });
  });

  it('treats steps from JSONB (keys reordered) as unchanged', () => {
    const repo = new MemoryPlanRepo();
    const row = repo.insert(draft(TODAY, 'run-0'));
    // Postgres JSONB returns object keys in its own order
    row.steps = JSON.parse(
      JSON.stringify(row.steps, (_k, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v
      )
    ) as typeof row.steps;

    expect(diffPlan([row], [draft(TODAY, 'run-0')]).updates).toEqual([]);
  });

  it('updates a changed session, keeping its row (and ICU event)', () => {
    const repo = new MemoryPlanRepo();
    const row = repo.insert(draft(TODAY, 'run-0'), { status: 'pushed', icuEventId: 7 });
    const easier = draft(TODAY, 'run-0', {
      title: 'Run Intervals (downgraded to Z2)',
      intensity: Intensity.z2,
    });

    const diff = diffPlan([row], [easier]);

    expect(diff.updates).toEqual([{ id: row.id, data: easier }]);
    expect(diff.creates).toEqual([]);
  });

  it('never touches sessions the athlete changed, completed or skipped', () => {
    const repo = new MemoryPlanRepo();
    const rows = [
      repo.insert(draft(TODAY, 'run-0'), { status: 'modified_externally', icuEventId: 1 }),
      repo.insert(draft('2026-09-29', 'run-0'), { status: 'completed', icuEventId: 2 }),
      repo.insert(draft('2026-09-30', 'run-0'), { status: 'skipped', icuEventId: 3 }),
    ];
    const changed = rows.slice(0, 1).map((r) => draft(r.date, r.slot, { durationMin: 30 }));

    // Changed in the plan, or gone from it: either way nothing to write
    expect(diffPlan(rows, changed)).toEqual({
      creates: [],
      updates: [],
      softDeletes: [],
      hardDeletes: [],
    });
  });

  it('tombstones removed pushed sessions and hard-deletes never-pushed ones', () => {
    const repo = new MemoryPlanRepo();
    const pushed = repo.insert(draft(TODAY, 'run-0'), { status: 'pushed', icuEventId: 9 });
    const local = repo.insert(draft('2026-09-29', 'run-0'));
    const alreadyTombstoned = repo.insert(draft('2026-09-30', 'run-0'), {
      icuEventId: 10,
      deletedAt: new Date(),
    });

    const diff = diffPlan([pushed, local, alreadyTombstoned], []);

    expect(diff.softDeletes).toEqual([pushed.id]);
    expect(diff.hardDeletes).toEqual([local.id]);
  });

  it('revives a tombstoned session that is back in the plan', () => {
    const repo = new MemoryPlanRepo();
    const row = repo.insert(draft(TODAY, 'run-0'), { icuEventId: 9, deletedAt: new Date() });

    expect(diffPlan([row], [draft(TODAY, 'run-0')]).updates).toEqual([
      { id: row.id, data: draft(TODAY, 'run-0') },
    ]);
  });
});

describe('materializePlan', () => {
  it('stores the window, is a no-op when repeated, and keeps past rows', async () => {
    const repo = new MemoryPlanRepo();
    const past = repo.insert(draft('2026-09-27', 'run-0'), { status: 'pushed', icuEventId: 1 });
    const drafts = [draft(TODAY, 'run-0'), draft(planWindowEnd(TODAY), 'bike-0')];

    const rows = await materializePlan(USER_ID, TODAY, drafts, deps(repo));
    expect(rows.map((r) => [r.date, r.slot, r.status])).toEqual([
      ['2026-09-28', 'run-0', 'draft'],
      ['2026-10-04', 'bike-0', 'draft'],
    ]);

    const before = structuredClone([...repo.rows.values()]);
    await materializePlan(USER_ID, TODAY, drafts, deps(repo));
    expect([...repo.rows.values()]).toEqual(before);

    // Yesterday's session is history, even though it is not in today's plan
    expect(repo.rows.get(past.id)).toBeDefined();
  });

  it('puts a changed pushed session back to draft with the same ICU event id', async () => {
    const repo = new MemoryPlanRepo();
    repo.insert(draft(TODAY, 'run-0'), { status: 'pushed', icuEventId: 42, pushedHash: 'h' });

    await materializePlan(USER_ID, TODAY, [draft(TODAY, 'run-0', { durationMin: 40 })], deps(repo));

    expect(repo.get(TODAY, 'run-0')).toMatchObject({
      status: 'draft',
      icuEventId: 42,
      durationMin: 40,
    });
  });
});
