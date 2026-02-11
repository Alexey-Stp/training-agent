import { format, subDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { User, Profile, Prisma } from '@prisma/client';
import {
  generateDraftPlan,
  applyRules,
  addOptionalSundaySwim,
  UserProfile,
  RulesContext,
  Sport,
  Intensity,
} from '@triathlon/core';
import { prisma } from './db';
import { logger } from './logger';

type UserWithProfile = User & { profile: Profile | null };

export async function handleStart(user: UserWithProfile): Promise<string> {
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
/log <sport> <minutes> [intensity] - Log a workout
  Examples:
  • /log swim 45 z2
  • /log bike 90 z4
  • /log run 60
${profileInfo}`;
}

export async function handleProfile(user: UserWithProfile): Promise<string> {
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

export async function handlePlan(user: UserWithProfile): Promise<string> {
  if (!user.profile) {
    return '❌ No profile found. Please use /start first.';
  }

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

  // Format response
  let response = `📅 7-Day Training Plan (starting ${format(now, 'PPP')})\n\n`;

  // Group by date
  const sessionsByDate = new Map<string, typeof plan.sessions>();
  plan.sessions.forEach((session) => {
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

    sessions.forEach((session) => {
      const icon = getSportIcon(session.sport);
      const optional = session.tags?.includes('optional') ? ' (optional)' : '';
      response += `  ${icon} ${session.title}${optional}\n`;
      response += `     ${session.durationMin}min • ${session.intensity.toUpperCase()}`;
      if (session.notes) {
        response += `\n     💡 ${session.notes}`;
      }
      response += '\n';
    });
  });

  // Add warnings if any
  if (plan.warnings.length > 0) {
    response += '\n⚠️ Adjustments:\n';
    plan.warnings.forEach((warning) => {
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

export async function handleUnknown(): Promise<string> {
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

  const byDate = workouts.reduce((acc, w) => {
    const existing = acc.find((x) => x.date === w.date);
    if (existing) {
      existing.minutes += w.durationMin;
    } else {
      acc.push({ date: w.date, minutes: w.durationMin });
    }
    return acc;
  }, [] as { date: string; minutes: number }[]);

  // Get today's fatigue if exists
  const fatigue = await prisma.fatigue.findUnique({
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
    todayFatigue: fatigue
      ? {
          readiness: fatigue.readiness || 3,
          sleepScore: fatigue.sleepScore || undefined,
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
    default:
      return '🏋️';
  }
}
