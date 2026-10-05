import {
  coachDecisionData,
  escapeHtml,
  isDecisionExpired,
  isoWeekRange,
  localToday,
  MSG_DECISION_EXPIRED,
  nextIsoWeek,
  type CoachAnswer,
  type DateRange,
  type RulesContext,
} from '@triathlon/core';
import {
  describeSessionChanges,
  runGuardrails,
  runWeeklyGuardrails,
  type CoachDecisionAction,
  type CoachDecisionOrigin,
  type CoachPlanSession,
  type GuardrailConfig,
  type SessionDiff,
  type WeeklyGuardrailConfig,
} from '@triathlon/ai';
import {
  buildCoachPatches,
  buildRollbackPatches,
  coachPlanWindow,
  patchedRows,
  toCoachPlanSession,
  type CoachPatch,
  type RollbackPatch,
} from './coach-plan';
import { pushPlannedSessions, type PlanPushDeps } from './plan-push';
import { dateRange, type PlannedSessionRecord } from './plan-store';
import { MSG_NO_PROFILE } from './profile';
import type { CoachChatRepo, CoachChatUser } from './coach-chat-command';
import type { Reply } from './reply';

/** What Apply/Keep/Discuss needs of a stored `CoachDecision` */
export interface AnswerableDecision {
  id: string;
  origin: CoachDecisionOrigin;
  /** Athlete-local day of the decision; a weekly review's changes target the week after it */
  date: string;
  finalAction: CoachDecisionAction;
  finalChanges: SessionDiff[];
  athleteMessage: string;
  accepted: boolean | null;
  createdAt: Date;
}

/** The button the athlete tapped; `discuss` doesn't answer the decision */
export type CoachUserAction = CoachAnswer;

export interface CoachAnswerRepo {
  findDecision(userId: string, decisionId: string): Promise<AnswerableDecision | null>;
  /**
   * Records the decision as not applied (`userAction` is the button tapped); false when it
   * was answered meanwhile.
   */
  decline(
    userId: string,
    decisionId: string,
    userAction: CoachUserAction,
    now: Date
  ): Promise<boolean>;
  /** All of the user's PlannedSession rows dated from..to, tombstones included */
  listWindow(userId: string, from: string, to: string): Promise<PlannedSessionRecord[]>;
  /**
   * Writes the patches and marks the decision applied, atomically. False (and nothing
   * written) when the decision was answered meanwhile, e.g. by a double tap.
   */
  applyDecision(
    userId: string,
    decisionId: string,
    patches: CoachPatch[],
    now: Date
  ): Promise<boolean>;
  /** Undoes an applied decision atomically: writes the patches and marks it unanswered again. */
  revertDecision(userId: string, decisionId: string, patches: RollbackPatch[]): Promise<void>;
  /** Records a Discuss tap on a decision not answered yet. */
  markDiscussed(userId: string, decisionId: string): Promise<void>;
  /**
   * The message that carried the decision (HTML): the morning brief or the weekly review
   * report. Null for chat, or when none was saved.
   */
  findAnswerText(
    userId: string,
    decision: Pick<AnswerableDecision, 'id' | 'origin'>
  ): Promise<string | null>;
}

export interface CoachAnswerDeps {
  repo: CoachAnswerRepo;
  /** Discuss seeds the coach chat with the suggestion */
  chats: Pick<CoachChatRepo, 'saveMessage'>;
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
  /** Sends the changed sessions to intervals.icu (`not_connected` without a connection) */
  push: PlanPushDeps;
  /** A failed push, or a failed rollback after it */
  onPushError(error: unknown, userId: string): void;
  guardrailConfig?: GuardrailConfig;
  /** Weekly review decisions are re-checked with these (ramp cap included) */
  weeklyGuardrailConfig?: WeeklyGuardrailConfig;
  /** `COACH_DECISION_TTL_HOURS`: buttons stop working this long after the decision */
  ttlHours: number;
  now(): Date;
}

/** A tap on an Apply / Keep plan / Discuss button */
export interface CoachAnswerInput {
  decisionId: string | undefined;
  answer: CoachAnswer;
  /** The message that carried the button */
  telegramMessageId: number;
}

export const MSG_DECISION_NOT_FOUND = 'That suggestion is no longer available.';
export const MSG_ALREADY_ANSWERED = 'You already answered that suggestion.';
export const MSG_KEPT = '👍 Plan kept as it is.';
export const MSG_PLAN_CHANGED =
  'Your plan changed since that suggestion, so I didn’t apply it. Ask me again if you still want the change.';
export const MSG_APPLY_ROLLED_BACK =
  '❌ I couldn’t update intervals.icu, so I undid the change: your plan is as it was. Run /plan push later to bring intervals.icu in line.';
export const MSG_PUSH_FAILED =
  'Saved here, but I couldn’t update intervals.icu yet. Run /plan push to retry.';
export const MSG_DISCUSS =
  '💬 Let’s talk it through. What would you change, or what’s on your mind?';

type PushOutcome = 'ok' | 'rolled_back' | 'rollback_failed';

function changeLines(
  changes: readonly SessionDiff[],
  rows: readonly PlannedSessionRecord[]
): string[] {
  return describeSessionChanges(changes, rows.map(toCoachPlanSession)).map((l) => '• ' + l);
}

/**
 * The answer's result. For a morning brief or weekly review it replaces the tapped message:
 * the stored text with the result below it and no buttons. Otherwise it is a new message.
 */
async function resultReply(
  userId: string,
  decision: AnswerableDecision,
  result: string,
  deps: CoachAnswerDeps
): Promise<Reply> {
  if (decision.origin === 'chat') return result;
  const text = await deps.repo.findAnswerText(userId, decision);
  if (text === null) return result;
  return { text: text + '\n\n' + escapeHtml(result), html: true, editTapped: true };
}

/**
 * The sessions a decision may change: next week (Monday..Sunday after the review) for a
 * weekly review, otherwise today..today+6.
 */
export function decisionWindow(
  decision: Pick<AnswerableDecision, 'origin' | 'date'>,
  today: string
): DateRange {
  if (decision.origin === 'weekly') return isoWeekRange(nextIsoWeek(decision.date));
  return coachPlanWindow(today);
}

async function undoPatches(
  userId: string,
  decisionId: string,
  snapshot: PlannedSessionRecord[],
  patches: CoachPatch[],
  deps: CoachAnswerDeps
): Promise<RollbackPatch[]> {
  // Moved sessions sit on their new dates now
  const moved = patches.flatMap((p) => (p.kind === 'update' ? [p.session] : []));
  const [from, to] = dateRange([...snapshot, ...moved]);
  const current = await deps.repo.listWindow(userId, from, to);
  return buildRollbackPatches(snapshot, current, decisionId);
}

/** Undoes the decision after its push failed; the snapshot is the rows before the apply. */
async function rollBack(
  userId: string,
  decisionId: string,
  snapshot: PlannedSessionRecord[],
  patches: CoachPatch[],
  deps: CoachAnswerDeps
): Promise<PushOutcome> {
  try {
    // No snapshot: the apply changed no rows, only the decision goes back to unanswered
    const undo =
      snapshot.length === 0 ? [] : await undoPatches(userId, decisionId, snapshot, patches, deps);
    await deps.repo.revertDecision(userId, decisionId, undo);
    return 'rolled_back';
  } catch (error) {
    deps.onPushError(error, userId);
    return 'rollback_failed';
  }
}

/** Pushes only the decision's rows; a failed push rolls the decision back. */
async function pushOrRollBack(
  userId: string,
  decisionId: string,
  today: string,
  apply: { snapshot: PlannedSessionRecord[]; patches: CoachPatch[] },
  deps: CoachAnswerDeps
): Promise<PushOutcome> {
  try {
    await pushPlannedSessions(userId, today, deps.push, { coachDecisionId: decisionId });
    return 'ok';
  } catch (error) {
    deps.onPushError(error, userId);
    return rollBack(userId, decisionId, apply.snapshot, apply.patches, deps);
  }
}

function stillValidWeekly(
  decision: AnswerableDecision,
  today: string,
  sessions: CoachPlanSession[],
  context: RulesContext,
  deps: CoachAnswerDeps
): boolean {
  const check = runWeeklyGuardrails(
    { date: today, sessions, context, changes: decision.finalChanges, blockAdjustment: null },
    deps.weeklyGuardrailConfig
  );
  return check.verdict === 'accept';
}

/** The plan may have changed since the suggestion: check the changes again on today's plan. */
function stillValid(
  decision: AnswerableDecision,
  today: string,
  rows: readonly PlannedSessionRecord[],
  context: RulesContext,
  deps: CoachAnswerDeps
): boolean {
  const sessions = rows.filter((r) => r.deletedAt === null).map(toCoachPlanSession);
  if (decision.origin === 'weekly')
    return stillValidWeekly(decision, today, sessions, context, deps);
  const check = runGuardrails(
    {
      date: today,
      sessions,
      context,
      suggestion: {
        assessment: 'Applying an accepted suggestion',
        // `adjust` is weekly-only; a daily or chat decision carries an LLM action
        action: decision.finalAction === 'adjust' ? 'reduce' : decision.finalAction,
        changes: decision.finalChanges,
        confidence: 1,
        athleteMessage: 'Applying an accepted suggestion',
      },
    },
    deps.guardrailConfig
  );
  return check.verdict === 'accept';
}

/**
 * Apply: the patches are written in one transaction, then pushed to intervals.icu. When the
 * push fails, a second transaction restores the rows and leaves the decision unanswered.
 */
async function apply(
  userId: string,
  timezone: string,
  decision: AnswerableDecision,
  deps: CoachAnswerDeps
): Promise<string> {
  const now = deps.now();
  const today = localToday(now, timezone);
  const window = decisionWindow(decision, today);
  const [rows, context] = await Promise.all([
    deps.repo.listWindow(userId, window.from, window.to),
    // For a daily decision window.from is today
    deps.getRulesContext(userId, window.from),
  ]);

  if (!stillValid(decision, today, rows, context, deps)) {
    await deps.repo.decline(userId, decision.id, 'apply', now);
    return MSG_PLAN_CHANGED;
  }

  const patches = buildCoachPatches(rows, decision.finalChanges);
  const snapshot = patchedRows(rows, patches);
  if (!(await deps.repo.applyDecision(userId, decision.id, patches, now))) {
    return MSG_ALREADY_ANSWERED;
  }
  const outcome = await pushOrRollBack(userId, decision.id, today, { snapshot, patches }, deps);
  if (outcome === 'rolled_back') return MSG_APPLY_ROLLED_BACK;

  const summary = ['✅ Applied:', ...changeLines(decision.finalChanges, rows)].join('\n');
  return outcome === 'ok' ? summary : summary + '\n\n' + MSG_PUSH_FAILED;
}

/**
 * Discuss: the suggestion goes into the coach chat history as a coach message, and a new
 * message (with Apply / Keep plan for the same decision) asks what to change.
 */
async function discuss(
  userId: string,
  timezone: string,
  decision: AnswerableDecision,
  telegramMessageId: number,
  deps: CoachAnswerDeps
): Promise<Reply> {
  const today = localToday(deps.now(), timezone);
  const window = decisionWindow(decision, today);
  const rows = await deps.repo.listWindow(userId, window.from, window.to);
  const lines = changeLines(decision.finalChanges, rows);
  const seed = [decision.athleteMessage, ...(lines.length > 0 ? ['Proposed:', ...lines] : [])];

  await deps.repo.markDiscussed(userId, decision.id);
  // One row per (message, role): a retried job writes nothing new
  await deps.chats.saveMessage(userId, {
    role: 'coach',
    text: seed.join('\n'),
    telegramMessageId,
    coachDecisionId: decision.id,
  });
  if (decision.finalChanges.length === 0) return MSG_DISCUSS;
  return {
    text: MSG_DISCUSS,
    keyboard: [
      [
        { text: '✅ Apply', data: coachDecisionData('apply', decision.id) },
        { text: '➡️ Keep plan', data: coachDecisionData('keep', decision.id) },
      ],
    ],
  };
}

/**
 * The athlete's tap on Apply / Keep plan / Discuss under a morning brief, chat suggestion or
 * weekly review.
 */
export async function handleCoachAnswer(
  user: CoachChatUser,
  input: CoachAnswerInput,
  deps: CoachAnswerDeps
): Promise<Reply> {
  if (!user.profile) return MSG_NO_PROFILE;
  const { decisionId, answer } = input;
  const decision =
    decisionId === undefined ? null : await deps.repo.findDecision(user.id, decisionId);
  if (!decision) return MSG_DECISION_NOT_FOUND;
  if (decision.accepted !== null) return MSG_ALREADY_ANSWERED;
  if (isDecisionExpired(decision.createdAt, deps.now(), deps.ttlHours)) {
    return resultReply(user.id, decision, MSG_DECISION_EXPIRED, deps);
  }

  const { timezone } = user.profile;
  if (answer === 'discuss') {
    return discuss(user.id, timezone, decision, input.telegramMessageId, deps);
  }
  if (answer === 'keep') {
    const declined = await deps.repo.decline(user.id, decision.id, 'keep', deps.now());
    return declined ? resultReply(user.id, decision, MSG_KEPT, deps) : MSG_ALREADY_ANSWERED;
  }
  const result = await apply(user.id, timezone, decision, deps);
  return result === MSG_ALREADY_ANSWERED ? result : resultReply(user.id, decision, result, deps);
}
