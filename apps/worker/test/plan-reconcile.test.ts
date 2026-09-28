import { describe, it, expect, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { buildWorkoutSteps, Intensity, Sport } from '@triathlon/core';
import type { PlannedSessionDraft } from '@triathlon/core';
import { IcuAuthError } from '@triathlon/integrations-icu';
import { pushPlannedSessions, REASON_DELETED_IN_ICU, type PlanPushDeps } from '../src/plan-push';
import {
  processPlanReconcileJob,
  reconcilePlannedSessions,
  REASON_EDITED_IN_ICU,
  type PlanReconcileDeps,
} from '../src/plan-reconcile';
import { materializePlan } from '../src/plan-store';
import { FakeIcuCalendar, KEY, MemoryPlanRepo, USER_ID } from './planned-session-fakes';

const TODAY = '2026-09-28';
const NOW = new Date('2026-09-28T08:00:00Z');

function draft(
  date: string,
  sport: Sport,
  intensity: Intensity,
  durationMin: number
): PlannedSessionDraft {
  const base = { sport, intensity, durationMin };
  return {
    date,
    slot: `${sport}-0`,
    title: `${sport} ${intensity}`,
    description: null,
    ...base,
    steps: buildWorkoutSteps(base),
  };
}

const DRAFTS = [
  draft('2026-09-28', Sport.bike, Intensity.z2, 60),
  draft('2026-09-29', Sport.run, Intensity.z4, 55),
  draft('2026-10-01', Sport.bike, Intensity.z5, 70),
];

let repo: MemoryPlanRepo;
let icu: FakeIcuCalendar;
let deps: PlanReconcileDeps;

beforeEach(async () => {
  repo = new MemoryPlanRepo();
  icu = new FakeIcuCalendar();
  deps = { repo, keys: [KEY], createClient: () => icu, now: () => NOW };
  const pushDeps: PlanPushDeps = { ...deps, createClient: () => icu };
  await materializePlan(USER_ID, TODAY, DRAFTS, { repo, now: () => NOW });
  await pushPlannedSessions(USER_ID, TODAY, pushDeps);
  icu.calls.length = 0;
});

const eventOf = (date: string, sport: Sport) => repo.get(date, `${sport}-0`)!.icuEventId!;

describe('reconcilePlannedSessions', () => {
  it('flags nothing when ICU still has what we pushed', async () => {
    expect(await reconcilePlannedSessions(USER_ID, deps)).toEqual({
      status: 'ok',
      checked: 3,
      flagged: 0,
    });
    expect(icu.calls).toEqual(['list 2026-09-28..2026-10-01']);
    expect([...repo.rows.values()].every((r) => r.status === 'pushed')).toBe(true);
  });

  it('flags a session the athlete moved to another day (content hash mismatch)', async () => {
    icu.edit(eventOf('2026-09-29', Sport.run), { start_date_local: '2026-09-30T00:00:00' });

    const result = await reconcilePlannedSessions(USER_ID, deps);

    expect(result).toMatchObject({ checked: 3, flagged: 1 });
    expect(repo.get('2026-09-29', 'run-0')).toMatchObject({
      status: 'modified_externally',
      externalChange: 'moved to 2026-09-30',
    });
    const flagged = await repo.listModifiedExternally(USER_ID, TODAY);
    expect(flagged.map((r) => r.slot)).toEqual(['run-0']);
  });

  it('flags a session whose workout the athlete edited', async () => {
    const id = eventOf('2026-10-01', Sport.bike);
    icu.edit(id, { description: 'Main set 4x\n- 5m Z5\n- 3m Z1' });

    await reconcilePlannedSessions(USER_ID, deps);

    expect(repo.get('2026-10-01', 'bike-0')).toMatchObject({
      status: 'modified_externally',
      externalChange: REASON_EDITED_IN_ICU,
    });
  });

  it('ignores whitespace-only differences in the description', async () => {
    const id = eventOf('2026-10-01', Sport.bike);
    const description = icu.events.get(id)!.description!;
    icu.edit(id, { description: `${description.replace(/\n/g, '\r\n')}  \n` });

    expect(await reconcilePlannedSessions(USER_ID, deps)).toMatchObject({ flagged: 0 });
  });

  it('looks up events moved outside the range, and flags deleted ones', async () => {
    icu.edit(eventOf('2026-09-28', Sport.bike), { start_date_local: '2026-10-20T00:00:00' });
    const deletedId = eventOf('2026-10-01', Sport.bike);
    icu.events.delete(deletedId);

    const result = await reconcilePlannedSessions(USER_ID, deps);

    expect(result).toMatchObject({ checked: 3, flagged: 2 });
    expect(icu.calls).toContain(`get ${deletedId.toString()}`);
    expect(repo.get('2026-09-28', 'bike-0')!.externalChange).toBe('moved to 2026-10-20');
    expect(repo.get('2026-10-01', 'bike-0')!.externalChange).toBe(REASON_DELETED_IN_ICU);
  });

  it('does not flag a session a push rewrote meanwhile', async () => {
    icu.edit(eventOf('2026-09-29', Sport.run), { name: 'Renamed' });
    // A push lands between listPushed and flagExternal and stores a new hash
    const listPushed = repo.listPushed.bind(repo);
    repo.listPushed = async (...args) => {
      const rows = await listPushed(...args);
      repo.rows.get(repo.get('2026-09-29', 'run-0')!.id)!.pushedHash = 'rewritten';
      return rows;
    };

    expect(await reconcilePlannedSessions(USER_ID, deps)).toMatchObject({ flagged: 0 });
    expect(repo.get('2026-09-29', 'run-0')!.status).toBe('pushed');
  });

  it('skips ICU entirely when nothing is pushed, and without a link', async () => {
    repo.rows.clear();
    expect(await reconcilePlannedSessions(USER_ID, deps)).toEqual({
      status: 'ok',
      checked: 0,
      flagged: 0,
    });
    expect(icu.calls).toEqual([]);

    repo.connection = null;
    expect(await reconcilePlannedSessions(USER_ID, deps)).toEqual({ status: 'not_connected' });
  });
});

describe('processPlanReconcileJob', () => {
  it('fails without retry when ICU rejects the stored key', async () => {
    icu.listEvents = () => Promise.reject(new IcuAuthError());
    await expect(processPlanReconcileJob({ userId: USER_ID }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError
    );
  });
});
