import { addDays, differenceInCalendarDays, endOfISOWeek, format, parseISO } from 'date-fns';
import {
  downgradeToEasy,
  Intensity,
  isHardSession,
  isRaceSession,
  OPENERS_TAG,
  RACE_TAG,
  Session,
  SHARPENING_TAG,
  Sport,
  TAPER_TAG,
} from '../types';
import { BlockGeneratorConfig } from './generator-config';
import { Race, RacePriority, RaceType, TrainingBlockType } from './types';

const STEP_MIN = 5;
const MIN_SESSION_MIN = 20;
/** Easy cap on the day after a B-race */
const POST_RACE_MAX_MIN = 45;
const RECOVERY_SPIN_MIN = 30;
/** First day of the A-race window, relative to the race */
const A_WINDOW_START = -6;
/**
 * Most days a race reaches from its date: the A-race window starts 6 days before and ends with
 * its ISO week, a B-race mini-taper starts up to 5 days before. Callers load races this far
 * past both ends of a range.
 */
export const RACE_REACH_DAYS = 7;

// Local copy of window.ts addDaysIso: window imports the expander, which imports this file
function addDaysIso(date: string, days: number): string {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}

function isoWeekEnd(date: string): string {
  return format(endOfISOWeek(parseISO(date)), 'yyyy-MM-dd');
}

/** One session of the A-race week, placed `offset` days from the race (negative = before). */
interface RaceDayEntry {
  offset: number;
  sport: Sport;
  title: string;
  intensity: Intensity;
  /** Share of the week's free minutes (after fixed sessions), relative to the other entries */
  weight?: number;
  /** Fixed duration instead of a weighted share */
  fixedMin?: number;
  maxMin?: number;
  tags?: string[];
  notes?: string;
}

const OPENER_NOTES = '3 × 1′ at race pace, 2′ easy between. Short and sharp, then rest.';
const SHARPENING_NOTES = 'Short race-pace efforts with full recovery, stay fresh';

function opener(sport: Sport): RaceDayEntry {
  return {
    offset: -1,
    sport,
    title: 'Race Openers',
    intensity: Intensity.z3,
    tags: [OPENERS_TAG],
    notes: OPENER_NOTES,
  };
}

function easy(
  offset: number,
  sport: Sport,
  title: string,
  weight: number,
  maxMin: number
): RaceDayEntry {
  return { offset, sport, title, intensity: Intensity.z2, weight, maxMin };
}

function sharpening(offset: number, sport: Sport, maxMin: number): RaceDayEntry {
  const title = sport === Sport.bike ? 'Bike Sharpening' : 'Run Sharpening';
  return {
    offset,
    sport,
    title,
    intensity: Intensity.z4,
    weight: 3,
    maxMin,
    tags: [SHARPENING_TAG],
    notes: SHARPENING_NOTES,
  };
}

function shakeout(sport: Sport): RaceDayEntry {
  const title = sport === Sport.bike ? 'Easy Spin' : 'Easy Jog';
  return {
    offset: -3,
    sport,
    title,
    intensity: Intensity.z1,
    fixedMin: 20,
    notes: 'Just loosen up',
  };
}

/** Sprint/olympic: sharpening on the bike at T-5, 20′ spin at T-3 */
const SHORT_TRI_WEEK: RaceDayEntry[] = [
  easy(-6, Sport.swim, 'Swim Easy', 2, 45),
  easy(-6, Sport.run, 'Run Easy', 2, 45),
  sharpening(-5, Sport.bike, 60),
  easy(-4, Sport.swim, 'Swim Easy', 2, 40),
  easy(-4, Sport.run, 'Run Easy', 2, 40),
  shakeout(Sport.bike),
  easy(-2, Sport.swim, 'Swim Easy + Pickups', 2, 30),
  easy(-2, Sport.run, 'Run Easy', 2, 30),
  opener(Sport.bike),
];

/** Half/full: one moderate ride, sharpening on the run at T-5, full rest at T-3 */
const LONG_TRI_WEEK: RaceDayEntry[] = [
  easy(-6, Sport.bike, 'Bike Endurance', 4, 120),
  easy(-6, Sport.swim, 'Swim Easy', 2, 45),
  sharpening(-5, Sport.run, 50),
  easy(-4, Sport.bike, 'Bike Easy', 3, 75),
  easy(-4, Sport.swim, 'Swim Easy', 2, 40),
  easy(-2, Sport.swim, 'Swim Easy + Pickups', 2, 30),
  easy(-2, Sport.run, 'Run Easy', 2, 25),
  opener(Sport.bike),
];

const RUN_WEEK: RaceDayEntry[] = [
  easy(-6, Sport.run, 'Run Easy', 3, 60),
  sharpening(-5, Sport.run, 50),
  easy(-4, Sport.run, 'Run Easy', 2, 45),
  shakeout(Sport.run),
  easy(-2, Sport.run, 'Run Easy + Strides', 2, 30),
  opener(Sport.run),
];

export const RACE_WEEK_TEMPLATES: Record<RaceType, readonly RaceDayEntry[]> = {
  [RaceType.sprint]: SHORT_TRI_WEEK,
  [RaceType.olympic]: SHORT_TRI_WEEK,
  [RaceType.half]: LONG_TRI_WEEK,
  [RaceType.full]: LONG_TRI_WEEK,
  [RaceType.run]: RUN_WEEK,
  [RaceType.other]: SHORT_TRI_WEEK,
};

/** Optional easy sessions after the race, on these offsets within the race's ISO week */
const RECOVERY_OFFSETS: ReadonlySet<number> = new Set([2, 4, 6]);

/** The race itself: one session, excluded from week volume and never changed by the rules. */
export function raceSession(race: Race, config: BlockGeneratorConfig): Session {
  return {
    date: race.date,
    sport: race.type === RaceType.run ? Sport.run : Sport.other,
    title: `🏁 ${race.name}`,
    durationMin: config.raceDurationMin[race.type],
    intensity: Intensity.z4,
    tags: [RACE_TAG],
    notes: `${race.priority}-race · ${race.type}`,
  };
}

function offsetOf(race: Race, date: string): number {
  return differenceInCalendarDays(parseISO(date), parseISO(race.date));
}

function steps(minutes: number): number {
  return Math.round(minutes / STEP_MIN) * STEP_MIN;
}

/** The travel day's sessions are dropped; travelling on T-1 moves the opener to T-2. */
function withTravel(entries: readonly RaceDayEntry[], race: Race): readonly RaceDayEntry[] {
  const travel = race.travelDate ? offsetOf(race, race.travelDate) : null;
  if (travel === null || travel < -3 || travel > -1) return entries;
  return entries
    .map((e) => (travel === -1 && e.tags?.includes(OPENERS_TAG) ? { ...e, offset: -2 } : e))
    .filter((e) => e.offset !== travel);
}

/** Splits `minutes` by weight; an entry that would pass its cap is held there and the rest spills over. */
function fillUnderCaps(weights: number[], caps: number[], minutes: number): number[] {
  const shares = weights.map(() => 0);
  let open = weights.map((_, i) => i);
  let remaining = minutes;
  while (open.length > 0 && remaining > 0) {
    const openWeight = open.reduce((sum, i) => sum + weights[i], 0);
    const share = (i: number) => (remaining * weights[i]) / openWeight;
    const over = open.filter((i) => share(i) > caps[i]);
    if (over.length === 0) {
      open.forEach((i) => (shares[i] = share(i)));
      break;
    }
    over.forEach((i) => (shares[i] = caps[i]));
    remaining -= over.reduce((sum, i) => sum + caps[i], 0);
    open = open.filter((i) => !over.includes(i));
  }
  return shares;
}

/** Shares of the weighted entries; entries whose share would be under the floor are dropped (lightest, then latest, first) and their minutes go to the rest. */
function weightedShares(entries: readonly RaceDayEntry[], minutes: number): number[] {
  const kept = entries.map((e) => (e.weight ?? 0) > 0);
  const caps = entries.map((e) => e.maxMin ?? Number.POSITIVE_INFINITY);
  for (;;) {
    const weights = entries.map((e, i) => (kept[i] ? (e.weight ?? 0) : 0));
    const shares = fillUnderCaps(weights, caps, minutes);
    const short = shares
      .map((share, i) => ({ i, share }))
      .filter(({ i, share }) => kept[i] && share < MIN_SESSION_MIN);
    if (short.length === 0) return shares;
    const drop = short.reduce(
      (a, b) => ((entries[b.i].weight ?? 0) <= (entries[a.i].weight ?? 0) ? b : a),
      short[0]
    );
    kept[drop.i] = false;
  }
}

/** Minutes per entry: fixed ones as set, the rest split by weight under their caps (5-min steps). */
function sizeEntries(
  entries: readonly RaceDayEntry[],
  weekMinutes: number,
  config: BlockGeneratorConfig
): number[] {
  const fixedOf = (e: RaceDayEntry) =>
    e.tags?.includes(OPENERS_TAG) ? config.openerMaxMin : e.fixedMin;
  const fixed = entries.reduce((sum, e) => sum + (fixedOf(e) ?? 0), 0);
  const shares = weightedShares(entries, Math.max(0, weekMinutes - fixed));
  return entries.map((e, i) => fixedOf(e) ?? steps(shares[i]));
}

function entrySession(race: Race, entry: RaceDayEntry, durationMin: number): Session {
  return {
    date: addDaysIso(race.date, entry.offset),
    sport: entry.sport,
    title: entry.title,
    durationMin,
    intensity: entry.intensity,
    notes: entry.notes,
    tags: [...(entry.tags ?? []), TAPER_TAG],
  };
}

function recoverySession(race: Race, date: string): Session {
  const sport = race.type === RaceType.run ? Sport.run : Sport.bike;
  return {
    date,
    sport,
    title: sport === Sport.bike ? 'Recovery Spin (optional)' : 'Recovery Jog (optional)',
    durationMin: sport === Sport.bike ? RECOVERY_SPIN_MIN : MIN_SESSION_MIN,
    intensity: Intensity.z1,
    notes: 'Only if the legs ask for it',
    tags: ['optional', TAPER_TAG],
  };
}

/**
 * Every session of the A-race window: T-6..T-1 from the race type's template (sized to
 * `weekHours`, the race week's training volume), the race at T, and optional recovery after it
 * until the end of the race's ISO week. Pure and date-based, so a week that only holds part of
 * the window (a taper week before a Monday race) gets the same sessions.
 */
export function aRaceWindow(
  race: Race,
  weekHours: number,
  config: BlockGeneratorConfig
): { from: string; to: string; sessions: Session[] } {
  const entries = withTravel(RACE_WEEK_TEMPLATES[race.type], race);
  const minutes = sizeEntries(entries, Math.round(weekHours * 60), config);
  const training = entries
    .map((e, i) => entrySession(race, e, minutes[i]))
    .filter((s) => s.durationMin > 0);
  const to = isoWeekEnd(race.date);
  const recovery: Session[] = [];
  for (let date = addDaysIso(race.date, 1); date <= to; date = addDaysIso(date, 1)) {
    if (RECOVERY_OFFSETS.has(offsetOf(race, date))) recovery.push(recoverySession(race, date));
  }
  return {
    from: addDaysIso(race.date, A_WINDOW_START),
    to,
    sessions: [...training, raceSession(race, config), ...recovery],
  };
}

function scaled(session: Session, factor: number): Session {
  const minutes = Math.max(MIN_SESSION_MIN, steps(session.durationMin * factor));
  return { ...session, durationMin: Math.min(session.durationMin, minutes) };
}

function withTag(session: Session, tag: string): Session {
  const tags = session.tags ?? [];
  return tags.includes(tag) ? session : { ...session, tags: [...tags, tag] };
}

/** One existing session inside a B-race mini-taper, by its day relative to the race. */
function miniTaperSession(
  session: Session,
  offset: number,
  config: BlockGeneratorConfig
): Session | null {
  if (offset === -3 || offset === -1 || offset === 0) return null; // replaced, see miniTaperExtras
  if (offset === 1) {
    const easyDay = isHardSession(session)
      ? downgradeToEasy(session, 'Day after a B-race')
      : session;
    return withTag(
      { ...easyDay, durationMin: Math.min(easyDay.durationMin, POST_RACE_MAX_MIN) },
      TAPER_TAG
    );
  }
  const shorter = scaled(session, config.miniTaperFactor);
  if (!isHardSession(shorter)) return withTag(shorter, TAPER_TAG);
  // Hard sessions stay until T-4 as shortened sharpening; closer to the race they go easy
  const kept =
    offset <= -4 ? withTag(shorter, SHARPENING_TAG) : downgradeToEasy(shorter, 'B-race mini-taper');
  return withTag(kept, TAPER_TAG);
}

/** Sessions a B-race mini-taper adds: T-3 shakeout (short races), T-1 opener, the race. */
function miniTaperExtras(race: Race, config: BlockGeneratorConfig): Session[] {
  const template = RACE_WEEK_TEMPLATES[race.type];
  const extras = withTravel(
    template.filter((e) => e.offset === -3 || e.tags?.includes(OPENERS_TAG)),
    race
  );
  const minutes = sizeEntries(extras, 0, config);
  return [...extras.map((e, i) => entrySession(race, e, minutes[i])), raceSession(race, config)];
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function applyARace(
  sessions: Session[],
  race: Race,
  weekHours: number,
  config: BlockGeneratorConfig
): Session[] {
  const window = aRaceWindow(race, weekHours, config);
  const kept = sessions.filter((s) => !inRange(s.date, window.from, window.to));
  return [...kept, ...window.sessions];
}

function applyBRace(sessions: Session[], race: Race, config: BlockGeneratorConfig): Session[] {
  const from = addDaysIso(race.date, -config.miniTaperDays[race.type]);
  const to = addDaysIso(race.date, 1);
  const changed = sessions.flatMap((s) => {
    if (!inRange(s.date, from, to)) return [s];
    const next = miniTaperSession(s, offsetOf(race, s.date), config);
    return next ? [next] : [];
  });
  return [...changed, ...miniTaperExtras(race, config)];
}

function isKeyTraining(session: Session): boolean {
  return (
    !isRaceSession(session) && (isHardSession(session) || (session.tags?.includes('long') ?? false))
  );
}

/**
 * C-race: train through. The race replaces the day's sessions; when none of them was a key
 * session, the key session nearest the race (earlier first on a tie) is dropped instead.
 */
function applyCRace(sessions: Session[], race: Race, config: BlockGeneratorConfig): Session[] {
  const raceDay = sessions.filter((s) => s.date === race.date);
  let rest = sessions.filter((s) => s.date !== race.date);
  if (!raceDay.some(isKeyTraining)) {
    const distance = (s: Session) => Math.abs(offsetOf(race, s.date));
    const nearest = rest
      .filter(isKeyTraining)
      .sort((a, b) => distance(a) - distance(b) || a.date.localeCompare(b.date))
      .at(0);
    rest = rest.filter((s) => s !== nearest);
  }
  return [...rest, raceSession(race, config)];
}

export interface RaceOverrideInput {
  /** First and last day of the expanded week */
  weekStart: string;
  weekEnd: string;
  blockType: TrainingBlockType;
  races: readonly Race[];
  /** Training hours of the A-race week; without it the A-race is treated like a C-race */
  aRaceWeekHours: number | null;
  config: BlockGeneratorConfig;
}

const TAPER_BLOCKS: ReadonlySet<TrainingBlockType> = new Set([
  TrainingBlockType.taper,
  TrainingBlockType.race,
]);

type RaceTreatment = 'a' | 'b' | 'c';

function treatmentOf(race: Race, input: RaceOverrideInput): RaceTreatment {
  if (race.priority === RacePriority.A && input.aRaceWeekHours !== null) return 'a';
  // A B-race inside the A taper doesn't get a second taper; it is swapped in like a C-race
  if (race.priority === RacePriority.B && !TAPER_BLOCKS.has(input.blockType)) return 'b';
  return 'c';
}

/** Days a race can change, relative to the race date. */
function reachOf(race: Race, treatment: RaceTreatment, config: BlockGeneratorConfig) {
  if (treatment === 'a') {
    return { from: addDaysIso(race.date, A_WINDOW_START), to: isoWeekEnd(race.date) };
  }
  if (treatment === 'b') {
    return {
      from: addDaysIso(race.date, -config.miniTaperDays[race.type]),
      to: addDaysIso(race.date, 1),
    };
  }
  return { from: race.date, to: race.date };
}

/**
 * The week's sessions with the races applied, before the rules engine runs: an A-race gets its
 * race-week template (T-6 to the end of its ISO week), a B-race a mini-taper, a C-race a swap.
 * Only sessions dated inside the week are returned. Races apply A first, then B, then C.
 */
export function applyRaceOverrides(sessions: Session[], input: RaceOverrideInput): Session[] {
  const order: Record<RaceTreatment, number> = { a: 0, b: 1, c: 2 };
  const planned = input.races
    .map((race) => ({ race, treatment: treatmentOf(race, input) }))
    .filter(({ race, treatment }) => {
      const reach = reachOf(race, treatment, input.config);
      return reach.from <= input.weekEnd && reach.to >= input.weekStart;
    })
    .sort(
      (a, b) => order[a.treatment] - order[b.treatment] || a.race.date.localeCompare(b.race.date)
    );

  let result = sessions;
  for (const { race, treatment } of planned) {
    if (treatment === 'a') {
      result = applyARace(result, race, input.aRaceWeekHours ?? 0, input.config);
    } else if (treatment === 'b') {
      result = applyBRace(result, race, input.config);
    } else if (inRange(race.date, input.weekStart, input.weekEnd)) {
      result = applyCRace(result, race, input.config);
    }
  }
  return result
    .filter((s) => inRange(s.date, input.weekStart, input.weekEnd))
    .sort((a, b) => a.date.localeCompare(b.date));
}
