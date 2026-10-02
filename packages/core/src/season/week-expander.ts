import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import { DAY_NAMES, dayNameOf } from '../plan-generator';
import { PlannedSessionDraft, toPlannedSessions } from '../planned-session';
import { applyRules, checkHardRules, RuleViolation } from '../rules-engine';
import { Intensity, RulesContext, Session, Sport, UserProfile, WeekPlan } from '../types';
import { BlockGeneratorConfig, DEFAULT_BLOCK_GENERATOR_CONFIG } from './generator-config';
import { TrainingBlock, TrainingBlockType } from './types';

/** Weekly volume in hours, total and per sport (the shape of `SeasonWeek`). */
export interface WeekTargets {
  hours: number;
  swimH: number;
  bikeH: number;
  runH: number;
}

export interface ExpandWeekOptions {
  /** Rules-engine input. Default: no history and no wellness, so only NoHardHard can fire. */
  context?: RulesContext;
  /** This week's targets, e.g. a generated `SeasonWeek`. Default: the block's weekly averages. */
  targets?: WeekTargets;
  /** Swim/run pace used to turn metres and km into hours */
  config?: BlockGeneratorConfig;
}

export interface ExpandedWeek {
  weekStart: string; // YYYY-MM-DD
  blockType: TrainingBlockType;
  /** Targets the week was sized to; the sport hours sum to `hours` */
  targets: WeekTargets;
  /** Rules-applied plan; `warnings` also carries the expander's own notes */
  plan: WeekPlan;
  sessions: PlannedSessionDraft[];
  /** Hard rules the corrected plan still breaks; empty unless a rule can't fully correct it */
  violations: RuleViolation[];
}

/** Sessions are sized in 5-minute steps */
const STEP_MIN = 5;
/** Shorter sessions are dropped and their minutes go to the sport's other sessions */
const MIN_SESSION_MIN = 20;
/** Longest session in a taper or race week */
const TAPER_MAX_SESSION_MIN = 75;

type TrainingSport = Sport.swim | Sport.bike | Sport.run;
const TRAINING_SPORTS: TrainingSport[] = [Sport.swim, Sport.bike, Sport.run];

/** Where a template session goes in the week; resolved against the profile by `resolveDays`. */
type DayRole =
  | 'swim1'
  | 'swim2'
  | 'swimOptional'
  | 'easyBike'
  | 'keyBike'
  | 'longBike'
  | 'keyRun'
  | 'easyRun'
  | 'longRun';

interface SessionTemplate {
  role: DayRole;
  sport: TrainingSport;
  title: string;
  intensity: Intensity;
  /** Share of the sport's weekly minutes, relative to the sport's other sessions */
  weight: number;
  tags?: string[];
  notes?: string;
}

interface WeekTemplate {
  sessions: SessionTemplate[];
  /** Longest allowed session, if the block type caps it */
  maxSessionMin?: number;
}

// Swim roles match SwimRotation (Wed technique, Fri tagged `intervals`), so the rule leaves them alone
const SWIM_TECHNIQUE: SessionTemplate = {
  role: 'swim1',
  sport: Sport.swim,
  title: 'Swim Technique',
  intensity: Intensity.z2,
  weight: 0.4,
  tags: ['technique'],
  notes: 'Drills and technique work',
};
const SWIM_OPTIONAL: SessionTemplate = {
  role: 'swimOptional',
  sport: Sport.swim,
  title: 'Optional Easy Swim',
  intensity: Intensity.z1,
  weight: 0.2,
  tags: ['optional'],
  notes: 'Recovery swim',
};
const EASY_BIKE: SessionTemplate = {
  role: 'easyBike',
  sport: Sport.bike,
  title: 'Bike Endurance',
  intensity: Intensity.z2,
  weight: 0.25,
  notes: 'Easy spin, focus on cadence',
};
const LONG_BIKE: SessionTemplate = {
  role: 'longBike',
  sport: Sport.bike,
  title: 'Long Bike',
  intensity: Intensity.z2,
  weight: 0.5,
  tags: ['long'],
  notes: 'Steady endurance ride, nutrition practice',
};
const EASY_RUN: SessionTemplate = {
  role: 'easyRun',
  sport: Sport.run,
  title: 'Run Easy',
  intensity: Intensity.z2,
  weight: 0.25,
  notes: 'Conversational pace',
};
const LONG_RUN: SessionTemplate = {
  role: 'longRun',
  sport: Sport.run,
  title: 'Long Run',
  intensity: Intensity.z2,
  weight: 0.45,
  tags: ['long'],
  notes: 'Steady aerobic run',
};

/** Endurance and technique, no hard sessions */
const BASE_WEEK: WeekTemplate = {
  sessions: [
    SWIM_TECHNIQUE,
    {
      role: 'swim2',
      sport: Sport.swim,
      title: 'Swim Aerobic Intervals',
      intensity: Intensity.z3,
      weight: 0.4,
      tags: ['intervals'],
      notes: 'Steady 200s with short rest',
    },
    SWIM_OPTIONAL,
    EASY_BIKE,
    {
      role: 'keyBike',
      sport: Sport.bike,
      title: 'Bike Tempo',
      intensity: Intensity.z3,
      weight: 0.25,
      notes: 'Sweet-spot / tempo blocks',
    },
    LONG_BIKE,
    {
      role: 'keyRun',
      sport: Sport.run,
      title: 'Run Aerobic + Strides',
      intensity: Intensity.z2,
      weight: 0.3,
      notes: 'Easy run, finish with 6x20s strides',
    },
    EASY_RUN,
    LONG_RUN,
  ],
};

/** VO2 and threshold key sessions on top of the long sessions */
const BUILD_WEEK: WeekTemplate = {
  sessions: [
    SWIM_TECHNIQUE,
    {
      role: 'swim2',
      sport: Sport.swim,
      title: 'Swim Threshold Intervals',
      intensity: Intensity.z4,
      weight: 0.4,
      tags: ['intervals'],
      notes: '100s at threshold pace',
    },
    SWIM_OPTIONAL,
    EASY_BIKE,
    {
      role: 'keyBike',
      sport: Sport.bike,
      title: 'Bike VO2 Max',
      intensity: Intensity.z5,
      weight: 0.25,
      tags: ['vo2'],
      notes: 'VO2 max intervals, easy spin between',
    },
    LONG_BIKE,
    {
      role: 'keyRun',
      sport: Sport.run,
      title: 'Run Threshold',
      intensity: Intensity.z4,
      weight: 0.3,
      tags: ['threshold'],
      notes: 'Threshold intervals, easy jog between',
    },
    EASY_RUN,
    LONG_RUN,
  ],
};

/** Short sessions with two openers; everything else easy */
const TAPER_WEEK: WeekTemplate = {
  maxSessionMin: TAPER_MAX_SESSION_MIN,
  sessions: [
    SWIM_TECHNIQUE,
    {
      role: 'swim2',
      sport: Sport.swim,
      title: 'Swim Openers',
      intensity: Intensity.z3,
      weight: 0.4,
      tags: ['intervals'],
      notes: 'A few short race-pace efforts, long rest',
    },
    SWIM_OPTIONAL,
    { ...EASY_BIKE, weight: 0.35 },
    {
      role: 'keyBike',
      sport: Sport.bike,
      title: 'Bike Openers',
      intensity: Intensity.z4,
      weight: 0.3,
      tags: ['openers'],
      notes: 'Short race-pace efforts, stay fresh',
    },
    { ...LONG_BIKE, title: 'Bike Endurance', weight: 0.35, tags: undefined },
    {
      role: 'keyRun',
      sport: Sport.run,
      title: 'Run Openers',
      intensity: Intensity.z4,
      weight: 0.35,
      tags: ['openers'],
      notes: 'Short race-pace efforts, stay fresh',
    },
    { ...EASY_RUN, weight: 0.3 },
    { ...LONG_RUN, title: 'Run Endurance', weight: 0.35, tags: undefined },
  ],
};

/** Base layout with every session easy */
const RECOVERY_WEEK: WeekTemplate = {
  sessions: [
    SWIM_TECHNIQUE,
    {
      role: 'swim2',
      sport: Sport.swim,
      title: 'Swim Easy Intervals',
      intensity: Intensity.z2,
      weight: 0.4,
      tags: ['intervals'],
      notes: 'Relaxed 100s, focus on form',
    },
    SWIM_OPTIONAL,
    EASY_BIKE,
    { ...EASY_BIKE, role: 'keyBike' },
    { ...LONG_BIKE, title: 'Bike Endurance' },
    { ...EASY_RUN, role: 'keyRun' },
    EASY_RUN,
    { ...LONG_RUN, title: 'Run Endurance' },
  ],
};

const TEMPLATE_BY_BLOCK: Record<TrainingBlockType, WeekTemplate> = {
  [TrainingBlockType.base]: BASE_WEEK,
  [TrainingBlockType.build]: BUILD_WEEK,
  [TrainingBlockType.peak]: BUILD_WEEK,
  [TrainingBlockType.taper]: TAPER_WEEK,
  [TrainingBlockType.race]: TAPER_WEEK,
  [TrainingBlockType.recovery]: RECOVERY_WEEK,
  [TrainingBlockType.transition]: RECOVERY_WEEK,
};

// Day preferences, best first. Roles placed earlier are excluded for the ones after them.
const LONG_RUN_DAYS = ['Sat', 'Sun', 'Tue', 'Wed', 'Fri', 'Mon', 'Thu'];
const KEY_RUN_DAYS = ['Tue', 'Wed', 'Mon', 'Fri', 'Sat', 'Thu', 'Sun'];
const EASY_BIKE_DAYS = ['Mon', 'Tue', 'Wed', 'Fri', 'Sat', 'Thu', 'Sun'];
const EASY_RUN_DAYS = ['Wed', 'Fri', 'Mon', 'Thu', 'Tue', 'Sat', 'Sun'];
const WEEK_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type RoleDays = Record<DayRole, string | null>;

/** First candidate not in `exclude`, or the first candidate when every one is taken. */
function pickDay(candidates: string[], exclude: (string | null)[]): string {
  return candidates.find((d) => !exclude.includes(d)) ?? candidates[0];
}

function isAdjacentDay(a: string, b: string): boolean {
  const diff = Math.abs(DAY_NAMES.indexOf(a) - DAY_NAMES.indexOf(b));
  return diff === 1 || diff === 6;
}

/**
 * The first two regular swim days, with a Wed day as technique and a Fri day as intervals
 * when the profile has them (SwimRotation enforces that pairing).
 */
function swimRoles(swimDays: string[]): Pick<RoleDays, 'swim1' | 'swim2'> {
  const [a, b] = WEEK_ORDER.filter((d) => swimDays.includes(d));
  if (a === 'Fri' || b === 'Wed') return { swim1: b ?? null, swim2: a };
  return { swim1: a ?? null, swim2: b ?? null };
}

/** Weekday of every template role for this athlete. */
function resolveDays(profile: UserProfile): RoleDays {
  const optional = profile.swimDays.find((d) => d.endsWith('_optional'));
  const longBike = profile.longBikeDay;
  const keyBike = profile.bikeVo2Day;
  const longRun = pickDay(LONG_RUN_DAYS, [longBike, profile.noLongRunDay]);
  // The key run stays off the days next to the key bike, so the two never go back to back
  const keyRunDays = KEY_RUN_DAYS.filter((d) => !isAdjacentDay(d, keyBike));
  const keyRun = pickDay(keyRunDays.length > 0 ? keyRunDays : KEY_RUN_DAYS, [
    keyBike,
    longBike,
    longRun,
  ]);
  const easyBike = pickDay(EASY_BIKE_DAYS, [keyBike, longBike, keyRun, longRun]);
  const easyRun = pickDay(EASY_RUN_DAYS, [keyBike, longBike, keyRun, longRun, easyBike]);
  return {
    ...swimRoles(profile.swimDays),
    swimOptional: optional ? optional.replace('_optional', '') : null,
    easyBike,
    keyBike,
    longBike,
    keyRun,
    easyRun,
    longRun,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Sport hours scaled to add up to `hours`, so the total is exact and the split is kept. */
function normalizeTargets(targets: WeekTargets): WeekTargets {
  const sportHours = targets.swimH + targets.bikeH + targets.runH;
  if (sportHours <= 0 || targets.hours <= 0) return { hours: 0, swimH: 0, bikeH: 0, runH: 0 };
  const scale = targets.hours / sportHours;
  return {
    hours: targets.hours,
    swimH: round2(targets.swimH * scale),
    bikeH: round2(targets.bikeH * scale),
    runH: round2(targets.runH * scale),
  };
}

/** The block's weekly averages in hours, with swim metres and run km converted at config pace. */
export function blockWeekTargets(
  block: TrainingBlock,
  config: BlockGeneratorConfig = DEFAULT_BLOCK_GENERATOR_CONFIG
): WeekTargets {
  return normalizeTargets({
    hours: block.targetWeeklyHours,
    swimH: block.targetSwimM / config.swimMPerHour,
    bikeH: block.targetBikeH,
    runH: block.targetRunKm / config.runKmPerHour,
  });
}

/** First day of the block's `weekIndex`th week (0-based). */
export function blockWeekStart(block: TrainingBlock, weekIndex: number): string {
  if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex >= block.weeks) {
    throw new RangeError(
      `weekIndex ${weekIndex.toString()} is outside block ${block.order.toString()} (${block.weeks.toString()} weeks)`
    );
  }
  return format(addDays(parseISO(block.startDate), weekIndex * 7), 'yyyy-MM-dd');
}

/** 0-based week of the block that contains `date`, or null if the date is outside the block. */
export function weekIndexForDate(block: TrainingBlock, date: string): number | null {
  const days = differenceInCalendarDays(parseISO(date), parseISO(block.startDate));
  if (days < 0 || days >= block.weeks * 7) return null;
  return Math.floor(days / 7);
}

/** Planned hours, total and per sport. */
export function weekVolume(sessions: Session[]): WeekTargets {
  const hoursOf = (sport?: Sport) =>
    round2(sum(sessions.filter((s) => !sport || s.sport === sport).map((s) => s.durationMin)) / 60);
  return {
    hours: hoursOf(),
    swimH: hoursOf(Sport.swim),
    bikeH: hoursOf(Sport.bike),
    runH: hoursOf(Sport.run),
  };
}

interface Placed {
  template: SessionTemplate;
  date: string;
}

/** Template sessions with their date in the week; roles the profile leaves without a day are skipped. */
function placeTemplates(template: WeekTemplate, profile: UserProfile, weekStart: string): Placed[] {
  const dateByDay = new Map<string, string>();
  for (let i = 0; i < 7; i++) {
    const date = format(addDays(parseISO(weekStart), i), 'yyyy-MM-dd');
    dateByDay.set(dayNameOf(date), date);
  }
  const days = resolveDays(profile);
  return template.sessions.flatMap((t) => {
    const day = days[t.role];
    const date = day ? dateByDay.get(day) : undefined;
    return date ? [{ template: t, date }] : [];
  });
}

/** Drops sessions whose share would be under the floor, optional ones first. */
function keepLongEnough(placed: Placed[], minutes: number): Placed[] {
  let kept = [...placed];
  while (kept.length > 1) {
    const totalWeight = sum(kept.map((p) => p.template.weight));
    const short = kept.filter((p) => (minutes * p.template.weight) / totalWeight < MIN_SESSION_MIN);
    if (short.length === 0) break;
    const drop =
      short.find((p) => p.template.tags?.includes('optional')) ??
      short.reduce((a, b) => (b.template.weight < a.template.weight ? b : a));
    kept = kept.filter((p) => p !== drop);
  }
  return kept;
}

/** Splits `minutes` by weight; a session that would pass `cap` is held at it and the rest spills over. */
function waterFill(
  weights: number[],
  minutes: number,
  cap: number
): { raw: number[]; leftover: number } {
  const raw = weights.map(() => 0);
  let open = weights.map((_, i) => i);
  let remaining = minutes;
  while (open.length > 0 && remaining > 0) {
    const openWeight = sum(open.map((i) => weights[i]));
    const share = (i: number) => (remaining * weights[i]) / openWeight;
    const over = open.filter((i) => share(i) > cap);
    if (over.length === 0) {
      open.forEach((i) => (raw[i] = share(i)));
      return { raw, leftover: 0 };
    }
    over.forEach((i) => (raw[i] = cap));
    remaining -= over.length * cap;
    open = open.filter((i) => !over.includes(i));
  }
  return { raw, leftover: Math.max(0, remaining) };
}

/** Rounds to 5-minute steps keeping the total (largest remainder), without passing `cap`. */
function toSteps(raw: number[], cap: number): number[] {
  const units = raw.map((r) => Math.floor(r / STEP_MIN));
  let missing = Math.round(sum(raw) / STEP_MIN) - sum(units);
  const byRemainder = raw
    .map((r, i) => ({ i, rest: r / STEP_MIN - units[i] }))
    .sort((a, b) => b.rest - a.rest);
  for (const { i } of byRemainder) {
    if (missing <= 0) break;
    if ((units[i] + 1) * STEP_MIN <= cap) {
      units[i] += 1;
      missing -= 1;
    }
  }
  return units.map((u) => u * STEP_MIN);
}

function toSession({ template, date }: Placed, durationMin: number): Session {
  return {
    date,
    sport: template.sport,
    title: template.title,
    durationMin,
    intensity: template.intensity,
    notes: template.notes,
    tags: template.tags ? [...template.tags] : undefined,
  };
}

/** One sport's sessions, sized to its weekly minutes. */
function sizeSport(
  placed: Placed[],
  minutes: number,
  cap: number
): { sessions: Session[]; leftover: number } {
  if (minutes <= 0) return { sessions: [], leftover: 0 };
  if (placed.length === 0) return { sessions: [], leftover: minutes };
  const kept = keepLongEnough(placed, minutes);
  const { raw, leftover } = waterFill(
    kept.map((p) => p.template.weight),
    minutes,
    cap
  );
  const durations = toSteps(raw, cap);
  const sessions = kept.map((p, i) => toSession(p, durations[i])).filter((s) => s.durationMin > 0);
  return { sessions, leftover };
}

function leftoverWarning(sport: TrainingSport, leftover: number, hasDays: boolean): string {
  const minutes = Math.round(leftover).toString();
  return hasDays
    ? `⚠️ ${minutes}min of ${sport} doesn't fit under the ${TAPER_MAX_SESSION_MIN.toString()}min taper session cap`
    : `⚠️ No ${sport} days in your profile, so ${minutes}min of ${sport} is not planned`;
}

function resolveTargets(block: TrainingBlock, options: ExpandWeekOptions): WeekTargets {
  return options.targets
    ? normalizeTargets(options.targets)
    : blockWeekTargets(block, options.config ?? DEFAULT_BLOCK_GENERATOR_CONFIG);
}

const SPORT_TARGET: Record<TrainingSport, keyof WeekTargets> = {
  [Sport.swim]: 'swimH',
  [Sport.bike]: 'bikeH',
  [Sport.run]: 'runH',
};

/**
 * Sessions for the block week before the rules engine runs: the block type's template,
 * placed by the profile and sized to the week's targets. `warnings` lists volume that
 * couldn't be placed; `appliedRules` is empty.
 */
export function draftBlockWeek(
  block: TrainingBlock,
  weekIndex: number,
  profile: UserProfile,
  options: ExpandWeekOptions = {}
): { plan: WeekPlan; targets: WeekTargets } {
  const weekStart = blockWeekStart(block, weekIndex);
  const targets = resolveTargets(block, options);
  const template = TEMPLATE_BY_BLOCK[block.type];
  const cap = template.maxSessionMin ?? Number.POSITIVE_INFINITY;
  const placed = placeTemplates(template, profile, weekStart);

  const sessions: Session[] = [];
  const warnings: string[] = [];
  for (const sport of TRAINING_SPORTS) {
    const own = placed.filter((p) => p.template.sport === sport);
    const sized = sizeSport(own, targets[SPORT_TARGET[sport]] * 60, cap);
    sessions.push(...sized.sessions);
    if (sized.leftover >= STEP_MIN)
      warnings.push(leftoverWarning(sport, sized.leftover, own.length > 0));
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));

  return { plan: { startDate: weekStart, sessions, warnings, appliedRules: [] }, targets };
}

/**
 * Concrete sessions for week `weekIndex` (0-based) of a training block. The draft hits the
 * week's targets and follows the athlete's day preferences; the rules engine then corrects
 * it and `violations` lists any hard rule it still breaks.
 */
export function expandWeek(
  block: TrainingBlock,
  weekIndex: number,
  profile: UserProfile,
  options: ExpandWeekOptions = {}
): ExpandedWeek {
  const context = options.context ?? { last7dStats: { totalMinutes: 0, byDate: [] } };
  const { plan: draft, targets } = draftBlockWeek(block, weekIndex, profile, options);
  const ruled = applyRules(draft, context);
  // applyRules starts its own warnings list, so the expander's go first
  const plan: WeekPlan = { ...ruled, warnings: [...draft.warnings, ...ruled.warnings] };

  return {
    weekStart: draft.startDate,
    blockType: block.type,
    targets,
    plan,
    sessions: toPlannedSessions(plan),
    violations: checkHardRules(plan, context),
  };
}
