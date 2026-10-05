/**
 * Contract between the bot and the worker for the subjective morning check-in: the internal
 * command name, the callback data of its readiness/soreness buttons and the soreness scale stored
 * in `Wellness.soreness`.
 */

/** args: [field, value], e.g. ['r', '4'] or ['s', '1']; the run is found by the tapped message id */
export const CHECKIN_ANSWER_COMMAND = 'checkin_answer';

/** `r` = subjectiveReadiness (1-5), `s` = soreness (`SORENESS_LEVELS`) */
export type CheckInField = 'r' | 's';

export type SorenessLevel = 'none' | 'mild' | 'severe';

/** Values stored in `Wellness.soreness` */
export const SORENESS_LEVELS: Readonly<Record<SorenessLevel, number>> = {
  none: 0,
  mild: 1,
  severe: 2,
};

const SORENESS_LABELS: ReadonlyMap<number, SorenessLevel> = new Map([
  [0, 'none'],
  [1, 'mild'],
  [2, 'severe'],
]);

export const READINESS_VALUES: readonly number[] = [1, 2, 3, 4, 5];

const VALID_VALUES: Readonly<Record<CheckInField, ReadonlySet<number>>> = {
  r: new Set(READINESS_VALUES),
  s: new Set(SORENESS_LABELS.keys()),
};

/** Label of a stored soreness value; null for null or a value outside the scale. */
export function sorenessLabel(value: number | null): SorenessLevel | null {
  if (value === null) return null;
  return SORENESS_LABELS.get(value) ?? null;
}

/** Callback data of a check-in button, e.g. `ci:r:4`. */
export function checkInData(field: CheckInField, value: number): string {
  return `ci:${field}:${value.toString()}`;
}

function isField(code: string | undefined): code is CheckInField {
  return code === 'r' || code === 's';
}

/** Inverse of `checkInData`, also used on job args; null for anything else. */
export function parseCheckInAnswer(
  field: string | undefined,
  raw: string | undefined
): { field: CheckInField; value: number } | null {
  if (!isField(field) || raw === undefined || !/^\d$/.test(raw)) return null;
  const value = Number(raw);
  return VALID_VALUES[field].has(value) ? { field, value } : null;
}

/** Parses `ci:<field>:<value>` callback data; null for anything else. */
export function parseCheckInData(data: string): { field: CheckInField; value: number } | null {
  const [prefix, field, raw, ...rest] = data.split(':');
  if (prefix !== 'ci' || rest.length > 0) return null;
  return parseCheckInAnswer(field, raw);
}
