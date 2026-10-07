import {
  BRIEF_TIME_RE,
  OPTIONAL_SWIM_SUFFIX,
  PROFILE_WEEKDAYS,
  type ProfileWeekday,
} from '@triathlon/core';

/** What the Settings form edits; ids travel as strings (BigInt in the database). */
export interface ProfileSettings {
  ftp: number;
  lthr: number | null;
  timezone: string;
  briefTime: string | null;
  closeoutTime: string | null;
  swimDays: string[];
  bikeVo2Day: ProfileWeekday;
  longBikeDay: ProfileWeekday;
  noLongRunDay: ProfileWeekday;
  notifyChatId: string | null;
}

export type SettingsField = keyof ProfileSettings;

/** Raw urlencoded body: a repeated key (checkboxes) arrives as an array. */
export type FormBody = Record<string, string | string[] | undefined>;

export type SettingsResult =
  | { ok: true; value: ProfileSettings }
  | { ok: false; errors: Partial<Record<SettingsField, string>> };

export const FTP_RANGE = { min: 50, max: 600 } as const;
export const LTHR_RANGE = { min: 100, max: 220 } as const;
/** Two fixed swim days plus one optional, as the week expander reads them */
export const MAX_SWIM_DAYS = 2;

const WEEKDAYS: ReadonlySet<string> = new Set(PROFILE_WEEKDAYS);
// Chat ids: user ids are positive, groups and channels negative (-100…); the worker sends with
// Number(), so the id must stay a safe integer
const CHAT_ID_RE = /^-?\d{1,16}$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function valid<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function invalid(error: string): Parsed<never> {
  return { ok: false, error };
}

function one(body: FormBody, key: string): string {
  const value = body[key];
  return (Array.isArray(value) ? (value[0] ?? '') : (value ?? '')).trim();
}

function many(body: FormBody, key: string): string[] {
  const value = body[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => v.trim());
}

function intIn(raw: string, range: { min: number; max: number }): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= range.min && n <= range.max ? n : null;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isWeekday(value: string): value is ProfileWeekday {
  return WEEKDAYS.has(value);
}

function weekOrder(a: string, b: string): number {
  return (
    PROFILE_WEEKDAYS.indexOf(a as ProfileWeekday) - PROFILE_WEEKDAYS.indexOf(b as ProfileWeekday)
  );
}

function parseFtp(raw: string): Parsed<number> {
  const ftp = intIn(raw, FTP_RANGE);
  return ftp === null ? invalid('FTP must be a whole number from 50 to 600 W.') : valid(ftp);
}

function parseLthr(raw: string): Parsed<number | null> {
  if (raw === '') return valid(null);
  const lthr = intIn(raw, LTHR_RANGE);
  return lthr === null ? invalid('Threshold HR must be from 100 to 220 bpm.') : valid(lthr);
}

function parseTimezone(raw: string): Parsed<string> {
  return isValidTimezone(raw) ? valid(raw) : invalid('Choose a timezone from the list.');
}

function parseTime(raw: string, example: string): Parsed<string | null> {
  if (raw === '') return valid(null);
  return BRIEF_TIME_RE.test(raw) ? valid(raw) : invalid('Use HH:mm, e.g. ' + example + '.');
}

/** `["Fri","Wed"]` + `"Sun"` → `["Wed","Fri","Sun_optional"]` */
function parseSwimDays(days: string[], optional: string): Parsed<string[]> {
  const unique = [...new Set(days)];
  const daysOk = unique.length <= MAX_SWIM_DAYS && unique.every(isWeekday);
  const optionalOk = optional === '' || (isWeekday(optional) && !unique.includes(optional));
  if (!daysOk || !optionalOk) {
    return invalid('Pick up to two swim days, and an optional day that is not one of them.');
  }
  const sorted = [...unique].sort(weekOrder);
  return valid(optional ? [...sorted, optional + OPTIONAL_SWIM_SUFFIX] : sorted);
}

function parseDay(raw: string): Parsed<ProfileWeekday> {
  return isWeekday(raw) ? valid(raw) : invalid('Choose a day.');
}

function parseChatId(raw: string): Parsed<string | null> {
  if (raw === '') return valid(null);
  return CHAT_ID_RE.test(raw)
    ? valid(raw)
    : invalid('A chat id is a number, e.g. -1001234567890 for a channel.');
}

/**
 * Server-side validation of the Settings form. Every field is checked; the result carries
 * either the full new settings or one message per invalid field.
 */
export function validateSettings(body: FormBody): SettingsResult {
  const fields: { [K in SettingsField]: Parsed<ProfileSettings[K]> } = {
    ftp: parseFtp(one(body, 'ftp')),
    lthr: parseLthr(one(body, 'lthr')),
    timezone: parseTimezone(one(body, 'timezone')),
    briefTime: parseTime(one(body, 'briefTime'), '06:30'),
    closeoutTime: parseTime(one(body, 'closeoutTime'), '20:30'),
    swimDays: parseSwimDays(many(body, 'swimDays'), one(body, 'swimOptional')),
    bikeVo2Day: parseDay(one(body, 'bikeVo2Day')),
    longBikeDay: parseDay(one(body, 'longBikeDay')),
    noLongRunDay: parseDay(one(body, 'noLongRunDay')),
    notifyChatId: parseChatId(one(body, 'notifyChatId')),
  };
  const entries = Object.entries(fields) as [SettingsField, Parsed<unknown>][];
  const errors: Partial<Record<SettingsField, string>> = {};
  const values: Record<string, unknown> = {};
  for (const [field, parsed] of entries) {
    if (parsed.ok) values[field] = parsed.value;
    else errors[field] = parsed.error;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: values as unknown as ProfileSettings };
}
