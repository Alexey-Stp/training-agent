import { differenceInCalendarDays, parseISO } from 'date-fns';
import { dayNameOf } from './plan-generator';
import {
  WeekPlan,
  RulesContext,
  Session,
  isHardSession,
  downgradeToEasy,
  Intensity,
  Sport,
} from './types';

export type HardRule = 'NoHardHard' | 'ReadinessDownshift' | 'WeeklyLoadCap';

/** A hard rule a plan still breaks (see `checkHardRules`). */
export interface RuleViolation {
  rule: HardRule;
  message: string;
  /** Dates of the sessions involved; empty for week-level rules */
  dates: string[];
}

export function applyRules(weekPlan: WeekPlan, context: RulesContext): WeekPlan {
  let plan: WeekPlan = { ...weekPlan, warnings: [], appliedRules: [] };

  // Apply rules in order
  plan = applySwimRotationRule(plan);
  plan = applyReadinessDownshiftRule(plan, context);
  plan = applyNoHardHardRule(plan);
  plan = applyWeeklyLoadCapRule(plan, context);

  return plan;
}

// Soft Rule 4: SwimRotation - ensure Wed is technique, Fri is intervals
function applySwimRotationRule(plan: WeekPlan): WeekPlan {
  const sessions = [...plan.sessions];
  const appliedRules = [...plan.appliedRules];
  let modified = false;

  sessions.forEach((session, idx) => {
    const dayName = dayNameOf(session.date);

    if (session.sport === Sport.swim) {
      if (dayName === 'Wed' && !session.tags?.includes('technique')) {
        sessions[idx] = {
          ...session,
          title: 'Swim Technique',
          tags: ['technique'],
          notes: `${session.notes || ''}\nAdjusted to technique session`.trim(),
        };
        modified = true;
      }

      if (dayName === 'Fri' && !session.tags?.includes('intervals')) {
        sessions[idx] = {
          ...session,
          title: 'Swim Intervals',
          tags: ['intervals'],
          intensity: Intensity.z4,
          notes: `${session.notes || ''}\nAdjusted to intervals session`.trim(),
        };
        modified = true;
      }
    }
  });

  if (modified) {
    appliedRules.push('SwimRotation: Adjusted swim sessions to match Wed=technique, Fri=intervals');
  }

  return { ...plan, sessions, appliedRules };
}

// Hard Rule 2: ReadinessDownshift - if today's subjective readiness <= 2, downgrade today's hard sessions
function applyReadinessDownshiftRule(plan: WeekPlan, context: RulesContext): WeekPlan {
  const readiness = context.todayWellness?.subjectiveReadiness;
  if (readiness == null || readiness > 2) {
    return plan;
  }

  const sessions = [...plan.sessions];
  const warnings = [...plan.warnings];
  const appliedRules = [...plan.appliedRules];
  const todayStr = plan.startDate;

  let modified = false;

  sessions.forEach((session, idx) => {
    if (session.date === todayStr && isHardSession(session)) {
      sessions[idx] = downgradeToEasy(session, `Low readiness (${readiness}/5)`);
      modified = true;
    }
  });

  if (modified) {
    warnings.push(`⚠️ Low readiness detected (${readiness}/5). Hard sessions downgraded to Z2.`);
    appliedRules.push('ReadinessDownshift: Downgraded hard sessions due to low readiness');
  }

  return { ...plan, sessions, warnings, appliedRules };
}

// Hard Rule 1: NoHardHard - no two consecutive hard days
function applyNoHardHardRule(plan: WeekPlan): WeekPlan {
  const sessions = [...plan.sessions].sort((a, b) => a.date.localeCompare(b.date));
  const warnings = [...plan.warnings];
  const appliedRules = [...plan.appliedRules];

  let modified = false;
  // Last date that kept a hard session. Easy sessions don't reset it, so an easy session
  // after a hard one on the same day doesn't let a hard session through the next day.
  let lastHardDate: string | null = null;

  sessions.forEach((session, idx) => {
    if (!isHardSession(session)) return;

    if (lastHardDate !== null && isNextDay(lastHardDate, session.date)) {
      sessions[idx] = downgradeToEasy(session, 'No back-to-back hard sessions allowed');
      modified = true;
    } else {
      lastHardDate = session.date;
    }
  });

  if (modified) {
    warnings.push('⚠️ Adjusted plan to avoid back-to-back hard sessions');
    appliedRules.push('NoHardHard: Prevented consecutive hard training days');
  }

  return { ...plan, sessions, warnings, appliedRules };
}

// Hard Rule 3: WeeklyLoadCap - limit weekly load to 110% of last week
function applyWeeklyLoadCapRule(plan: WeekPlan, context: RulesContext): WeekPlan {
  const lastWeekMinutes = context.last7dStats.totalMinutes;

  // If no history, skip this rule
  if (lastWeekMinutes === 0) {
    return plan;
  }

  const sessions = [...plan.sessions];
  const warnings = [...plan.warnings];
  const appliedRules = [...plan.appliedRules];

  const plannedMinutes = sessions.reduce((sum, s) => sum + s.durationMin, 0);
  const maxAllowedMinutes = Math.round(lastWeekMinutes * 1.1);

  if (plannedMinutes <= maxAllowedMinutes) {
    return plan;
  }

  // Scale down sessions proportionally, keeping min 30m
  const scaleFactor = maxAllowedMinutes / plannedMinutes;

  sessions.forEach((session, idx) => {
    if (session.sport !== Sport.rest && session.durationMin > 0) {
      const newDuration = Math.max(30, Math.round(session.durationMin * scaleFactor));
      if (newDuration !== session.durationMin) {
        sessions[idx] = {
          ...session,
          durationMin: newDuration,
          notes: `${session.notes || ''}\nDuration adjusted for progressive load management`.trim(),
        };
      }
    }
  });

  warnings.push(
    `⚠️ Weekly load capped at 110% of last week (${lastWeekMinutes}min → ${maxAllowedMinutes}min max)`
  );
  appliedRules.push(
    `WeeklyLoadCap: Scaled durations from ${plannedMinutes}min to ${maxAllowedMinutes}min`
  );

  return { ...plan, sessions, warnings, appliedRules };
}

// Calendar days, so a DST change between the two dates doesn't matter
function isNextDay(date1: string, date2: string): boolean {
  return differenceInCalendarDays(parseISO(date2), parseISO(date1)) === 1;
}

/**
 * Hard rules the plan still breaks. `applyRules` corrects a plan; this only checks one,
 * so callers can gate on its output being empty.
 */
export function checkHardRules(plan: WeekPlan, context: RulesContext): RuleViolation[] {
  return [
    ...hardHardViolations(plan.sessions),
    ...readinessViolations(plan, context),
    ...loadCapViolations(plan, context),
  ];
}

function hardHardViolations(sessions: Session[]): RuleViolation[] {
  const hardDates = [...new Set(sessions.filter(isHardSession).map((s) => s.date))].sort((a, b) =>
    a.localeCompare(b)
  );
  const violations: RuleViolation[] = [];
  for (let i = 1; i < hardDates.length; i++) {
    const [prev, date] = [hardDates[i - 1], hardDates[i]];
    if (isNextDay(prev, date)) {
      violations.push({
        rule: 'NoHardHard',
        message: `Hard sessions on consecutive days (${prev}, ${date})`,
        dates: [prev, date],
      });
    }
  }
  return violations;
}

function readinessViolations(plan: WeekPlan, context: RulesContext): RuleViolation[] {
  const readiness = context.todayWellness?.subjectiveReadiness;
  if (readiness == null || readiness > 2) return [];
  const hardToday = plan.sessions.some((s) => s.date === plan.startDate && isHardSession(s));
  if (!hardToday) return [];
  return [
    {
      rule: 'ReadinessDownshift',
      message: `Hard session on ${plan.startDate} despite low readiness (${readiness}/5)`,
      dates: [plan.startDate],
    },
  ];
}

function loadCapViolations(plan: WeekPlan, context: RulesContext): RuleViolation[] {
  const lastWeekMinutes = context.last7dStats.totalMinutes;
  if (lastWeekMinutes === 0) return [];
  const plannedMinutes = plan.sessions.reduce((sum, s) => sum + s.durationMin, 0);
  const maxAllowedMinutes = Math.round(lastWeekMinutes * 1.1);
  if (plannedMinutes <= maxAllowedMinutes) return [];
  return [
    {
      rule: 'WeeklyLoadCap',
      message: `Week totals ${plannedMinutes}min, above the 110% cap of ${maxAllowedMinutes}min`,
      dates: [],
    },
  ];
}
