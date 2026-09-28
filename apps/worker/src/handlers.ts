import { format, subDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { User, Profile } from '@prisma/client';
import {
  generateDraftPlan,
  applyRules,
  addOptionalSundaySwim,
  UserProfile,
  RulesContext,
  Sport,
  Intensity,
  Session,
  WeekPlan,
  toPlannedSessions,
} from '@triathlon/core';
import { prisma } from './db';
import { logger } from './logger';
import { handlePlanPush, type PlanPushCommandDeps } from './plan-command';
import { materializePlan, type PlanStoreDeps, type PlannedSessionRecord } from './plan-store';

type UserWithProfile = User & { profile: Profile | null };

export function handleStart(user: UserWithProfile): string {
  const profileInfo = user.profile
    ? `\n\n📊 Your current profile:\n• FTP: ${user.profile.ftp}W\n• Timezone: ${user.profile.timezone}`
    : '';

  return `👋 Welcome to Triathlon Coach!

I'll help you plan and track your triathlon training.

Available commands:
/start - Show this help
/profile - View your current profile
/set ftp <number> - Set your FTP (e.g., /set ftp 280)
/plan - Generate a 7-day training plan
/plan push - Put the plan on your intervals.icu calendar (syncs to your watch)
/log <sport> <minutes> [intensity] - Log a workout
  Examples:
  • /log swim 45 z2
  • /log bike 90 z4
  • /log run 60
/connect icu - Link your intervals.icu account
/connect status - Show your intervals.icu link
/disconnect icu - Remove your intervals.icu link
/sync - Pull your latest intervals.icu activities and wellness now
${profileInfo}`;
}

export function handleProfile(user: UserWithProfile): string {
  if (!user.profile) {
    return '❌ No profile found. Use /start to create one.';
  }

  const p = user.profile;
  const swimDays = (p.swimDays as string[]).join(', ');

  return `📊 Your Training Profile

🚴 FTP: ${p.ftp}W
🕐 Timezone: ${p.timezone}
🏊 Swim Days: ${swimDays}
🚴 Bike VO2 Day: ${p.bikeVo2Day}
🚴 Long Bike Day: ${p.longBikeDay}
🏃 No Long Run Day: ${p.noLongRunDay}

Last updated: ${format(new Date(p.updatedAt), 'PPP')}`;
}

export async function handleSetFtp(user: UserWithProfile, ftp: number): Promise<string> {
  await prisma.profile.update({
    where: { userId: user.id },
    data: { ftp },
  });

  logger.info({ userId: user.id, ftp }, 'Updated FTP');

  return `✅ FTP updated to ${ftp}W`;
}

const MSG_NO_PROFILE = '❌ No profile found. Please use /start first.';

/** Generates the rules-applied 7-day plan starting today in the athlete's timezone. */
async function buildWeekPlan(
  user: UserWithProfile
): Promise<{ plan: WeekPlan; startDate: string; now: Date } | null> {
  if (!user.profile) return null;

  const profile: UserProfile = {
    ftp: user.profile.ftp,
    timezone: user.profile.timezone,
    swimDays: user.profile.swimDays as string[],
    bikeVo2Day: user.profile.bikeVo2Day,
    longBikeDay: user.profile.longBikeDay,
    noLongRunDay: user.profile.noLongRunDay,
  };

  // Get current date in user's timezone
  const now = toZonedTime(new Date(), profile.timezone);
  const startDate = format(now, 'yyyy-MM-dd');

  // Generate draft plan
  let plan = generateDraftPlan(profile, startDate);
  plan = addOptionalSundaySwim(plan, profile);

  // Get context for rules engine
  const context = await getRulesContext(user.id, startDate);

  // Apply rules
  plan = applyRules(plan, context);

  return { plan, startDate, now };
}

export async function handlePlanPushCommand(
  user: UserWithProfile,
  deps: PlanPushCommandDeps
): Promise<string> {
  const built = await buildWeekPlan(user);
  if (!built) return MSG_NO_PROFILE;
  return handlePlanPush(user.id, built.startDate, toPlannedSessions(built.plan), deps);
}

/** intervals.icu status line of a stored session, if there is anything to say. */
function syncStatusLabel(row: PlannedSessionRecord | undefined): string | null {
  if (!row) return null;
  switch (row.status) {
    case 'pushed':
      return '📲 In intervals.icu';
    case 'draft':
      return row.icuEventId !== null ? '✏️ Changed, not pushed yet (/plan push)' : null;
    case 'modified_externally':
      return `⚠️ Changed in intervals.icu (${row.externalChange ?? 'edited'}), your version kept`;
    case 'completed':
      return '✅ Completed';
    case 'skipped':
      return '⏭ Skipped';
  }
}

export async function handlePlan(user: UserWithProfile, store: PlanStoreDeps): Promise<string> {
  const built = await buildWeekPlan(user);
  if (!built) return MSG_NO_PROFILE;
  const { plan, startDate, now } = built;

  // Stored as PlannedSession rows so /plan push and the ICU reconcile can track them
  const drafts = toPlannedSessions(plan);
  const rows = await materializePlan(user.id, startDate, drafts, store);
  const rowByKey = new Map(rows.map((r) => [`${r.date}|${r.slot}`, r]));
  // toPlannedSessions keeps session order and only drops rest days
  const slotBySession = new Map<Session, string>();
  const trainingSessions = plan.sessions.filter((s) => s.sport !== Sport.rest && s.durationMin > 0);
  trainingSessions.forEach((s, i) => slotBySession.set(s, drafts[i].slot));

  // Format response
  let response = `📅 7-Day Training Plan (starting ${format(now, 'PPP')})\n\n`;

  // Group by date
  const sessionsByDate = new Map<string, Session[]>();
  plan.sessions.forEach((session: Session) => {
    const existing = sessionsByDate.get(session.date) || [];
    existing.push(session);
    sessionsByDate.set(session.date, existing);
  });

  // Sort dates
  const sortedDates = Array.from(sessionsByDate.keys()).sort();

  sortedDates.forEach((date) => {
    const sessions = sessionsByDate.get(date)!;
    const dateObj = new Date(date + 'T00:00:00');
    const dayName = format(dateObj, 'EEE');

    response += `\n${dayName} ${format(dateObj, 'MMM d')}:\n`;

    sessions.forEach((session: Session) => {
      const icon = getSportIcon(session.sport);
      const optional = session.tags?.includes('optional') ? ' (optional)' : '';
      response += `  ${icon} ${session.title}${optional}\n`;
      response += `     ${session.durationMin}min • ${session.intensity.toUpperCase()}`;
      if (session.notes) {
        response += `\n     💡 ${session.notes}`;
      }
      const slot = slotBySession.get(session);
      const status = slot ? syncStatusLabel(rowByKey.get(`${session.date}|${slot}`)) : null;
      if (status) {
        response += `\n     ${status}`;
      }
      response += '\n';
    });
  });

  // Add warnings if any
  if (plan.warnings.length > 0) {
    response += '\n⚠️ Adjustments:\n';
    plan.warnings.forEach((warning: string) => {
      response += `${warning}\n`;
    });
  }

  // Add applied rules summary
  if (plan.appliedRules.length > 0) {
    response += `\n📋 Applied rules: ${plan.appliedRules.length}`;
  }

  return response;
}

export async function handleLog(
  user: UserWithProfile,
  sport: string,
  durationMin: number,
  intensity?: string
): Promise<string> {
  const profile = user.profile;
  if (!profile) {
    return '❌ No profile found. Please use /start first.';
  }

  const now = toZonedTime(new Date(), profile.timezone);
  const date = format(now, 'yyyy-MM-dd');

  await prisma.workout.create({
    data: {
      userId: user.id,
      sport: sport as Sport,
      durationMin,
      intensity: intensity ? (intensity as Intensity) : null,
      date,
    },
  });

  logger.info({ userId: user.id, sport, durationMin, intensity, date }, 'Logged workout');

  const icon = getSportIcon(sport as Sport);
  const intensityStr = intensity ? ` at ${intensity.toUpperCase()}` : '';

  return `✅ Logged ${icon} ${sport} workout: ${durationMin}min${intensityStr} on ${format(now, 'PPP')}`;
}

export function handleUnknown(): string {
  return `❓ I didn't understand that command.

Available commands:
/start - Show help
/profile - View your profile
/set ftp <number> - Set your FTP
/plan - Generate training plan
/log <sport> <minutes> [intensity] - Log workout

Type /start for more details.`;
}

// Helper functions

async function getRulesContext(userId: string, startDate: string): Promise<RulesContext> {
  const startDateObj = new Date(startDate + 'T00:00:00');
  const sevenDaysAgo = format(subDays(startDateObj, 7), 'yyyy-MM-dd');

  // Get last 7 days of workouts
  const workouts = await prisma.workout.findMany({
    where: {
      userId,
      date: {
        gte: sevenDaysAgo,
        lt: startDate,
      },
    },
    orderBy: { date: 'asc' },
  });

  const totalMinutes = workouts.reduce((sum, w) => sum + w.durationMin, 0);

  const byDate = workouts.reduce(
    (acc, w) => {
      const existing = acc.find((x) => x.date === w.date);
      if (existing) {
        existing.minutes += w.durationMin;
      } else {
        acc.push({ date: w.date, minutes: w.durationMin });
      }
      return acc;
    },
    [] as { date: string; minutes: number }[]
  );

  // Today's wellness (synced device data + check-in), if any
  const wellness = await prisma.wellness.findUnique({
    where: {
      userId_date: {
        userId,
        date: startDate,
      },
    },
  });

  return {
    last7dStats: {
      totalMinutes,
      byDate,
    },
    todayWellness: wellness
      ? {
          subjectiveReadiness: wellness.subjectiveReadiness,
          sleepScore: wellness.sleepScore,
          hrv: wellness.hrv,
          restingHr: wellness.restingHr,
          tsb: wellness.tsb,
        }
      : undefined,
  };
}

function getSportIcon(sport: Sport): string {
  switch (sport) {
    case Sport.swim:
      return '🏊';
    case Sport.bike:
      return '🚴';
    case Sport.run:
      return '🏃';
    case Sport.strength:
      return '💪';
    case Sport.rest:
      return '😴';
    case Sport.other:
      return '🏅';
    default:
      return '🏋️';
  }
}
