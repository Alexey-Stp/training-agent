import { Intensity, Session, Sport } from './types';

/** One timed step of a workout. */
export interface WorkoutInterval {
  durationMin: number;
  zone: Intensity;
}

/** Structured workout block, stored as PlannedSession.steps and rendered to ICU workout text. */
export type WorkoutBlock =
  | ({ kind: 'warmup' | 'steady' | 'cooldown' } & WorkoutInterval)
  | { kind: 'repeat'; count: number; work: WorkoutInterval; rest: WorkoutInterval };

/** Warmup + cooldown need at least this many minutes, otherwise the main set shrinks. */
const MIN_WARMUP_COOLDOWN_MIN = 10;
const TEMPO_MAIN_MIN = 20;

type RepeatBlock = Extract<WorkoutBlock, { kind: 'repeat' }>;

function repeat(count: number, workMin: number, zone: Intensity, restMin: number): RepeatBlock {
  return {
    kind: 'repeat',
    count,
    work: { durationMin: workMin, zone },
    rest: { durationMin: restMin, zone: Intensity.z1 },
  };
}

function intervalSetFor(sport: Sport, intensity: Intensity): RepeatBlock {
  if (sport === Sport.run && intensity === Intensity.z4) return repeat(5, 3, intensity, 2);
  if (sport === Sport.bike && intensity === Intensity.z5) return repeat(5, 5, intensity, 3);
  if (sport === Sport.bike && intensity === Intensity.z4) return repeat(3, 12, intensity, 4);
  if (sport === Sport.swim && intensity === Intensity.z4) return repeat(10, 2, intensity, 1);
  return repeat(5, 4, intensity, 2);
}

function repeatMinutes(block: RepeatBlock): number {
  return block.count * (block.work.durationMin + block.rest.durationMin);
}

/** Warmup (Z2) takes the larger half of the time left around the main set, cooldown (Z1) the rest. */
function wrapMainSet(main: WorkoutBlock, mainMin: number, totalMin: number): WorkoutBlock[] {
  const remaining = totalMin - mainMin;
  const warmup = Math.ceil(remaining / 2);
  return [
    { kind: 'warmup', durationMin: warmup, zone: Intensity.z2 },
    main,
    { kind: 'cooldown', durationMin: remaining - warmup, zone: Intensity.z1 },
  ];
}

/**
 * Structured steps for a session. Uses only sport, intensity and duration, so the result
 * follows rule-engine changes (downgrades, swim rotation, load-cap scaling). Z1/Z2 sessions
 * are one steady block, Z3 gets a tempo block and Z4/Z5 an interval set, both wrapped in
 * warmup/cooldown. Block minutes always add up to `durationMin`.
 */
export function buildWorkoutSteps(
  session: Pick<Session, 'sport' | 'intensity' | 'durationMin'>
): WorkoutBlock[] {
  const { sport, intensity, durationMin } = session;
  const steady: WorkoutBlock[] = [{ kind: 'steady', durationMin, zone: intensity }];

  if (intensity === Intensity.z1 || intensity === Intensity.z2) return steady;

  if (intensity === Intensity.z3) {
    if (durationMin - TEMPO_MAIN_MIN < MIN_WARMUP_COOLDOWN_MIN) return steady;
    const main: WorkoutBlock = { kind: 'steady', durationMin: TEMPO_MAIN_MIN, zone: intensity };
    return wrapMainSet(main, TEMPO_MAIN_MIN, durationMin);
  }

  const set = intervalSetFor(sport, intensity);
  // Short sessions (e.g. scaled down by the weekly load cap) drop reps first
  while (set.count > 1 && durationMin - repeatMinutes(set) < MIN_WARMUP_COOLDOWN_MIN) set.count--;
  if (durationMin - repeatMinutes(set) < MIN_WARMUP_COOLDOWN_MIN) return steady;
  return wrapMainSet(set, repeatMinutes(set), durationMin);
}

/** Minutes of a block list. */
export function workoutMinutes(blocks: WorkoutBlock[]): number {
  return blocks.reduce(
    (sum, b) =>
      sum +
      (b.kind === 'repeat' ? b.count * (b.work.durationMin + b.rest.durationMin) : b.durationMin),
    0
  );
}

/** ICU zone target: bike zones are power by default, run uses HR zones, swim uses pace zones. */
const ZONE_SUFFIX: Partial<Record<Sport, string>> = {
  [Sport.run]: ' HR',
  [Sport.swim]: ' Pace',
};

const SECTION_TITLE: Record<Exclude<WorkoutBlock['kind'], 'repeat'>, string> = {
  warmup: 'Warmup',
  steady: 'Main set',
  cooldown: 'Cooldown',
};

/**
 * intervals.icu structured workout text: sections separated by blank lines, a repeat is a
 * "Main set 5x" header followed by its steps, each step is "- <minutes>m Z<n>[ HR| Pace]".
 * ICU parses this into a structured workout that syncs to the watch.
 */
export function renderIcuWorkout(blocks: WorkoutBlock[], sport: Sport): string {
  const suffix = ZONE_SUFFIX[sport] ?? '';
  const step = ({ durationMin, zone }: WorkoutInterval) =>
    `- ${durationMin.toString()}m ${zone.toUpperCase()}${suffix}`;

  return blocks
    .map((b) =>
      b.kind === 'repeat'
        ? [`Main set ${b.count.toString()}x`, step(b.work), step(b.rest)].join('\n')
        : [SECTION_TITLE[b.kind], step(b)].join('\n')
    )
    .join('\n\n');
}
