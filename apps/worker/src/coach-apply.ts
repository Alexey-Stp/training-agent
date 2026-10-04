import { localToday, type CoachAnswer, type RulesContext } from '@triathlon/core';
import {
  describeChange,
  runGuardrails,
  type CoachAction,
  type GuardrailConfig,
  type SessionDiff,
} from '@triathlon/ai';
import {
  buildCoachPatches,
  coachPlanWindow,
  toCoachPlanSession,
  type CoachPatch,
} from './coach-plan';
import { pushPlannedSessions, type PlanPushDeps } from './plan-push';
import type { PlannedSessionRecord } from './plan-store';
import { MSG_NO_PROFILE } from './profile';
import type { CoachChatUser } from './coach-chat-command';

/** What Apply/Keep needs of a stored `CoachDecision` */
export interface AnswerableDecision {
  id: string;
  finalAction: CoachAction;
  finalChanges: SessionDiff[];
  accepted: boolean | null;
}

export interface CoachAnswerRepo {
  findDecision(userId: string, decisionId: string): Promise<AnswerableDecision | null>;
  /** Records a Keep; false when the decision was answered meanwhile */
  decline(userId: string, decisionId: string, now: Date): Promise<boolean>;
  /** All of the user's PlannedSession rows dated from..to, tombstones included */
  listWindow(userId: string, from: string, to: string): Promise<PlannedSessionRecord[]>;
  /**
   * Writes the patches and marks the decision accepted, atomically. False (and nothing
   * written) when the decision was answered meanwhile, e.g. by a double tap.
   */
  applyDecision(
    userId: string,
    decisionId: string,
    patches: CoachPatch[],
    now: Date
  ): Promise<boolean>;
}

export interface CoachAnswerDeps {
  repo: CoachAnswerRepo;
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
  /** Sends the changed sessions to intervals.icu (`not_connected` without a connection) */
  push: PlanPushDeps;
  onPushError(error: unknown, userId: string): void;
  guardrailConfig?: GuardrailConfig;
  now(): Date;
}

export const MSG_DECISION_NOT_FOUND = 'That suggestion is no longer available.';
export const MSG_ALREADY_ANSWERED = 'You already answered that suggestion.';
export const MSG_KEPT = '👍 Plan kept as it is.';
export const MSG_PLAN_CHANGED =
  'Your plan changed since that suggestion, so I didn’t apply it. Ask me again if you still want the change.';
export const MSG_PUSH_FAILED =
  'Saved here, but I couldn’t update intervals.icu yet. Run /plan push to retry.';

function applied(changes: readonly SessionDiff[], rows: readonly PlannedSessionRecord[]): string {
  const sessions = rows.map(toCoachPlanSession);
  const lines = changes.map((c) => '• ' + describeChange(c, sessions));
  return ['✅ Applied:', ...lines].join('\n');
}

async function pushAfterApply(userId: string, today: string, deps: CoachAnswerDeps) {
  try {
    await pushPlannedSessions(userId, today, deps.push);
    return null;
  } catch (error) {
    deps.onPushError(error, userId);
    return MSG_PUSH_FAILED;
  }
}

async function apply(
  user: CoachChatUser & { profile: { timezone: string } },
  decision: AnswerableDecision,
  deps: CoachAnswerDeps
): Promise<string> {
  const now = deps.now();
  const today = localToday(now, user.profile.timezone);
  const window = coachPlanWindow(today);
  const [rows, context] = await Promise.all([
    deps.repo.listWindow(user.id, window.from, window.to),
    deps.getRulesContext(user.id, today),
  ]);

  // The plan may have changed since the suggestion: check the changes again on today's plan
  const sessions = rows.filter((r) => r.deletedAt === null).map(toCoachPlanSession);
  const check = runGuardrails(
    {
      date: today,
      sessions,
      context,
      suggestion: {
        assessment: 'Applying an accepted suggestion',
        action: decision.finalAction,
        changes: decision.finalChanges,
        confidence: 1,
        athleteMessage: 'Applying an accepted suggestion',
      },
    },
    deps.guardrailConfig
  );
  if (check.verdict !== 'accept') {
    await deps.repo.decline(user.id, decision.id, now);
    return MSG_PLAN_CHANGED;
  }

  const patches = buildCoachPatches(rows, decision.finalChanges);
  if (!(await deps.repo.applyDecision(user.id, decision.id, patches, now))) {
    return MSG_ALREADY_ANSWERED;
  }
  const pushNote = await pushAfterApply(user.id, today, deps);
  const summary = applied(decision.finalChanges, rows);
  return pushNote === null ? summary : summary + '\n\n' + pushNote;
}

/** The athlete's tap on Apply or Keep under a coach-chat suggestion. */
export async function handleCoachAnswer(
  user: CoachChatUser,
  decisionId: string | undefined,
  answer: CoachAnswer,
  deps: CoachAnswerDeps
): Promise<string> {
  if (!user.profile) return MSG_NO_PROFILE;
  const decision =
    decisionId === undefined ? null : await deps.repo.findDecision(user.id, decisionId);
  if (!decision) return MSG_DECISION_NOT_FOUND;
  if (decision.accepted !== null) return MSG_ALREADY_ANSWERED;

  if (answer === 'keep') {
    const declined = await deps.repo.decline(user.id, decision.id, deps.now());
    return declined ? MSG_KEPT : MSG_ALREADY_ANSWERED;
  }
  return apply({ ...user, profile: user.profile }, decision, deps);
}
