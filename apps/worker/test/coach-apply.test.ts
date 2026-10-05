import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkoutSteps,
  Intensity,
  MSG_DECISION_EXPIRED,
  parseCoachDecision,
  Sport,
  workoutMinutes,
  type CoachAnswer,
  type PlannedSessionDraft,
  type RulesContext,
} from '@triathlon/core';
import type { SessionDiff } from '@triathlon/ai';
import { IcuServerError } from '@triathlon/integrations-icu';
import {
  handleCoachAnswer,
  MSG_ALREADY_ANSWERED,
  MSG_APPLY_ROLLED_BACK,
  MSG_DECISION_NOT_FOUND,
  MSG_DISCUSS,
  MSG_KEPT,
  MSG_PLAN_CHANGED,
  MSG_PUSH_FAILED,
  type AnswerableDecision,
  type CoachAnswerDeps,
  type CoachAnswerRepo,
  type CoachUserAction,
} from '../src/coach-apply';
import type { StoredChatMessage } from '../src/coach-chat-command';
import type { CoachPatch, RollbackPatch } from '../src/coach-plan';
import type { RichReply } from '../src/reply';
import { pushPlannedSessions, type PlanPushDeps } from '../src/plan-push';
import { diffPlan } from '../src/plan-store';
import { FakeIcuCalendar, KEY, MemoryPlanRepo, USER_ID } from './planned-session-fakes';

const USER = { id: USER_ID, profile: { timezone: 'Europe/Prague' } };
const TODAY = '2026-10-05'; // Monday
const NOW = new Date('2026-10-05T08:00:00Z');
const NO_HISTORY: RulesContext = { last7dStats: { totalMinutes: 0, byDate: [] } };
const DECISION_ID = 'dec1';
const BRIEF_MESSAGE_ID = 777;
const BRIEF_TEXT = '☀️ <b>Morning brief: Mon 5 Oct</b>';

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

type StoredDecision = AnswerableDecision & { userAction: CoachUserAction | null };

/** Decisions in memory; patches are written to the shared MemoryPlanRepo like db.ts does. */
class MemoryAnswers implements CoachAnswerRepo {
  readonly decisions = new Map<string, StoredDecision>();
  readonly briefs = new Map<string, string>();

  constructor(private readonly plan: MemoryPlanRepo) {}

  add(
    decision: Pick<AnswerableDecision, 'finalAction' | 'finalChanges'> & Partial<AnswerableDecision>
  ): void {
    this.decisions.set(DECISION_ID, {
      id: DECISION_ID,
      origin: 'chat',
      date: TODAY,
      athleteMessage: 'Take it a little easier today.',
      accepted: null,
      createdAt: NOW,
      userAction: null,
      ...decision,
    });
  }

  findDecision(_userId: string, decisionId: string) {
    const decision = this.decisions.get(decisionId);
    return Promise.resolve(decision ? structuredClone(decision) : null);
  }

  decline(_userId: string, decisionId: string, userAction: CoachUserAction) {
    const decision = this.decisions.get(decisionId);
    if (decision?.accepted !== null) return Promise.resolve(false);
    Object.assign(decision, { accepted: false, userAction });
    return Promise.resolve(true);
  }

  listWindow(userId: string, from: string, to: string) {
    return this.plan.listWindow(userId, from, to);
  }

  applyDecision(_userId: string, decisionId: string, patches: CoachPatch[], now: Date) {
    const decision = this.decisions.get(decisionId);
    if (decision?.accepted !== null) return Promise.resolve(false);
    Object.assign(decision, { accepted: true, userAction: 'apply' });
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

  revertDecision(_userId: string, decisionId: string, patches: RollbackPatch[]) {
    // Deletes first, like db.ts
    for (const patch of patches) {
      if (patch.kind === 'delete') this.plan.rows.delete(patch.id);
    }
    for (const patch of patches) {
      if (patch.kind === 'restore') this.plan.update(patch.row.id, patch.row);
      if (patch.kind === 'recreate') this.plan.rows.set(patch.row.id, structuredClone(patch.row));
    }
    Object.assign(this.decisions.get(decisionId)!, { accepted: null, userAction: null });
    return Promise.resolve();
  }

  markDiscussed(_userId: string, decisionId: string) {
    const decision = this.decisions.get(decisionId);
    if (decision?.accepted === null) decision.userAction = 'discuss';
    return Promise.resolve();
  }

  findAnswerText(_userId: string, decision: Pick<AnswerableDecision, 'id' | 'origin'>) {
    return Promise.resolve(this.briefs.get(decision.id) ?? null);
  }
}

/** Coach chat rows in memory: one per (message, role), like the unique index */
class MemoryChats {
  readonly messages: StoredChatMessage[] = [];

  saveMessage(_userId: string, message: StoredChatMessage) {
    const exists = this.messages.some(
      (m) => m.telegramMessageId === message.telegramMessageId && m.role === message.role
    );
    if (!exists) this.messages.push(structuredClone(message));
    return Promise.resolve();
  }
}

let plan: MemoryPlanRepo;
let icu: FakeIcuCalendar;
let answers: MemoryAnswers;
let chats: MemoryChats;
let push: PlanPushDeps;
let deps: CoachAnswerDeps;

beforeEach(async () => {
  plan = new MemoryPlanRepo();
  icu = new FakeIcuCalendar();
  answers = new MemoryAnswers(plan);
  chats = new MemoryChats();
  push = { repo: plan, keys: [KEY], createClient: () => icu, now: () => NOW };
  deps = {
    repo: answers,
    chats,
    getRulesContext: () => Promise.resolve(NO_HISTORY),
    push,
    onPushError: vi.fn(),
    ttlHours: 24,
    now: () => NOW,
  };
  for (const session of WEEK) plan.insert(session);
  await pushPlannedSessions(USER_ID, TODAY, push);
});

function tap(answer: CoachAnswer, decisionId: string | undefined = DECISION_ID) {
  return handleCoachAnswer(USER, { decisionId, answer, telegramMessageId: BRIEF_MESSAGE_ID }, deps);
}

function eventOf(date: string, slot: string) {
  const row = plan.get(date, slot);
  return row?.icuEventId == null ? undefined : icu.events.get(row.icuEventId);
}

describe('handleCoachAnswer: apply', () => {
  it('moves the session with its ICU event and keeps its old slot from coming back', async () => {
    const eventId = plan.get('2026-10-11', 'bike-0')!.icuEventId;
    answers.add({ finalAction: 'move', finalChanges: [MOVE_TO_SATURDAY] });

    const reply = await tap('apply');

    expect(reply).toBe('✅ Applied:\n• Bike Long ride moved to 2026-10-10');
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
    expect(answers.decisions.get(DECISION_ID)).toMatchObject({
      accepted: true,
      userAction: 'apply',
    });

    // A regenerated plan still has the ride on Sunday: it neither returns nor overwrites
    const rows = await plan.listWindow(USER_ID, TODAY, '2026-10-11');
    const diff = diffPlan(rows, WEEK);
    expect(diff.creates).toEqual([]);
    expect(diff.updates.map((u) => u.data.slot)).not.toContain('bike-0');
    expect(diff.softDeletes).not.toContain(moved.id);
  });

  it('regenerates the workout steps for a shorter session', async () => {
    answers.add({ finalAction: 'reduce', finalChanges: [SHORTEN] });

    await tap('apply');

    const row = plan.get('2026-10-11', 'bike-0')!;
    expect(row.durationMin).toBe(120);
    expect(workoutMinutes(row.steps)).toBe(120);
    expect(eventOf('2026-10-11', 'bike-0')?.moving_time).toBe(120 * 60);
  });

  it('cancels a session, deletes its ICU event and keeps the tombstone', async () => {
    const eventId = plan.get('2026-10-11', 'bike-0')!.icuEventId!;
    answers.add({ finalAction: 'rest', finalChanges: [CANCEL] });

    await tap('apply');

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

    const reply = await tap('apply');

    expect(reply).toBe(MSG_PLAN_CHANGED);
    expect(plan.get('2026-10-11', 'bike-0')).toMatchObject({
      durationMin: 150,
      coachDecisionId: null,
    });
    expect(answers.decisions.get(DECISION_ID)?.accepted).toBe(false);
  });

  it('applies once on a double tap', async () => {
    answers.add({ finalAction: 'move', finalChanges: [MOVE_TO_SATURDAY] });

    await tap('apply');
    const again = await tap('apply');

    expect(again).toBe(MSG_ALREADY_ANSWERED);
    expect([...plan.rows.values()].filter((r) => r.coachDecisionId !== null)).toHaveLength(2);
  });
});

describe('handleCoachAnswer: keep and errors', () => {
  it('records Keep without touching the plan', async () => {
    answers.add({ finalAction: 'move', finalChanges: [MOVE_TO_SATURDAY] });

    expect(await tap('keep')).toBe(MSG_KEPT);
    expect(answers.decisions.get(DECISION_ID)).toMatchObject({
      accepted: false,
      userAction: 'keep',
    });
    expect(plan.get('2026-10-11', 'bike-0')?.coachDecisionId).toBeNull();
    expect(await tap('apply')).toBe(MSG_ALREADY_ANSWERED);
  });

  it('answers an unknown or missing decision id', async () => {
    expect(await tap('apply', 'nope')).toBe(MSG_DECISION_NOT_FOUND);
    expect(await tap('keep', undefined)).toBe(MSG_DECISION_NOT_FOUND);
  });

  it('leaves block review decisions to their own Confirm/Decline', async () => {
    answers.add({ origin: 'block', finalAction: 'adjust', finalChanges: [] });

    expect(await tap('keep')).toBe(MSG_DECISION_NOT_FOUND);
    expect(answers.decisions.get(DECISION_ID)?.accepted).toBeNull();
  });
});

const VO2 = '2026-10-06/bike-0';
const THRESHOLD = '2026-10-08/run-0';
/** The brief's example: shorter and easier */
const EASE_VO2: SessionDiff[] = [
  { sessionId: VO2, field: 'durationMin', before: 60, after: 45 },
  { sessionId: VO2, field: 'intensity', before: Intensity.z4, after: Intensity.z3 },
];
const SHORTEN_THRESHOLD: SessionDiff = {
  sessionId: THRESHOLD,
  field: 'durationMin',
  before: 50,
  after: 40,
};

/** Session content of every stored row by id: what a rollback must restore */
function contentRows() {
  return new Map(
    [...plan.rows.values()].map((r) => {
      const { updatedAt: _u, status: _s, pushedHash: _h, ...rest } = structuredClone(r);
      return [r.id, rest];
    })
  );
}

/** Every stored row by id, for before/after comparisons (updatedAt left out) */
function snapshotRows() {
  return new Map(
    [...plan.rows.values()].map((r) => {
      const { updatedAt: _updatedAt, ...rest } = structuredClone(r);
      return [r.id, rest];
    })
  );
}

describe('handleCoachAnswer: morning brief', () => {
  beforeEach(() => {
    answers.briefs.set(DECISION_ID, BRIEF_TEXT);
  });

  it('applies, pushes and lists the exact changes under the brief', async () => {
    const eventId = plan.get('2026-10-06', 'bike-0')!.icuEventId!;
    answers.add({ origin: 'daily', finalAction: 'reduce', finalChanges: EASE_VO2 });

    const reply = (await tap('apply')) as RichReply;

    expect(reply).toEqual({
      text: BRIEF_TEXT + '\n\n✅ Applied:\n• Bike VO2 5x4 60′→45′, Z4→Z3',
      html: true,
      editTapped: true,
    });
    expect(plan.get('2026-10-06', 'bike-0')).toMatchObject({
      durationMin: 45,
      intensity: Intensity.z3,
      status: 'pushed',
      coachDecisionId: DECISION_ID,
    });
    expect(icu.events.get(eventId)?.moving_time).toBe(45 * 60);
    expect(answers.decisions.get(DECISION_ID)?.userAction).toBe('apply');
  });

  it('records Keep and changes nothing', async () => {
    const before = snapshotRows();
    answers.add({ origin: 'daily', finalAction: 'reduce', finalChanges: EASE_VO2 });
    icu.calls.length = 0;

    const reply = (await tap('keep')) as RichReply;

    expect(reply.text).toBe(BRIEF_TEXT + '\n\n' + MSG_KEPT);
    expect(reply.editTapped).toBe(true);
    expect(answers.decisions.get(DECISION_ID)).toMatchObject({
      accepted: false,
      userAction: 'keep',
    });
    expect(snapshotRows()).toEqual(before);
    expect(icu.calls).toEqual([]);
  });

  it('tells the athlete a brief older than 24 h expired and changes nothing', async () => {
    const before = snapshotRows();
    answers.add({
      origin: 'daily',
      finalAction: 'reduce',
      finalChanges: EASE_VO2,
      createdAt: new Date(NOW.getTime() - 25 * 3_600_000),
    });

    const replies = await Promise.all((['apply', 'keep', 'discuss'] as const).map((a) => tap(a)));

    for (const reply of replies as RichReply[]) {
      expect(reply.text).toBe(BRIEF_TEXT + '\n\n' + MSG_DECISION_EXPIRED);
      expect(reply.text).toContain('/plan today');
    }
    expect(answers.decisions.get(DECISION_ID)).toMatchObject({ accepted: null, userAction: null });
    expect(snapshotRows()).toEqual(before);
    expect(chats.messages).toEqual([]);
  });

  it('sends a plain reply for a chat decision without a brief', async () => {
    answers.briefs.clear();
    answers.add({ origin: 'daily', finalAction: 'reduce', finalChanges: EASE_VO2 });
    expect(await tap('keep')).toBe(MSG_KEPT);
  });
});

describe('handleCoachAnswer: weekly review', () => {
  const REPORT_TEXT = '📊 <b>Week 40 review</b>';
  const SUNDAY_EVENING = new Date('2026-10-04T17:30:00Z');
  /** +15 min on next Sunday's ride: within the 8% ramp cap of the 395-min week (cap 426) */
  const CATCH_UP: SessionDiff = {
    sessionId: LONG_RIDE,
    field: 'durationMin',
    before: 180,
    after: 195,
  };

  beforeEach(() => {
    answers.briefs.set(DECISION_ID, REPORT_TEXT);
  });

  it('applies next week on Sunday evening, pushes it and edits the report', async () => {
    deps.now = () => SUNDAY_EVENING;
    const eventId = plan.get('2026-10-11', 'bike-0')!.icuEventId!;
    answers.add({
      origin: 'weekly',
      date: '2026-10-04',
      finalAction: 'adjust',
      finalChanges: [CATCH_UP],
      createdAt: SUNDAY_EVENING,
    });

    const reply = (await tap('apply')) as RichReply;

    // Next Sunday is outside the daily today..+6 window, but inside the review's next week
    expect(reply).toEqual({
      text: REPORT_TEXT + '\n\n✅ Applied:\n• Bike Long ride 180′→195′',
      html: true,
      editTapped: true,
    });
    expect(plan.get('2026-10-11', 'bike-0')).toMatchObject({
      durationMin: 195,
      status: 'pushed',
      coachDecisionId: DECISION_ID,
    });
    expect(icu.events.get(eventId)?.moving_time).toBe(195 * 60);
  });

  it('re-checks the ramp cap on the current plan', async () => {
    const before = snapshotRows();
    const tooMuch: SessionDiff = { ...CATCH_UP, after: 240 };
    answers.add({
      origin: 'weekly',
      date: '2026-10-04',
      finalAction: 'adjust',
      finalChanges: [tooMuch],
    });

    const reply = (await tap('apply')) as RichReply;

    expect(reply.text).toBe(REPORT_TEXT + '\n\n' + MSG_PLAN_CHANGED);
    expect(snapshotRows()).toEqual(before);
    expect(answers.decisions.get(DECISION_ID)?.accepted).toBe(false);
  });

  it('records Keep under the report', async () => {
    answers.add({
      origin: 'weekly',
      date: '2026-10-04',
      finalAction: 'adjust',
      finalChanges: [CATCH_UP],
    });

    const reply = (await tap('keep')) as RichReply;

    expect(reply.text).toBe(REPORT_TEXT + '\n\n' + MSG_KEPT);
    expect(plan.get('2026-10-11', 'bike-0')?.durationMin).toBe(180);
  });
});

describe('handleCoachAnswer: rollback when intervals.icu fails', () => {
  it('restores the plan and leaves the decision unanswered', async () => {
    const before = contentRows();
    const eventId = plan.get('2026-10-06', 'bike-0')!.icuEventId!;
    icu.updateEvent = () => Promise.reject(new IcuServerError(503, 0));
    answers.add({ origin: 'daily', finalAction: 'reduce', finalChanges: EASE_VO2 });
    answers.briefs.set(DECISION_ID, BRIEF_TEXT);

    const reply = (await tap('apply')) as RichReply;

    expect(reply.text).toBe(BRIEF_TEXT + '\n\n' + MSG_APPLY_ROLLED_BACK);
    expect(contentRows()).toEqual(before);
    // Whether ICU got the change is unknown: the next push writes the original again
    expect(plan.get('2026-10-06', 'bike-0')).toMatchObject({
      status: 'draft',
      icuEventId: eventId,
    });
    expect(answers.decisions.get(DECISION_ID)).toMatchObject({ accepted: null, userAction: null });
    expect(deps.onPushError).toHaveBeenCalledOnce();
  });

  it('marks a session already written to intervals.icu for a re-push', async () => {
    const threshold = plan.get('2026-10-08', 'run-0')!;
    const eventId = threshold.icuEventId!;
    // The first update (Thursday's run) reaches ICU, the second (Sunday's ride) fails
    const update = icu.updateEvent;
    let calls = 0;
    icu.updateEvent = (id, data) =>
      ++calls === 1 ? update(id, data) : Promise.reject(new IcuServerError(503, 0));
    answers.add({ finalAction: 'reduce', finalChanges: [SHORTEN_THRESHOLD, SHORTEN] });

    expect(await tap('apply')).toBe(MSG_APPLY_ROLLED_BACK);

    expect(plan.get('2026-10-08', 'run-0')).toMatchObject({
      durationMin: 50,
      status: 'draft',
      icuEventId: eventId,
      coachDecisionId: null,
    });
    expect(plan.get('2026-10-11', 'bike-0')).toMatchObject({
      durationMin: 180,
      status: 'draft',
      coachDecisionId: null,
    });
    // The next push puts the original back in ICU
    icu.updateEvent = update;
    await pushPlannedSessions(USER_ID, TODAY, push);
    expect(icu.events.get(eventId)?.moving_time).toBe(50 * 60);
  });

  it('moves a session back and drops its tombstone', async () => {
    const before = contentRows();
    icu.updateEvent = () => Promise.reject(new IcuServerError(503, 0));
    answers.add({ finalAction: 'move', finalChanges: [MOVE_TO_SATURDAY] });

    expect(await tap('apply')).toBe(MSG_APPLY_ROLLED_BACK);
    expect(contentRows()).toEqual(before);
  });

  it('brings back a cancelled session whose event was already deleted', async () => {
    const ride = plan.get('2026-10-11', 'bike-0')!;
    // The delete reaches ICU, then the next write fails
    const deleteEvent = icu.deleteEvent;
    icu.deleteEvent = (id) => deleteEvent(id).then(() => Promise.reject(new Error('DB down')));
    answers.add({ finalAction: 'rest', finalChanges: [CANCEL] });

    expect(await tap('apply')).toBe(MSG_APPLY_ROLLED_BACK);

    expect(plan.rows.get(ride.id)).toMatchObject({
      deletedAt: null,
      coachDecisionId: null,
      durationMin: 180,
    });
    expect(plan.rows.get(ride.id)).toMatchObject({ status: 'draft', icuEventId: null });
    icu.deleteEvent = deleteEvent;
    await pushPlannedSessions(USER_ID, TODAY, push);
    const event = eventOf('2026-10-11', 'bike-0');
    expect(event?.name).toBe('Long ride');
    expect(event?.moving_time).toBe(180 * 60);
  });

  it('keeps the change and says so when the rollback fails too', async () => {
    icu.updateEvent = () => Promise.reject(new IcuServerError(503, 0));
    answers.revertDecision = () => Promise.reject(new Error('DB down'));
    answers.add({ finalAction: 'reduce', finalChanges: [SHORTEN] });

    const reply = await tap('apply');

    expect(reply).toContain(MSG_PUSH_FAILED);
    expect(plan.get('2026-10-11', 'bike-0')).toMatchObject({ durationMin: 120, status: 'draft' });
    expect(deps.onPushError).toHaveBeenCalledTimes(2);
  });

  it('pushes only the decision’s sessions', async () => {
    // An unrelated draft whose push would fail
    const tuesday = plan.get('2026-10-07', 'run-0')!;
    plan.update(tuesday.id, { status: 'draft', title: 'Edited easy run' });
    const update = icu.updateEvent;
    icu.updateEvent = (id, data) =>
      id === tuesday.icuEventId ? Promise.reject(new IcuServerError(503, 0)) : update(id, data);
    answers.add({ finalAction: 'reduce', finalChanges: [SHORTEN] });

    expect(await tap('apply')).toBe('✅ Applied:\n• Bike Long ride 180′→120′');
    expect(plan.get('2026-10-07', 'run-0')?.status).toBe('draft');
  });
});

describe('handleCoachAnswer: discuss', () => {
  it('seeds the coach chat and offers Apply/Keep again', async () => {
    answers.add({
      origin: 'daily',
      finalAction: 'reduce',
      finalChanges: EASE_VO2,
      athleteMessage: 'HRV is low: take the VO2 set down a notch.',
    });

    const reply = (await tap('discuss')) as RichReply;

    expect(reply.text).toBe(MSG_DISCUSS);
    expect(reply.editTapped).toBeUndefined();
    expect(reply.keyboard?.flat().map((b) => parseCoachDecision(b.data))).toEqual([
      { answer: 'apply', decisionId: DECISION_ID },
      { answer: 'keep', decisionId: DECISION_ID },
    ]);
    expect(chats.messages).toEqual([
      {
        role: 'coach',
        text: 'HRV is low: take the VO2 set down a notch.\nProposed:\n• Bike VO2 5x4 60′→45′, Z4→Z3',
        telegramMessageId: BRIEF_MESSAGE_ID,
        coachDecisionId: DECISION_ID,
      },
    ]);
    // Discuss doesn't answer: Apply still works
    expect(answers.decisions.get(DECISION_ID)).toMatchObject({
      accepted: null,
      userAction: 'discuss',
    });
    expect(await tap('apply')).toBe('✅ Applied:\n• Bike VO2 5x4 60′→45′, Z4→Z3');
  });

  it('seeds once on a retry and offers no buttons without changes', async () => {
    answers.add({ finalAction: 'keep', finalChanges: [] });

    expect(await tap('discuss')).toBe(MSG_DISCUSS);
    expect(await tap('discuss')).toBe(MSG_DISCUSS);
    expect(chats.messages).toHaveLength(1);
    expect(chats.messages[0].text).toBe('Take it a little easier today.');
  });
});
