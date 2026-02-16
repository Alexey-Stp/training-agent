export enum Sport {
  swim = 'swim',
  bike = 'bike',
  run = 'run',
  strength = 'strength',
  rest = 'rest',
}

export enum Intensity {
  z1 = 'z1',
  z2 = 'z2',
  z3 = 'z3',
  z4 = 'z4',
  z5 = 'z5',
}

export interface Session {
  date: string; // YYYY-MM-DD
  sport: Sport;
  title: string;
  durationMin: number;
  intensity: Intensity;
  notes?: string;
  tags?: string[];
}

export interface WeekPlan {
  startDate: string; // YYYY-MM-DD
  sessions: Session[];
  warnings: string[];
  appliedRules: string[];
}

export interface UserProfile {
  ftp: number;
  timezone: string;
  swimDays: string[]; // e.g., ["Wed", "Fri", "Sun_optional"]
  bikeVo2Day: string;
  longBikeDay: string;
  noLongRunDay: string;
}

export interface WorkoutLog {
  sport: Sport;
  durationMin: number;
  intensity?: Intensity;
  date: string;
}

export interface RulesContext {
  last7dStats: {
    totalMinutes: number;
    byDate: { date: string; minutes: number }[];
  };
  todayFatigue?: {
    readiness: number; // 1-5
    sleepScore?: number;
  };
}

export interface CommandJob {
  telegramChatId: number;
  telegramUserId: number;
  messageId: number;
  commandName: string;
  args: string[];
  rawText: string;
}

export const HARD_INTENSITIES = new Set<Intensity>([Intensity.z4, Intensity.z5]);
export const HARD_TAGS = new Set<string>(['vo2', 'threshold']);

export function isHardSession(session: Session): boolean {
  if (HARD_INTENSITIES.has(session.intensity)) return true;
  if (session.tags && session.tags.some((tag) => HARD_TAGS.has(tag))) return true;
  return false;
}

export function downgradeToEasy(session: Session, reason: string): Session {
  return {
    ...session,
    intensity: Intensity.z2,
    title: `${session.title} (downgraded to Z2)`,
    notes: `${session.notes || ''}\nDowngraded: ${reason}`.trim(),
    tags: session.tags?.filter((tag) => !HARD_TAGS.has(tag)),
  };
}
