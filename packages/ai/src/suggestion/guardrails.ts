import {
  applyRules,
  checkHardRules,
  Intensity,
  Sport,
  type RuleViolation,
  type RulesContext,
  type Session,
  type WeekPlan,
} from '@triathlon/core';
import type { PlannedSessionStatus } from '../context/types';
import { sessionLabel } from './message';
import type { CoachAction, CoachSuggestion, SessionDiff } from './schema';
import type { CoachPlanSession, GuardrailVerdict } from './types';

export interface GuardrailConfig {
  /** Largest share of a session one change may remove (cancelling needs action `rest`) */
  maxReduction: number;
  /** Clamped durations round up to this step */
  durationStepMin: number;
  /** Subjective readiness at or below this blocks intensity increases */
  lowReadiness: number;
  /** Rows the athlete or ICU owns; the coach never changes them */
  lockedStatuses: ReadonlySet<PlannedSessionStatus>;
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  maxReduction: 0.5,
  durationStepMin: 5,
  lowReadiness: 2,
  lockedStatuses: new Set<PlannedSessionStatus>(['modified_externally', 'completed', 'skipped']),
};

const INTENSITY_RANK: Record<Intensity, number> = {
  [Intensity.z1]: 1,
  [Intensity.z2]: 2,
  [Intensity.z3]: 3,
  [Intensity.z4]: 4,
  [Intensity.z5]: 5,
};

export interface GuardrailInput {
  /** Today, athlete-local. Nothing before it may change. */
  date: string;
  /** The plan window, ideally today..today+6 so the weekly load cap is meaningful */
  sessions: readonly CoachPlanSession[];
  context: RulesContext;
  suggestion: CoachSuggestion;
}

export interface GuardrailResult {
  verdict: GuardrailVerdict;
  reasons: string[];
  /** Changes that survived, after clamping. Empty on reject. */
  changes: SessionDiff[];
  /** The plan with `changes` applied (the original plan on reject) */
  sessions: CoachPlanSession[];
}

/** The rules engine's recommendation, used whenever the LLM's can't be. */
export interface Recommendation {
  action: CoachAction;
  changes: SessionDiff[];
  notes: string[];
}

interface ClampContext {
  action: CoachAction;
  trainingDates: ReadonlySet<string>;
  readiness: number | null;
  config: GuardrailConfig;
  sessions: readonly CoachPlanSession[];
}

interface ClampOutcome {
  diff: SessionDiff | null;
  reason: string | null;
}

type DurationDiff = Extract<SessionDiff, { field: 'durationMin' }>;
type IntensityDiff = Extract<SessionDiff, { field: 'intensity' }>;

/** Training, as opposed to a rest placeholder or a cancelled session. */
export function isActiveSession(session: CoachPlanSession): boolean {
  return session.sport !== Sport.rest && session.durationMin > 0;
}

function compareSessions(a: CoachPlanSession, b: CoachPlanSession): number {
  return a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot);
}

function toCoreSession(s: CoachPlanSession): Session {
  return {
    date: s.date,
    sport: s.sport,
    title: s.title,
    durationMin: s.durationMin,
    intensity: s.intensity,
    tags: s.tags,
  };
}

function toWeekPlan(date: string, sessions: readonly CoachPlanSession[]): WeekPlan {
  return {
    startDate: date,
    sessions: sessions.filter(isActiveSession).map(toCoreSession),
    warnings: [],
    appliedRules: [],
  };
}

function diffIntegrityIssue(
  diff: SessionDiff,
  session: CoachPlanSession | undefined,
  date: string,
  config: GuardrailConfig
): string | null {
  if (!session) return 'Unknown session ' + diff.sessionId;
  if (session[diff.field] !== diff.before) {
    const current = String(session[diff.field]);
    return `Stale change to ${diff.sessionId}: ${diff.field} is ${current}, not ${String(diff.before)}`;
  }
  if (session.date < date) return `${diff.sessionId} is in the past and can't change`;
  if (diff.field === 'date' && diff.after < date) {
    return `${diff.sessionId} can't move into the past (${diff.after})`;
  }
  if (config.lockedStatuses.has(session.status)) {
    return `${diff.sessionId} is ${session.status} and can't change`;
  }
  return null;
}

/** Problems that mean the suggestion was built on the wrong data. Any of them rejects it. */
function integrityIssues(input: GuardrailInput, config: GuardrailConfig): string[] {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const keys = input.suggestion.changes.map((d) => d.sessionId + '|' + d.field);
  const duplicates = keys
    .filter((key, i) => keys.indexOf(key) !== i)
    .map((key) => 'More than one change to ' + key.replaceAll('|', ' '));
  const issues = input.suggestion.changes.map((d) =>
    diffIntegrityIssue(d, byId.get(d.sessionId), input.date, config)
  );
  return [...duplicates, ...issues.filter((issue): issue is string => issue !== null)];
}

function keep(diff: SessionDiff): ClampOutcome {
  return { diff, reason: null };
}

function drop(reason: string): ClampOutcome {
  return { diff: null, reason };
}

/** Shortest a session may become in one change, rounded up to the duration step. */
function minimumDuration(before: number, config: GuardrailConfig): number {
  const step = config.durationStepMin;
  return Math.min(before, Math.ceil((before * (1 - config.maxReduction)) / step) * step);
}

function clampDuration(diff: DurationDiff, label: string, ctx: ClampContext): ClampOutcome {
  if (diff.after >= diff.before) return keep(diff);
  if (diff.after === 0 && ctx.action === 'rest') return keep(diff);
  const floor = minimumDuration(diff.before, ctx.config);
  if (diff.after >= floor) return keep(diff);
  const percent = Math.round(ctx.config.maxReduction * 100).toString();
  return {
    diff: { ...diff, after: floor },
    reason: `${label} cut to ${floor.toString()} min, not ${diff.after.toString()}: one change never removes more than ${percent}% of a session`,
  };
}

function clampIntensity(diff: IntensityDiff, label: string, ctx: ClampContext): ClampOutcome {
  const lowReadiness = ctx.readiness !== null && ctx.readiness <= ctx.config.lowReadiness;
  if (!lowReadiness || INTENSITY_RANK[diff.after] <= INTENSITY_RANK[diff.before]) {
    return keep(diff);
  }
  const readiness = String(ctx.readiness);
  return drop(
    `${label} stays ${diff.before.toUpperCase()}: no intensity increases while readiness is low (${readiness}/5)`
  );
}

function clampDiff(diff: SessionDiff, session: CoachPlanSession, ctx: ClampContext): ClampOutcome {
  const label = sessionLabel(session.id, ctx.sessions);
  switch (diff.field) {
    case 'durationMin':
      return clampDuration(diff, label, ctx);
    case 'intensity':
      return clampIntensity(diff, label, ctx);
    case 'date':
      return ctx.trainingDates.has(diff.after)
        ? keep(diff)
        : drop(`${label} stays on ${session.date}: ${diff.after} is a rest day`);
    case 'sport':
      return diff.after === Sport.rest || ctx.trainingDates.has(session.date)
        ? keep(diff)
        : drop(`${label} stays ${diff.before}: ${session.date} is a rest day`);
  }
}

function clampChanges(
  input: GuardrailInput,
  config: GuardrailConfig
): { changes: SessionDiff[]; reasons: string[] } {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const ctx: ClampContext = {
    action: input.suggestion.action,
    trainingDates: new Set(input.sessions.filter(isActiveSession).map((s) => s.date)),
    readiness: input.context.todayWellness?.subjectiveReadiness ?? null,
    config,
    sessions: input.sessions,
  };
  const outcomes = input.suggestion.changes.map((diff) => {
    const session = byId.get(diff.sessionId);
    return session ? clampDiff(diff, session, ctx) : keep(diff);
  });
  return {
    changes: outcomes.flatMap((o) => (o.diff ? [o.diff] : [])),
    reasons: outcomes.flatMap((o) => (o.reason ? [o.reason] : [])),
  };
}

function setField(session: CoachPlanSession, diff: SessionDiff): void {
  switch (diff.field) {
    case 'durationMin':
      session.durationMin = diff.after;
      break;
    case 'intensity':
      session.intensity = diff.after;
      break;
    case 'date':
      session.date = diff.after;
      break;
    case 'sport':
      session.sport = diff.after;
      break;
  }
}

function applyDiffs(
  sessions: readonly CoachPlanSession[],
  diffs: readonly SessionDiff[]
): CoachPlanSession[] {
  const patched = structuredClone([...sessions]);
  const byId = new Map(patched.map((s) => [s.id, s]));
  diffs.forEach((diff) => {
    const session = byId.get(diff.sessionId);
    if (session) setField(session, diff);
  });
  return patched;
}

function totalMinutes(plan: WeekPlan): number {
  return plan.sessions.reduce((sum, s) => sum + s.durationMin, 0);
}

function violationKey(v: RuleViolation): string {
  return v.rule + '|' + v.dates.join(',');
}

/**
 * Hard-rule violations the change introduced. Ones the plan already had are not the LLM's
 * fault, except an over-cap week the change made longer still.
 */
function newViolations(before: WeekPlan, after: WeekPlan, context: RulesContext): RuleViolation[] {
  const existing = new Set(checkHardRules(before, context).map(violationKey));
  const longer = totalMinutes(after) > totalMinutes(before);
  return checkHardRules(after, context).filter(
    (v) => !existing.has(violationKey(v)) || (v.rule === 'WeeklyLoadCap' && longer)
  );
}

function rejected(reasons: string[], sessions: CoachPlanSession[]): GuardrailResult {
  return { verdict: 'reject', reasons, changes: [], sessions };
}

/**
 * Checks an LLM suggestion against the plan: integrity (reject), per-change limits (clamp),
 * then the rules engine's hard rules on the patched plan (reject). Pure; never mutates input.
 */
export function runGuardrails(
  input: GuardrailInput,
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG
): GuardrailResult {
  const original = structuredClone([...input.sessions]);
  const issues = integrityIssues(input, config);
  if (issues.length > 0) return rejected(issues, original);

  const clamped = clampChanges(input, config);
  const patched = applyDiffs(original, clamped.changes);
  const violations = newViolations(
    toWeekPlan(input.date, original),
    toWeekPlan(input.date, patched),
    input.context
  );
  if (violations.length > 0) {
    return rejected([...clamped.reasons, ...violations.map((v) => v.message)], original);
  }
  return {
    verdict: clamped.reasons.length > 0 ? 'clamp' : 'accept',
    reasons: clamped.reasons,
    changes: clamped.changes,
    sessions: patched,
  };
}

function safetyDiffs(before: CoachPlanSession, after: Session): SessionDiff[] {
  const diffs: SessionDiff[] = [];
  if (INTENSITY_RANK[after.intensity] < INTENSITY_RANK[before.intensity]) {
    diffs.push({
      sessionId: before.id,
      field: 'intensity',
      before: before.intensity,
      after: after.intensity,
    });
  }
  if (after.durationMin < before.durationMin) {
    diffs.push({
      sessionId: before.id,
      field: 'durationMin',
      before: before.durationMin,
      after: after.durationMin,
    });
  }
  return diffs;
}

/**
 * What the rules engine alone recommends for the window. Only downgrades and reductions count:
 * rows don't store tags, so SwimRotation's re-labelling would otherwise read as changes.
 */
export function deterministicRecommendation(
  date: string,
  sessions: readonly CoachPlanSession[],
  context: RulesContext,
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG
): Recommendation {
  // Sorted the way NoHardHard sorts (stable), so the output stays index-aligned with `active`
  const active = sessions.filter(isActiveSession).sort(compareSessions);
  const plan = applyRules(toWeekPlan(date, active), context);
  if (plan.sessions.length !== active.length) {
    throw new Error('Rules engine changed the number of sessions');
  }
  const changes = active.flatMap((s, i) =>
    s.date >= date && !config.lockedStatuses.has(s.status) ? safetyDiffs(s, plan.sessions[i]) : []
  );
  return { action: changes.length > 0 ? 'reduce' : 'keep', changes, notes: plan.warnings };
}
