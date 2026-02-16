import { parseISO, getDay } from 'date-fns';
import { WeekPlan, RulesContext, isHardSession, downgradeToEasy, Intensity, Sport } from './types';

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
    const date = parseISO(session.date);
    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][getDay(date)];

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

// Hard Rule 2: ReadinessDownshift - if fatigue/readiness <= 2, downgrade hard sessions in next 24h
function applyReadinessDownshiftRule(plan: WeekPlan, context: RulesContext): WeekPlan {
  if (!context.todayFatigue || context.todayFatigue.readiness > 2) {
    return plan;
  }

  const sessions = [...plan.sessions];
  const warnings = [...plan.warnings];
  const appliedRules = [...plan.appliedRules];
  const todayStr = plan.startDate;

  let modified = false;

  sessions.forEach((session, idx) => {
    if (session.date === todayStr && isHardSession(session)) {
      sessions[idx] = downgradeToEasy(
        session,
        `Low readiness (${context.todayFatigue!.readiness}/5)`
      );
      modified = true;
    }
  });

  if (modified) {
    warnings.push(
      `⚠️ Low readiness detected (${context.todayFatigue.readiness}/5). Hard sessions downgraded to Z2.`
    );
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
  let previousWasHard = false;
  let previousDate: string | null = null;

  sessions.forEach((session, idx) => {
    const currentHard = isHardSession(session);

    // Check if this is consecutive day
    const isConsecutive = previousDate && isNextDay(previousDate, session.date);

    if (isConsecutive && previousWasHard && currentHard) {
      // Downgrade this session
      sessions[idx] = downgradeToEasy(session, 'No back-to-back hard sessions allowed');
      modified = true;
      previousWasHard = false; // After downgrade, this is no longer hard
    } else {
      previousWasHard = currentHard;
    }

    previousDate = session.date;
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

// Helper function to check if two dates are consecutive days
function isNextDay(date1: string, date2: string): boolean {
  const d1 = new Date(date1 + 'T00:00:00');
  const d2 = new Date(date2 + 'T00:00:00');
  const diff = d2.getTime() - d1.getTime();
  const dayInMs = 24 * 60 * 60 * 1000;
  return diff === dayInMs;
}
