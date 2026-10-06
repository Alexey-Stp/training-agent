import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { validateSeasonPlan, type SeasonPlan } from '@triathlon/core';
import {
  addDays,
  buildDemoData,
  DEMO_DAYS,
  DEMO_PLAN_AHEAD_DAYS,
  type DemoData,
} from '../../../scripts/seed-demo-data';
import { applyMigrations, insertRows } from './migration-helpers';

const TODAY = '2026-10-06';

// Insert order follows the foreign keys
async function seed(db: PGlite, data: DemoData): Promise<void> {
  await insertRows(db, 'User', [data.user]);
  await insertRows(db, 'Profile', [data.profile]);
  await insertRows(db, 'Race', data.races);
  await insertRows(db, 'SeasonPlan', data.seasonPlans);
  await insertRows(db, 'TrainingBlock', data.trainingBlocks);
  await insertRows(db, 'PlannedSession', data.plannedSessions);
  await insertRows(db, 'Activity', data.activities);
  await insertRows(db, 'Wellness', data.wellness);
}

async function count(db: PGlite, table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "${table}"`);
  return rows[0].n;
}

describe('seed-demo data', () => {
  it('is deterministic for a date and seed, and varies with the seed', () => {
    expect(buildDemoData(TODAY)).toEqual(buildDemoData(TODAY));
    expect(buildDemoData(TODAY, 1).wellness).not.toEqual(buildDemoData(TODAY, 2).wellness);
  });

  it('covers 30 days of wellness ending today, with device data and some check-ins', () => {
    const { wellness } = buildDemoData(TODAY);
    expect(wellness).toHaveLength(DEMO_DAYS);
    expect(wellness[0].date).toBe(addDays(TODAY, -(DEMO_DAYS - 1)));
    expect(wellness.at(-1)?.date).toBe(TODAY);
    expect(wellness.every((w) => w.hrv != null && w.ctl != null)).toBe(true);
    expect(wellness.filter((w) => w.subjectiveReadiness != null).length).toBeGreaterThan(0);
  });

  it('plans the 30 days and a week ahead, and only closes out past sessions', () => {
    const { plannedSessions } = buildDemoData(TODAY);
    const future = plannedSessions.filter((p) => p.date >= TODAY);
    const past = plannedSessions.filter((p) => p.date < TODAY);
    expect(plannedSessions.every((p) => p.date <= addDays(TODAY, DEMO_PLAN_AHEAD_DAYS))).toBe(true);
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((p) => p.status === 'draft')).toBe(true);
    expect(past.every((p) => p.status === 'completed' || p.status === 'skipped')).toBe(true);
  });

  it('gives a completed session one activity and a skipped one none', () => {
    const { plannedSessions, activities } = buildDemoData(TODAY);
    const linked = new Set(activities.map((a) => a.plannedSessionId).filter(Boolean));
    for (const p of plannedSessions) {
      expect(linked.has(p.id), p.id).toBe(p.status === 'completed');
    }
    expect(activities.filter((a) => !a.plannedSessionId)).toHaveLength(1);
  });

  it('builds a season that passes the core invariants', () => {
    const { races, seasonPlans, trainingBlocks } = buildDemoData(TODAY);
    const plan: SeasonPlan = {
      startDate: seasonPlans[0].startDate,
      status: 'active' as SeasonPlan['status'],
      aRace: {
        date: races[0].date,
        name: races[0].name,
        priority: races[0].priority,
        type: races[0].type,
      },
      blocks: trainingBlocks.map((b) => ({
        order: b.order,
        type: b.type,
        startDate: b.startDate,
        weeks: b.weeks,
        focus: b.focus,
        targetWeeklyHours: b.targetWeeklyHours,
        targetSwimM: b.targetSwimM,
        targetBikeH: b.targetBikeH,
        targetRunKm: b.targetRunKm,
        targetCtl: b.targetCtl ?? null,
      })),
    };
    expect(validateSeasonPlan(plan)).toEqual([]);
  });
});

describe('seed-demo against the migrated schema', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seed(db, buildDemoData(TODAY));
  });

  afterAll(async () => {
    await db.close();
  });

  it('inserts 30 days of wellness, activities and plan for one demo athlete', async () => {
    expect(await count(db, 'User')).toBe(1);
    expect(await count(db, 'Wellness')).toBe(DEMO_DAYS);
    expect(await count(db, 'Activity')).toBeGreaterThanOrEqual(15);
    expect(await count(db, 'PlannedSession')).toBeGreaterThanOrEqual(DEMO_DAYS / 2);
    expect(await count(db, 'TrainingBlock')).toBe(5);
  });

  it('removes everything with the demo user (cascade), so a re-seed starts clean', async () => {
    await db.exec(`DELETE FROM "User"`);
    for (const table of [
      'Wellness',
      'Activity',
      'PlannedSession',
      'Race',
      'SeasonPlan',
      'TrainingBlock',
    ]) {
      expect(await count(db, table), table).toBe(0);
    }
  });
});
