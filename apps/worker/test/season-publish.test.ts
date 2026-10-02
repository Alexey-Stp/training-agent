import { describe, it, expect, beforeEach } from 'vitest';
import {
  Intensity,
  SeasonPlanStatus,
  Sport,
  TrainingBlockType,
  type PlannedSessionDraft,
  type RulesContext,
  type SeasonPlan,
  type TrainingBlock,
  type UserProfile,
} from '@triathlon/core';
import { publishSeasonWindow, type SeasonPublishDeps } from '../src/season-publish';
import { FakeIcuCalendar, KEY, MemoryPlanRepo, USER_ID } from './planned-session-fakes';

// Wed 2026-10-07 noon in Prague: T = 2026-10-07, window 2026-10-08..2026-10-21
const NOW = new Date('2026-10-07T10:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_CONTEXT: RulesContext = { last7dStats: { totalMinutes: 0, byDate: [] } };

const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
};

function block(
  order: number,
  type: TrainingBlockType,
  startDate: string,
  weeks: number,
  hours = 10
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus: '',
    targetWeeklyHours: hours,
    targetSwimM: hours * 0.15 * 2500,
    targetBikeH: hours * 0.55,
    targetRunKm: hours * 0.3 * 10,
    targetCtl: null,
  };
}

/** Base 2026-09-28..2026-10-25, build 2026-10-26..2026-11-22 */
function season(hours = 10): SeasonPlan {
  return {
    startDate: '2026-09-28',
    status: SeasonPlanStatus.active,
    aRace: null,
    blocks: [
      block(1, TrainingBlockType.base, '2026-09-28', 4, hours),
      block(2, TrainingBlockType.build, '2026-10-26', 4, hours),
    ],
  };
}

const PAST_DRAFT: PlannedSessionDraft = {
  date: '2026-10-07',
  slot: 'run-0',
  sport: Sport.run,
  title: 'Old run',
  description: null,
  durationMin: 45,
  intensity: Intensity.z2,
  steps: [],
};

let repo: MemoryPlanRepo;
let icu: FakeIcuCalendar;
let active: SeasonPlan | null;
let profile: UserProfile;
let now: Date;
let deps: SeasonPublishDeps;

function eventDates(): string[] {
  return [...icu.events.values()].map((e) => e.start_date_local.slice(0, 10));
}

beforeEach(() => {
  repo = new MemoryPlanRepo();
  icu = new FakeIcuCalendar();
  active = season();
  profile = PROFILE;
  now = NOW;
  deps = {
    seasons: { findActiveSeason: () => Promise.resolve(active) },
    profiles: { findProfile: () => Promise.resolve(profile) },
    getRulesContext: () => Promise.resolve(EMPTY_CONTEXT),
    store: { repo, now: () => now },
    push: { repo, keys: [KEY], createClient: () => icu, now: () => now },
    windowDays: 14,
    now: () => now,
  };
});

describe('publishSeasonWindow', () => {
  it('puts days T+1..T+14 on the ICU calendar', async () => {
    const result = await publishSeasonWindow(USER_ID, deps);

    expect(result).toMatchObject({ status: 'ok', from: '2026-10-08', to: '2026-10-21' });
    const dates = eventDates();
    expect(dates.length).toBeGreaterThan(10);
    expect(dates.every((d) => d >= '2026-10-08' && d <= '2026-10-21')).toBe(true);
    // Both window edges: Thu key bike and Wed technique swim
    expect(dates).toContain('2026-10-08');
    expect(dates).toContain('2026-10-21');
    // Every stored row is pushed and linked to its event
    const rows = await repo.listWindow(USER_ID, '2026-10-08', '2026-10-21');
    expect(rows).toHaveLength(dates.length);
    expect(rows.every((r) => r.status === 'pushed' && r.icuEventId !== null)).toBe(true);
    if (result.status === 'ok') expect(result.created).toBe(rows.length);
  });

  it('never touches today or earlier days', async () => {
    const today = repo.insert(PAST_DRAFT);
    const yesterday = repo.insert(
      { ...PAST_DRAFT, date: '2026-10-06', title: 'Pushed run' },
      { status: 'pushed', icuEventId: 1, pushedHash: 'h' }
    );

    await publishSeasonWindow(USER_ID, deps);

    expect(repo.get('2026-10-07', 'run-0')).toEqual(today);
    expect(repo.get('2026-10-06', 'run-0')).toEqual(yesterday);
    expect(icu.calls.every((c) => c.startsWith('create') || c.startsWith('list'))).toBe(true);
    expect(eventDates()).not.toContain('2026-10-07');
  });

  it('makes no ICU writes when nothing changed', async () => {
    await publishSeasonWindow(USER_ID, deps);
    const callsBefore = icu.calls.length;

    const again = await publishSeasonWindow(USER_ID, deps);

    expect(again).toMatchObject({ status: 'ok', created: 0, updated: 0, deleted: 0 });
    expect(icu.calls.slice(callsBefore)).toEqual([]);
  });

  it('adds only the new last day when the window rolls forward', async () => {
    await publishSeasonWindow(USER_ID, deps);
    const before = new Set(icu.events.keys());

    now = new Date(NOW.getTime() + DAY_MS);
    const next = await publishSeasonWindow(USER_ID, deps);

    expect(next).toMatchObject({ status: 'ok', from: '2026-10-09', to: '2026-10-22', updated: 0 });
    const added = [...icu.events.values()].filter((e) => !before.has(e.id));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((e) => e.start_date_local.startsWith('2026-10-22'))).toBe(true);
    // Yesterday's window start (now today) is left as pushed
    expect(eventDates()).toContain('2026-10-08');
  });

  it('keeps sessions the athlete changed in ICU when the season changes', async () => {
    await publishSeasonWindow(USER_ID, deps);
    const flagged = (await repo.listWindow(USER_ID, '2026-10-10', '2026-10-10'))[0];
    await repo.flagExternal(flagged.id, flagged.pushedHash, 'moved to 2026-10-11');

    active = season(8);
    const result = await publishSeasonWindow(USER_ID, deps);

    expect(result).toMatchObject({ status: 'ok' });
    if (result.status === 'ok') expect(result.updated).toBeGreaterThan(0);
    const after = repo.get(flagged.date, flagged.slot);
    expect(after?.status).toBe('modified_externally');
    expect(after?.durationMin).toBe(flagged.durationMin);
  });

  it('uses the athlete timezone for T', async () => {
    // 00:30 on Oct 8 in Prague, still 15:30 on Oct 7 in Los Angeles
    now = new Date('2026-10-07T22:30:00Z');
    expect(await publishSeasonWindow(USER_ID, deps)).toMatchObject({
      from: '2026-10-09',
      to: '2026-10-22',
    });

    repo = new MemoryPlanRepo();
    deps.store.repo = repo;
    deps.push.repo = repo;
    profile = { ...PROFILE, timezone: 'America/Los_Angeles' };
    expect(await publishSeasonWindow(USER_ID, deps)).toMatchObject({
      from: '2026-10-08',
      to: '2026-10-21',
    });
  });

  it('stops at the end of the season', async () => {
    now = new Date('2026-11-15T10:00:00Z');
    const result = await publishSeasonWindow(USER_ID, deps);
    expect(result).toMatchObject({ status: 'ok', from: '2026-11-16', to: '2026-11-22' });
    expect(eventDates().every((d) => d <= '2026-11-22')).toBe(true);
  });

  it('skips when there is nothing to publish', async () => {
    now = new Date('2026-11-22T10:00:00Z');
    expect(await publishSeasonWindow(USER_ID, deps)).toEqual({
      status: 'skipped',
      reason: 'outside_season',
    });

    now = NOW;
    active = null;
    expect(await publishSeasonWindow(USER_ID, deps)).toEqual({
      status: 'skipped',
      reason: 'no_season',
    });

    active = season();
    repo.connection = null;
    expect(await publishSeasonWindow(USER_ID, deps)).toEqual({
      status: 'skipped',
      reason: 'not_connected',
    });
    expect(repo.rows.size).toBe(0);
    expect(icu.calls).toEqual([]);
  });
});
