import type { RulesContext } from '@triathlon/core';
import { isActiveSession, runGuardrails, type GuardrailResult } from '../suggestion/guardrails';
import type { SessionDiff } from '../suggestion/schema';
import type { CoachDecisionAction, CoachPlanSession } from '../suggestion/types';
import { DEFAULT_WEEKLY_GUARDRAIL_CONFIG, type WeeklyGuardrailConfig } from './prompt';
import type { BlockAdjustment } from './schema';

export interface WeeklyGuardrailInput {
  /** Today, athlete-local. Nothing before it may change. */
  date: string;
  /** Next week's planned sessions */
  sessions: readonly CoachPlanSession[];
  /** last7dStats is the reviewed week, so the weekly load cap compares against it */
  context: RulesContext;
  changes: readonly SessionDiff[];
  blockAdjustment: BlockAdjustment | null;
}

const MSG_BOTH =
  'Either nextWeekChanges or blockAdjustment, not both: the changes were not applied';

function changeable(
  session: CoachPlanSession,
  date: string,
  config: WeeklyGuardrailConfig
): boolean {
  return (
    isActiveSession(session) && session.date >= date && !config.lockedStatuses.has(session.status)
  );
}

/**
 * The block adjustment as one `durationMin` change per changeable session. Rounded to the
 * duration step towards the original, so the week never moves further than `factor` says.
 */
export function expandBlockAdjustment(
  adjustment: BlockAdjustment,
  sessions: readonly CoachPlanSession[],
  date: string,
  config: WeeklyGuardrailConfig = DEFAULT_WEEKLY_GUARDRAIL_CONFIG
): SessionDiff[] {
  const step = config.durationStepMin;
  const round = adjustment.factor > 1 ? Math.floor : Math.ceil;
  return [...sessions]
    .filter((s) => changeable(s, date, config))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot))
    .flatMap((s): SessionDiff[] => {
      const after = Math.max(step, round((s.durationMin * adjustment.factor) / step) * step);
      if (after === s.durationMin) return [];
      return [{ sessionId: s.id, field: 'durationMin', before: s.durationMin, after }];
    });
}

function plannedMinutes(sessions: readonly CoachPlanSession[]): number {
  return sessions.filter(isActiveSession).reduce((sum, s) => sum + s.durationMin, 0);
}

function rampIssue(
  before: readonly CoachPlanSession[],
  after: readonly CoachPlanSession[],
  config: WeeklyGuardrailConfig
): string | null {
  const planned = plannedMinutes(before);
  const patched = plannedMinutes(after);
  const cap = Math.floor(planned * (1 + config.maxRamp));
  if (patched <= cap) return null;
  const pct = Math.round(config.maxRamp * 100).toString();
  const added = (patched - planned).toString();
  return `Next week would grow by ${added} min to ${patched.toString()} min: catch-up exceeds the ${pct}% ramp cap (${cap.toString()} min)`;
}

/**
 * The daily guardrails on next week's sessions (integrity, per-change clamps, hard rules), then
 * the ramp cap: all changes together may add at most `maxRamp` of next week's planned minutes.
 * A block adjustment is expanded into duration changes first. Pure; never mutates input.
 */
export function runWeeklyGuardrails(
  input: WeeklyGuardrailInput,
  config: WeeklyGuardrailConfig = DEFAULT_WEEKLY_GUARDRAIL_CONFIG
): GuardrailResult {
  const original = structuredClone([...input.sessions]);
  if (input.blockAdjustment && input.changes.length > 0) {
    return { verdict: 'reject', reasons: [MSG_BOTH], changes: [], sessions: original };
  }
  const changes = input.blockAdjustment
    ? expandBlockAdjustment(input.blockAdjustment, input.sessions, input.date, config)
    : [...input.changes];
  const result = runGuardrails(
    {
      date: input.date,
      sessions: input.sessions,
      context: input.context,
      // Never `rest`: the review may shorten sessions but not cancel them
      suggestion: {
        assessment: 'Weekly review',
        action: 'reduce',
        changes,
        confidence: 1,
        athleteMessage: 'Weekly review',
      },
    },
    config
  );
  if (result.verdict === 'reject') return result;

  const ramp = rampIssue(input.sessions, result.sessions, config);
  if (ramp === null) return result;
  return { verdict: 'reject', reasons: [...result.reasons, ramp], changes: [], sessions: original };
}

function raises(diff: SessionDiff): boolean {
  if (diff.field === 'durationMin') return diff.after > diff.before;
  if (diff.field === 'intensity') return diff.after > diff.before;
  return false;
}

/** The decision's action for the log: moves and swaps first, then any increase. */
export function weeklyAction(changes: readonly SessionDiff[]): CoachDecisionAction {
  if (changes.length === 0) return 'keep';
  if (changes.some((d) => d.field === 'date')) return 'move';
  if (changes.some((d) => d.field === 'sport')) return 'swap';
  return changes.some(raises) ? 'adjust' : 'reduce';
}
