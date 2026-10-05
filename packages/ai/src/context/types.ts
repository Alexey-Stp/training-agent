import type {
  Intensity,
  PowerZone,
  Race,
  SeasonPlan,
  Sport,
  TrainingBlockType,
  UserProfile,
} from '@triathlon/core';

/** One Wellness row (prisma `Wellness`): device/ICU metrics plus the athlete check-in. */
export interface WellnessDay {
  date: string; // YYYY-MM-DD, athlete-local
  hrv: number | null; // rMSSD, ms
  restingHr: number | null;
  sleepHours: number | null;
  sleepScore: number | null;
  weightKg: number | null;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  subjectiveReadiness: number | null; // 1-5
  soreness: number | null;
}

/** Executed activity (prisma `Activity`), reduced to what the coach needs. */
export interface ActivitySummary {
  startDateLocal: string; // YYYY-MM-DD, athlete-local
  sport: Sport;
  name: string;
  durationSec: number;
  load: number | null;
}

export type PlannedSessionStatus =
  'draft' | 'pushed' | 'modified_externally' | 'completed' | 'skipped';

/** Planned session (prisma `PlannedSession`). Repositories leave out tombstoned rows. */
export interface PlannedSessionSummary {
  date: string; // YYYY-MM-DD, athlete-local
  slot: string;
  sport: Sport;
  title: string;
  durationMin: number;
  intensity: Intensity;
  status: PlannedSessionStatus;
  externalChange: string | null;
}

/** A suggestion the coach made and what the athlete did with it. */
export interface CoachDecision {
  date: string; // YYYY-MM-DD the decision applies to
  kind: string; // e.g. 'downgrade', 'swap', 'rest'
  summary: string;
  /** null while the athlete hasn't answered */
  accepted: boolean | null;
}

/** Data sources of the daily context. Each read is scoped to the user and a date window. */
export interface DailyContextDeps {
  profiles: { findProfile(userId: string): Promise<UserProfile | null> };
  seasons: { findActiveSeason(userId: string): Promise<SeasonPlan | null> };
  races: { listUpcoming(userId: string, fromDate: string): Promise<Race[]> };
  wellness: { listRange(userId: string, from: string, to: string): Promise<WellnessDay[]> };
  activities: { listRange(userId: string, from: string, to: string): Promise<ActivitySummary[]> };
  planned: {
    listRange(userId: string, from: string, to: string): Promise<PlannedSessionSummary[]>;
  };
  /** The latest `limit` decisions dated on or before `upTo` */
  decisions: { listRecent(userId: string, upTo: string, limit: number): Promise<CoachDecision[]> };
}

export type { PowerZone };

export interface AthleteContext {
  profile: UserProfile;
  zones: PowerZone[];
}

export interface SeasonPosition {
  seasonStart: string;
  seasonEnd: string;
  /** null when `date` falls outside every block (before the season starts or after it ends) */
  block: {
    type: TrainingBlockType;
    focus: string;
    order: number;
    count: number;
    week: number; // 1-based week of the block
    weeks: number;
  } | null;
  seasonWeek: number | null; // 1-based
  seasonWeeks: number;
  aRace: Race | null;
  daysToARace: number | null;
}

export type HrvBaselineStatus = 'ok' | 'insufficient' | 'no_today';

export interface HrvBaseline {
  status: HrvBaselineStatus;
  /** HRV samples in the 30 days before `date` */
  samples: number;
  mean: number | null;
  sd: number | null;
  today: number | null;
  /** today < mean − 1 SD */
  low: boolean;
}

export interface WellnessTrend {
  /** Oldest first; days without a row are kept with null metrics */
  days: WellnessDay[];
  avgHrv: number | null;
  avgSleepHours: number | null;
  avgRestingHr: number | null;
}

export interface TrainingLoad {
  date: string; // the row the values come from
  daysOld: number;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
}

export interface SportCompliance {
  sport: Sport;
  plannedMin: number;
  actualMin: number;
  /** actual / planned × 100, rounded; null when nothing was planned */
  pct: number | null;
}

export interface Compliance {
  from: string;
  to: string;
  bySport: SportCompliance[];
  total: Omit<SportCompliance, 'sport'>;
}

export interface HistoryDay {
  date: string;
  planned: PlannedSessionSummary[];
  actual: ActivitySummary[];
}

export interface Truncation {
  budgetTokens: number;
  estimatedTokens: number;
  historyDaysOmitted: number;
  decisionsOmitted: number;
  trendDaysOmitted: number;
  /** Still over budget after every truncatable entry was dropped */
  overBudget: boolean;
}

export interface CoachContext {
  date: string;
  athlete: AthleteContext;
  season: SeasonPosition | null;
  wellness: {
    today: WellnessDay | null;
    trend: WellnessTrend;
    hrv: HrvBaseline;
    load: TrainingLoad | null;
  };
  compliance: Compliance;
  missedKeySessions: PlannedSessionSummary[];
  upcoming: PlannedSessionSummary[];
  externallyModified: PlannedSessionSummary[];
  decisions: CoachDecision[];
  races: Race[];
  history: HistoryDay[];
  truncation: Truncation;
}
