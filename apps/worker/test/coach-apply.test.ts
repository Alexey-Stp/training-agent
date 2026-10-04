import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkoutSteps,
  Intensity,
  Sport,
  workoutMinutes,
  type PlannedSessionDraft,
  type RulesContext,
} from '@triathlon/core';
import type { SessionDiff } from '@triathlon/ai';
import { IcuServerError } from '@triathlon/integrations-icu';
import {
  handleCoachAnswer,
  MSG_ALREADY_ANSWERED,
  MSG_DECISION_NOT_FOUND,
  MSG_KEPT,
  MSG_PLAN_CHANGED,
  MSG_PUSH_FAILED,
  type AnswerableDecision,
  type CoachAnswerDeps,
  type CoachAnswerRepo,
} from '../src/coach-apply';
import type { CoachPatch } from '../src/coach-plan';
import { pushPlannedSessions, type PlanPushDeps } from '../src/plan-push';
import { diffPlan } from '../src/plan-store';
import { FakeIcuCalendar, KEY, MemoryPlanRepo, USER_ID } from './planned-session-fakes';

const USER = { id: USER_ID, profile: { timezone: 'Europe/Prague' } };
const TODAY = '2026-10-05'; // Monday
const NOW = new Date('2026-10-05T08:00:00Z');
const NO_HISTORY: RulesContext = { last7dStats: { totalMinutes: 0, byDate: [] } };
const DECISION_ID = 'dec1';

function draft(
  date: string,
  slot: string,
  sport: Sport,
  intensity: Intensity,
  durationMin: number,
  title: string
): PlannedSessionDraft {
  const base = { date, slot, sport, title, description: null, durationMin, intensity };
  return { ...base, steps: buildWorkoutSteps(base) };
}

const WEEK: PlannedSessionDraft[] = [
  draft('2026-10-06', 'bike-0', Sport.bike, Intensity.z4, 60, 'VO2 5x4'),
  draft('2026-10-07', 'run-0', Sport.run, Intensity.z2, 45, 'Easy run'),
  draft('2026-10-08', 'run-0', Sport.run, Intensity.z4, 50, 'Threshold run'),
  draft('2026-10-10', 'run-0', Sport.run, Intensity.z2, 60, 'Long run'),
  draft('2026-10-11', 'bike-0', Sport.bike, Intensity.z2, 180, 'Long ride'),
];

const LONG_RIDE = '2026-10-11/bike-0';
const MOVE_TO_SATURDAY: SessionDiff = {
  sessionId: LONG_RIDE,
  field: 'date',
  before: '2026-10-11',
  after: '2026-10-10',
};
const SHORTEN: SessionDiff = {
  sessionId: LONG_RIDE,
  field: 'durationMin',
  before: 180,
  after: 120,
};
const CANCEL: SessionDiff = { sessionId: LONG_RIDE, field: 'durationMin', before: 180, after: 0 };

/** Decisions in memory; patches are written to the shared MemoryPlanRepo like db.ts does. */
class MemoryAnswers implements CoachAnswerRepo {
  readonly decisions = new Map<string, AnswerableDecision>();

  constructor(private readonly plan: MemoryPlanRepo) {}

  add(decision: Omit<AnswerableDecision, 'id' | 'accepted'>): void {
    this.decisions.set(DECISION_ID, { id: DECISION_ID, accepted: null, ...decision });
  }

  findDecision(_userId: string, decisionId: string) {
    const decision = this.decisions.get(decisionId);
    return Promise.resolve(decision ? structuredClone(decision) : null);
  }

  decline(_userId: string, decisionId: string) {
    const decision = this.decisions.get(decisionId);
    if (decision?.accepted !== null) return Promise.resolve(false);
    decision.accepted = false;
    return Promise.resolve(true);
  }

  listWindow(userId: string, from: string, to: string) {
    return this.plan.listWindow(userId, from, to);
  }

  applyDecision(_userId: string, decisionId: string, patches: CoachPatch[], now: Date) {
    const decision = this.decisions.get(decisionId);
    if (decision?.accepted !== null) return Promise.resolve(false);
    decision.accepted = true;
    for (const patch of patches) {
      if (patch.kind === 'update') {
        const fields = { ...patch.session, status: 'draft' as const, deletedAt: null };
        this.plan.update(patch.id, { ...fields, coachDecisionId: decisionId });
      } else if (patch.kind === 'cancel') {
        this.plan.update(patch.id, { deletedAt: now, coachDecisionId: decisionId });
      } else {
        this.plan.insert(patch.session, { deletedAt: now, coachDecisionId: decisionId });
      }
    }
    return Promise.resolve(true);
  }
}

let plan: MemoryPlanRepo;
let icu: FakeIcuCalendar;
let answers: MemoryAnswers;
let push: PlanPushDeps;
let deps: CoachAnswerDeps;

beforeEach(async () => {
  plan = new MemoryPlanRepo();
  icu = new FakeIcuCalendar();
  answers = new MemoryAnswers(plan);
  push = { repo: plan, keys: [KEY], createClient: () => icu, now: () => NOW };
  deps = {
    repo: answers,
    getRulesContext: () => Promise.resolve(NO_HISTORY),
    push,
    onPushError: vi.fn(),
    now: () => NOW,
  };
  for (const session of WEEK) plan.insert(session);
  await pushPlannedSessions(USER_ID, TODAY, push);
});

function eventOf(date: string, slot: string) {
  const row = plan.get(date, slot);
  return row?.icuEventId == null ? undefined : icu.events.get(row.icuEventId);
}

describe('handleCoachAnswer: apply', () => {
  it('moves the session with its ICU event and keeps its old slot from coming back', async () => {
    const eventId = plan.get('2026-10-11', 'bike-0')!.icuEventId;
    answers.add({ finalAction: 'move', finalChanges: [MOVE_TO_SATURDAY] });

    const reply = await handleCoachAnswer(USER, DECISION_ID, 'apply', deps);

    expect(reply).toBe('✅ Applied:\n• bike "Long ride" 2026-10-11: moved to 2026-10-10');
    const moved = plan.get('2026-10-10', 'bike-0')!;
    expect(moved).toMatchObject({
      title: 'Long ride',
      icuEventId: eventId,
      status: 'pushed',
      coachDecisionId: DECISION_ID,
    });
    expect(eventOf('2026-10-10', 'bike-0')?.start_date_local).toBe('2026-10-10T00:00:00');
    expect(plan.get('2026-10-11', 'bike-0')).toMatchObject({
      icuEventId: null,
      coachDecisionId: DECISION_ID,
    });
    expect(plan.get('2026-10-11', 'bike-0')?.deletedAt).not.toBeNull();
    expect(answers.decisions.get(DECISION_ID)?.accepted).toBe(true);

    // A regenerated plan still has the ride on Sunday: it neither returns nor overwrites
    const rows = await plan.listWindow(USER_ID, TODAY, '2026-10-11');
    const diff = diffPlan(rows, WEEK);
    expect(diff.creates).toEqual([]);
    expect(diff.updates.map((u) => u.data.slot)).not.toContain('bike-0');
    expect(diff.softDeletes).not.toContain(moved.id);
  });

  it('regenerates the workout steps for a shorter session', async () => {
    answers.add({ finalAction: 'reduce', finalChanges: [SHORTEN] });

    await handleCoachAnswer(USER, DECISION_ID, 'apply', deps);

    const row = plan.get('2026-10-11', 'bike-0')!;
    expect(row.durationMin).toBe(120);
    expect(workoutMinutes(row.steps)).toBe(120);
    expect(eventOf('2026-10-11', 'bike-0')?.moving_time).toBe(120 * 60);
  });

  it('cancels a session, deletes its ICU event and keeps the tombstone', async () => {
    const eventId = plan.get('2026-10-11', 'bike-0')!.icuEventId!;
    answers.add({ finalAction: 'rest', finalChanges: [CANCEL] });

    await handleCoachAnswer(USER, DECISION_ID, 'apply', deps);

    expect(icu.events.has(eventId)).toBe(false);
    const row = plan.get('2026-10-11', 'bike-0')!;
    expect(row).toMatchObject({ icuEventId: null, coachDecisionId: DECISION_ID });
    expect(row.deletedAt).not.toBeNull();
    // Nothing left to push for it
    expect(await plan.listPending(USER_ID, TODAY)).toEqual([]);
  });

  it('applies nothing when the plan changed since the suggestion', async () => {
    plan.update(plan.get('2026-10-11', 'bike-0')!.id, { durationMin: 150 });
    answers.add({ finalAction: 'reduce', finalChanges: [SHORTEN] });

    const reply = await handleCoachAnswer(USER, DECISION_ID, 'apply', deps);

    expect(reply).toBe(MSG_PLAN_CHANGED);
    expect(plan.get('2026-10-11', 'bike-0')).toMatchObject({
      durationMin: 150,
      coachDecisionId: null,
    });
    expect(answers.decisions.get(DECISION_ID)?.accepted).toBe(false);
  });

  it('applies once on a double tap', async () => {
    answers.add({ finalAction: 'move', finalChanges: [MOVE_TO_SATURDAY] });

    await handleCoachAnswer(USER, DECISION_ID, 'apply', deps);
    const again = await handleCoachAnswer(USER, DECISION_ID, 'apply', deps);

    expect(again).toBe(MSG_ALREADY_ANSWERED);
    expect([...plan.rows.values()].filter((r) => r.coachDecisionId !== null)).toHaveLength(2);
  });

  it('keeps the change when intervals.icu is down and says so', async () => {
    icu.updateEvent = () => Promise.reject(new IcuServerError(503, 0));
    answers.add({ finalAction: 'reduce', finalChanges: [SHORTEN] });

    const reply = await handleCoachAnswer(USER, DECISION_ID, 'apply', deps);

    expect(reply).toContain(MSG_PUSH_FAILED);
    expect(plan.get('2026-10-11', 'bike-0')).toMatchObject({ durationMin: 120, status: 'draft' });
    expect(deps.onPushError).toHaveBeenCalledOnce();
  });
});

describe('handleCoachAnswer: keep and errors', () => {
  it('records Keep without touching the plan', async () => {
    answers.add({ finalAction: 'move', finalChanges: [MOVE_TO_SATURDAY] });

    expect(await handleCoachAnswer(USER, DECISION_ID, 'keep', deps)).toBe(MSG_KEPT);
    expect(answers.decisions.get(DECISION_ID)?.accepted).toBe(false);
    expect(plan.get('2026-10-11', 'bike-0')?.coachDecisionId).toBeNull();
    expect(await handleCoachAnswer(USER, DECISION_ID, 'apply', deps)).toBe(MSG_ALREADY_ANSWERED);
  });

  it('answers an unknown or missing decision id', async () => {
    expect(await handleCoachAnswer(USER, 'nope', 'apply', deps)).toBe(MSG_DECISION_NOT_FOUND);
    expect(await handleCoachAnswer(USER, undefined, 'keep', deps)).toBe(MSG_DECISION_NOT_FOUND);
  });
});
