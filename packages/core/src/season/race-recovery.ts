import { addDays, format, parseISO } from 'date-fns';
import { Intensity, Session, Sport, TAPER_TAG } from '../types';
import { Race, RacePriority, RaceType } from './types';

/** Tag of the easy sessions after a race */
export const RECOVERY_TAG = 'recovery';

export interface RecoveryConfig {
  /** Days after the race (race day excluded) that hold only Z1 or rest */
  days: Record<RacePriority, Record<RaceType, number>>;
  /** Complete rest days right after the race */
  restDays: Record<RacePriority, number>;
  /** Length of each easy session */
  sessionMin: number;
}

const same = (days: number): Record<RaceType, number> => ({
  [RaceType.sprint]: days,
  [RaceType.olympic]: days,
  [RaceType.half]: days,
  [RaceType.full]: days,
  [RaceType.run]: days,
  [RaceType.other]: days,
});

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  days: {
    [RacePriority.A]: {
      ...same(7),
      [RaceType.half]: 10,
      [RaceType.full]: 14,
      [RaceType.run]: 10,
    },
    [RacePriority.B]: {
      ...same(3),
      [RaceType.sprint]: 2,
      [RaceType.half]: 4,
      [RaceType.full]: 4,
      [RaceType.other]: 2,
    },
    [RacePriority.C]: {
      ...same(0),
      [RaceType.olympic]: 1,
      [RaceType.half]: 2,
      [RaceType.full]: 2,
      [RaceType.run]: 1,
    },
  },
  restDays: { [RacePriority.A]: 3, [RacePriority.B]: 1, [RacePriority.C]: 0 },
  sessionMin: 30,
};

/** Most days any race can reach past its date; callers load races this far past a range. */
export function maxRecoveryDays(config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG): number {
  return Math.max(...Object.values(config.days).flatMap((byType) => Object.values(byType)), 0);
}

function addDaysIso(date: string, days: number): string {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}

export function recoveryDays(
  race: Pick<Race, 'priority' | 'type'>,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG
): number {
  return config.days[race.priority][race.type];
}

/** First and last day of the recovery block (the day after the race on), or null when it is empty. */
export function recoveryWindow(
  race: Pick<Race, 'date' | 'priority' | 'type'>,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG
): { from: string; to: string } | null {
  const days = recoveryDays(race, config);
  if (days <= 0) return null;
  return { from: addDaysIso(race.date, 1), to: addDaysIso(race.date, days) };
}

const TRI_ROTATION: readonly Sport[] = [Sport.swim, Sport.bike, Sport.run];
const RUN_ROTATION: readonly Sport[] = [Sport.bike, Sport.swim, Sport.run];

const TITLES: Record<string, string> = {
  [Sport.swim]: 'Recovery Swim',
  [Sport.bike]: 'Recovery Spin',
  [Sport.run]: 'Recovery Jog',
};

function recoverySession(date: string, sport: Sport, minutes: number): Session {
  return {
    date,
    sport,
    title: TITLES[sport],
    durationMin: minutes,
    intensity: Intensity.z1,
    notes: 'Post-race recovery: keep it easy, skip it if the legs say no',
    tags: [RECOVERY_TAG, TAPER_TAG],
  };
}

/**
 * The sessions of the recovery block: rest right after the race, then one short Z1 session every
 * other day with the sport rotating. Every other day is rest, so the block never holds Z2+.
 * Pure and date-based; the race session itself is not part of it.
 */
export function recoverySessions(
  race: Pick<Race, 'date' | 'priority' | 'type'>,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG
): Session[] {
  const days = recoveryDays(race, config);
  const rest = Math.min(config.restDays[race.priority], days);
  const rotation = race.type === RaceType.run ? RUN_ROTATION : TRI_ROTATION;
  const sessions: Session[] = [];
  for (let offset = rest + 1, n = 0; offset <= days; offset += 2, n++) {
    sessions.push(
      recoverySession(
        addDaysIso(race.date, offset),
        rotation[n % rotation.length],
        config.sessionMin
      )
    );
  }
  return sessions;
}

/** True for the sessions the recovery block adds. */
export function isRecoverySession(session: Pick<Session, 'tags'>): boolean {
  return session.tags?.includes(RECOVERY_TAG) ?? false;
}
