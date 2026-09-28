import { describe, it, expect, beforeEach } from 'vitest';
import {
  addOptionalSundaySwim,
  generateDraftPlan,
  toPlannedSessions,
  type PlannedSessionDraft,
  type UserProfile,
} from '@triathlon/core';
import { IcuAuthError, IcuServerError } from '@triathlon/integrations-icu';
import { MSG_NOT_CONNECTED } from '../src/icu-connect';
import {
  handlePlanPush,
  MSG_PUSH_UNAVAILABLE,
  type PlanPushCommandDeps,
} from '../src/plan-command';
import {
  externalIdFor,
  hashIcuEvent,
  pushPlannedSessions,
  REASON_DELETED_IN_ICU,
  toIcuEvent,
  type PlanPushDeps,
} from '../src/plan-push';
import { materializePlan } from '../src/plan-store';
import { MSG_SYNC_AUTH_FAILED } from '../src/sync-command';
import { API_KEY, FakeIcuCalendar, KEY, MemoryPlanRepo, USER_ID } from './planned-session-fakes';

const TODAY = '2026-09-28'; // Monday
const NOW = new Date('2026-09-28T08:00:00Z');
const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
};

function weekDrafts(): PlannedSessionDraft[] {
  return toPlannedSessions(addOptionalSundaySwim(generateDraftPlan(PROFILE, TODAY), PROFILE));
}

let repo: MemoryPlanRepo;
let icu: FakeIcuCalendar;
let apiKeys: string[];
let pushDeps: PlanPushDeps;
let deps: PlanPushCommandDeps;

beforeEach(() => {
  repo = new MemoryPlanRepo();
  icu = new FakeIcuCalendar();
  apiKeys = [];
  pushDeps = {
    repo,
    keys: [KEY],
    createClient: (athleteId, apiKey) => {
      apiKeys.push(`${athleteId}:${apiKey}`);
      return icu;
    },
    now: () => NOW,
  };
  deps = { store: { repo, now: () => NOW }, push: pushDeps };
});

async function planAndPush(drafts = weekDrafts()) {
  await materializePlan(USER_ID, TODAY, drafts, deps.store);
  return pushPlannedSessions(USER_ID, TODAY, pushDeps);
}

describe('pushPlannedSessions', () => {
  it('creates one WORKOUT event per session and stores its id', async () => {
    const result = await planAndPush();

    expect(result).toMatchObject({ status: 'ok', created: 8, updated: 0, deleted: 0 });
    expect(apiKeys).toEqual([`i12345:${API_KEY}`]);
    expect(icu.events.size).toBe(8);
    for (const row of repo.rows.values()) {
      expect(row.status).toBe('pushed');
      const event = icu.events.get(row.icuEventId!)!;
      expect(event).toMatchObject({
        category: 'WORKOUT',
        start_date_local: `${row.date}T00:00:00`,
        name: row.title,
        external_id: externalIdFor(row.id),
        moving_time: row.durationMin * 60,
      });
      expect(row.pushedHash).toBe(hashIcuEvent(event));
    }

    const tue = repo.get('2026-09-29', 'run-0')!;
    expect(icu.events.get(tue.icuEventId!)).toMatchObject({
      type: 'Run',
      description:
        'Warm up 15min, 5x3min Z4 (2min rest), cool down\n\nWarmup\n- 15m Z2 HR\n\nMain set 5x\n- 3m Z4 HR\n- 2m Z1 HR\n\nCooldown\n- 15m Z1 HR',
    });
  });

  it('two pushes produce one event per session', async () => {
    await planAndPush();
    const ids = [...icu.events.keys()];
    icu.calls.length = 0;

    const second = await planAndPush();

    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect([...icu.events.keys()]).toEqual(ids);
    expect(icu.calls).toEqual([]); // nothing pending: not even a list call
  });

  it('updates the same event when a pushed session changes locally', async () => {
    await planAndPush();
    const before = repo.get('2026-10-01', 'bike-0')!;

    const drafts = weekDrafts().map((d) =>
      d.date === '2026-10-01' ? { ...d, title: 'Bike VO2 Max (short)', durationMin: 50 } : d
    );
    const result = await planAndPush(drafts);

    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(icu.events.size).toBe(8);
    const after = repo.get('2026-10-01', 'bike-0')!;
    expect(after.icuEventId).toBe(before.icuEventId);
    expect(after.status).toBe('pushed');
    expect(icu.events.get(after.icuEventId!)).toMatchObject({
      name: 'Bike VO2 Max (short)',
      moving_time: 3000,
    });
    expect(after.pushedHash).toBe(hashIcuEvent(icu.events.get(after.icuEventId!)!));
  });

  it('deletes the ICU event of a session removed locally', async () => {
    await planAndPush();
    const swim = repo.get('2026-10-04', 'swim-0')!;

    const result = await planAndPush(
      weekDrafts().filter((d) => d.slot !== 'swim-0' || d.date !== '2026-10-04')
    );

    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 1 });
    expect(icu.events.has(swim.icuEventId!)).toBe(false);
    expect(repo.rows.has(swim.id)).toBe(false);
    expect(icu.events.size).toBe(7);
  });

  it('treats an already deleted ICU event as deleted', async () => {
    await planAndPush();
    const swim = repo.get('2026-10-04', 'swim-0')!;
    icu.events.delete(swim.icuEventId!);

    const result = await planAndPush(
      weekDrafts().filter((d) => d.slot !== 'swim-0' || d.date !== '2026-10-04')
    );

    expect(result).toMatchObject({ deleted: 1 });
    expect(repo.rows.has(swim.id)).toBe(false);
  });

  it('adopts an event created before a crash instead of duplicating it', async () => {
    await materializePlan(USER_ID, TODAY, weekDrafts(), deps.store);
    repo.failNextMarkPushed = true;
    await expect(pushPlannedSessions(USER_ID, TODAY, pushDeps)).rejects.toThrow('DB down');
    expect(icu.events.size).toBe(1); // created in ICU, id never stored

    const retry = await pushPlannedSessions(USER_ID, TODAY, pushDeps);

    expect(retry).toMatchObject({ created: 7, updated: 1 });
    expect(icu.events.size).toBe(8);
    const ids = [...repo.rows.values()].map((r) => r.icuEventId);
    expect(new Set(ids).size).toBe(8);
  });

  it('flags a changed session whose event the athlete deleted in ICU', async () => {
    await planAndPush();
    const mon = repo.get(TODAY, 'bike-0')!;
    icu.events.delete(mon.icuEventId!);

    const drafts = weekDrafts().map((d) => (d.date === TODAY ? { ...d, durationMin: 45 } : d));
    const result = await planAndPush(drafts);

    expect(result).toMatchObject({ status: 'ok', created: 0, updated: 0 });
    expect(repo.get(TODAY, 'bike-0')).toMatchObject({
      status: 'modified_externally',
      externalChange: REASON_DELETED_IN_ICU,
    });
    expect(result.status === 'ok' && result.keptExternal.map((r) => r.id)).toEqual([mon.id]);
    expect(icu.events.size).toBe(7); // not recreated
  });

  it('returns not_connected without an ICU link', async () => {
    repo.connection = null;
    expect(await pushPlannedSessions(USER_ID, TODAY, pushDeps)).toEqual({
      status: 'not_connected',
    });
  });
});

describe('toIcuEvent', () => {
  it('uses only the workout text when a session has no notes', async () => {
    await materializePlan(USER_ID, TODAY, weekDrafts(), deps.store);
    const row = repo.get(TODAY, 'bike-0')!;
    expect(toIcuEvent({ ...row, description: null })).toEqual({
      category: 'WORKOUT',
      start_date_local: '2026-09-28T00:00:00',
      name: 'Bike Endurance',
      type: 'Ride',
      description: 'Main set\n- 60m Z2',
      moving_time: 3600,
      external_id: `ta-${row.id}`,
    });
  });
});

describe('handlePlanPush', () => {
  it('replies with a summary, then reports an up-to-date calendar', async () => {
    const first = await handlePlanPush(USER_ID, TODAY, weekDrafts(), deps);
    expect(first).toBe(
      '✅ Pushed your plan to intervals.icu (2026-09-28 → 2026-10-04)\n📅 8 new, 0 updated, 0 removed'
    );

    const second = await handlePlanPush(USER_ID, TODAY, weekDrafts(), deps);
    expect(second).toBe(
      '✅ intervals.icu calendar is already up to date (2026-09-28 → 2026-10-04)'
    );
  });

  it('lists sessions kept as edited in intervals.icu', async () => {
    await handlePlanPush(USER_ID, TODAY, weekDrafts(), deps);
    const tue = repo.get('2026-09-29', 'run-0')!;
    await repo.flagExternal(tue.id, tue.pushedHash, 'moved to 2026-09-30');

    const reply = await handlePlanPush(USER_ID, TODAY, weekDrafts(), deps);

    expect(reply).toContain('⚠️ Changed in intervals.icu, kept as you left them:');
    expect(reply).toContain('• Tue Sep 29 Run Intervals: moved to 2026-09-30');
  });

  it('saves the plan and maps ICU errors to friendly replies', async () => {
    icu.createEvent = () => Promise.reject(new IcuServerError(503, 3));
    expect(await handlePlanPush(USER_ID, TODAY, weekDrafts(), deps)).toBe(MSG_PUSH_UNAVAILABLE);
    expect(repo.rows.size).toBe(8); // stored as drafts for the next push

    icu.createEvent = () => Promise.reject(new IcuAuthError());
    expect(await handlePlanPush(USER_ID, TODAY, weekDrafts(), deps)).toBe(MSG_SYNC_AUTH_FAILED);
  });

  it('asks to connect when there is no ICU link', async () => {
    repo.connection = null;
    expect(await handlePlanPush(USER_ID, TODAY, weekDrafts(), deps)).toBe(MSG_NOT_CONNECTED);
  });
});
