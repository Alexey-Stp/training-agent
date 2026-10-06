export enum Sport {
  swim = 'swim',
  bike = 'bike',
  run = 'run',
  strength = 'strength',
  rest = 'rest',
  other = 'other',
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
  /**
   * Set on A-race taper and race weeks. Their volume drops on purpose, so WeeklyLoadCap
   * treats the reduction as valid and doesn't cap the week.
   */
  phase?: 'taper' | 'race';
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
  /** Today's Wellness row (athlete-local date), if one exists. */
  todayWellness?: {
    subjectiveReadiness: number | null; // 1-5, athlete check-in
    sleepScore: number | null;
    hrv: number | null; // rMSSD, ms
    restingHr: number | null;
    tsb: number | null; // form = ctl - atl
  };
}

export interface CommandJob {
  telegramChatId: number;
  telegramUserId: number;
  messageId: number;
  commandName: string;
  args: string[];
  rawText: string;
  /** Set only for `connect_icu` jobs. The API key is encrypted by the bot before enqueueing. */
  icuCredentials?: IcuCredentialsPayload;
}

/** Payload of `icu-sync` queue jobs (scheduled per linked athlete, see worker sync-scheduler.ts) */
export interface IcuSyncJob {
  userId: string;
}

export interface IcuCredentialsPayload {
  athleteId: string;
  apiKeyCiphertext: string;
  apiKeyIv: string;
}

export const HARD_INTENSITIES = new Set<Intensity>([Intensity.z4, Intensity.z5]);
export const HARD_TAGS = new Set<string>(['vo2', 'threshold']);

export function isHardSession(session: Session): boolean {
  if (HARD_INTENSITIES.has(session.intensity)) return true;
  if (session.tags?.some((tag) => HARD_TAGS.has(tag))) return true;
  return false;
}

/** Tag of the race itself; a race session is never downgraded, scaled or counted as volume. */
export const RACE_TAG = 'race';
/** Tag of sessions inside a taper (A taper/race weeks, B-race mini-taper days) */
export const TAPER_TAG = 'taper';
/** Tag of a short pre-race opener (race-pace touches, not a hard session) */
export const OPENERS_TAG = 'openers';
/** Tag of a taper key session: race-pace intervals, shortened */
export const SHARPENING_TAG = 'sharpening';

export function isRaceSession(session: Pick<Session, 'tags'>): boolean {
  return session.tags?.includes(RACE_TAG) ?? false;
}

/** A session with intensity work: hard, or an opener. The race itself doesn't count. */
export function isIntensitySession(session: Session): boolean {
  if (isRaceSession(session)) return false;
  return isHardSession(session) || (session.tags?.includes(OPENERS_TAG) ?? false);
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
