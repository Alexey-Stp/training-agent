import { Intensity, type WorkoutBlock, type WorkoutInterval } from '@triathlon/core';

const ZONES: ReadonlySet<string> = new Set(Object.values(Intensity));
const SIMPLE_KINDS: ReadonlySet<string> = new Set(['warmup', 'steady', 'cooldown']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInterval(value: unknown): value is WorkoutInterval {
  return (
    isRecord(value) &&
    typeof value.durationMin === 'number' &&
    value.durationMin > 0 &&
    typeof value.zone === 'string' &&
    ZONES.has(value.zone)
  );
}

function isBlock(value: unknown): value is WorkoutBlock {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (SIMPLE_KINDS.has(value.kind)) return isInterval(value);
  return (
    value.kind === 'repeat' &&
    typeof value.count === 'number' &&
    value.count > 0 &&
    isInterval(value.work) &&
    isInterval(value.rest)
  );
}

/** `PlannedSession.steps` JSON as WorkoutBlock[], or null when it is not one (never throws). */
export function parseSteps(json: unknown): WorkoutBlock[] | null {
  return Array.isArray(json) && json.every(isBlock) ? json : null;
}

const LABEL: Record<Exclude<WorkoutBlock['kind'], 'repeat'>, string> = {
  warmup: 'Warmup',
  steady: 'Main set',
  cooldown: 'Cooldown',
};

/** `15′ Z2` */
export function formatInterval(interval: WorkoutInterval): string {
  return String(interval.durationMin) + '′ ' + interval.zone.toUpperCase();
}

/** One legible line per block, e.g. "Main set 5 × 3′ Z4 / 2′ Z1 easy". */
export function stepLine(block: WorkoutBlock): { label: string; detail: string } {
  if (block.kind === 'repeat') {
    const detail =
      String(block.count) +
      ' × ' +
      formatInterval(block.work) +
      ' / ' +
      formatInterval(block.rest) +
      ' easy';
    return { label: 'Main set', detail };
  }
  return { label: LABEL[block.kind], detail: formatInterval(block) };
}
