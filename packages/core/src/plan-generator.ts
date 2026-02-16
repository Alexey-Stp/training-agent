import { addDays, format, getDay } from 'date-fns';
import { Sport, Intensity, Session, WeekPlan, UserProfile } from './types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function generateDraftPlan(profile: UserProfile, startDate: string): WeekPlan {
  const sessions: Session[] = [];
  const baseDate = new Date(startDate + 'T00:00:00');

  for (let i = 0; i < 7; i++) {
    const currentDate = addDays(baseDate, i);
    const dateStr = format(currentDate, 'yyyy-MM-dd');
    const dayName = DAY_NAMES[getDay(currentDate)];

    const session = generateSessionForDay(dayName, dateStr, profile);
    if (session) {
      sessions.push(session);
    }
  }

  return {
    startDate,
    sessions,
    warnings: [],
    appliedRules: [],
  };
}

function generateSessionForDay(
  dayName: string,
  date: string,
  profile: UserProfile
): Session | null {
  // Template mapping:
  // Mon: bike Z2 60m (or rest if fatigue low)
  // Tue: run intervals Z4 50-60m
  // Wed: swim technique 45-60m
  // Thu: bike VO2 Z5 60-75m (tag "vo2")
  // Fri: swim intervals 45-60m
  // Sat: run tempo Z3/Z4 45-60m
  // Sun: long bike Z2 150-210m (tag "long") + optional swim easy 30-45m (tag "optional")

  switch (dayName) {
    case 'Mon':
      return {
        date,
        sport: Sport.bike,
        title: 'Bike Endurance',
        durationMin: 60,
        intensity: Intensity.z2,
        notes: 'Easy spin, focus on cadence',
      };

    case 'Tue':
      return {
        date,
        sport: Sport.run,
        title: 'Run Intervals',
        durationMin: 55,
        intensity: Intensity.z4,
        notes: 'Warm up 15min, 5x3min Z4 (2min rest), cool down',
      };

    case 'Wed':
      if (profile.swimDays.includes('Wed')) {
        return {
          date,
          sport: Sport.swim,
          title: 'Swim Technique',
          durationMin: 50,
          intensity: Intensity.z2,
          notes: 'Drills and technique work',
          tags: ['technique'],
        };
      }
      return {
        date,
        sport: Sport.rest,
        title: 'Rest Day',
        durationMin: 0,
        intensity: Intensity.z1,
      };

    case 'Thu':
      if (dayName === profile.bikeVo2Day) {
        return {
          date,
          sport: Sport.bike,
          title: 'Bike VO2 Max',
          durationMin: 70,
          intensity: Intensity.z5,
          notes: 'Warm up 20min, 5x5min Z5 (3min rest), cool down',
          tags: ['vo2'],
        };
      }
      return {
        date,
        sport: Sport.bike,
        title: 'Bike Threshold',
        durationMin: 70,
        intensity: Intensity.z4,
        tags: ['threshold'],
      };

    case 'Fri':
      if (profile.swimDays.includes('Fri')) {
        return {
          date,
          sport: Sport.swim,
          title: 'Swim Intervals',
          durationMin: 50,
          intensity: Intensity.z4,
          notes: '10x100m at threshold pace',
          tags: ['intervals'],
        };
      }
      return {
        date,
        sport: Sport.rest,
        title: 'Rest Day',
        durationMin: 0,
        intensity: Intensity.z1,
      };

    case 'Sat':
      return {
        date,
        sport: Sport.run,
        title: 'Run Tempo',
        durationMin: 50,
        intensity: Intensity.z3,
        notes: 'Warm up 15min, 20min Z3, cool down',
      };

    case 'Sun':
      if (dayName === profile.longBikeDay) {
        return {
          date,
          sport: Sport.bike,
          title: 'Long Bike',
          durationMin: 180,
          intensity: Intensity.z2,
          notes: 'Steady endurance ride, nutrition practice',
          tags: ['long'],
        };
      }
      return {
        date,
        sport: Sport.bike,
        title: 'Bike Endurance',
        durationMin: 90,
        intensity: Intensity.z2,
      };

    default:
      return null;
  }
}

// Helper to add optional Sunday swim if configured
export function addOptionalSundaySwim(plan: WeekPlan, profile: UserProfile): WeekPlan {
  if (!profile.swimDays.includes('Sun_optional')) {
    return plan;
  }

  const sundaySession = plan.sessions.find((s) => {
    const dayName = DAY_NAMES[getDay(new Date(s.date + 'T00:00:00'))];
    return dayName === 'Sun';
  });

  if (sundaySession) {
    const optionalSwim: Session = {
      date: sundaySession.date,
      sport: Sport.swim,
      title: 'Optional Easy Swim',
      durationMin: 35,
      intensity: Intensity.z1,
      notes: 'Recovery swim after long bike',
      tags: ['optional'],
    };

    return {
      ...plan,
      sessions: [...plan.sessions, optionalSwim],
    };
  }

  return plan;
}
