import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import type { Profile } from '@prisma/client';
import {
  addDaysIso,
  isIsoDate,
  localToday,
  RacePriority,
  RaceType,
  type Race,
} from '@triathlon/core';
import { MSG_NO_PROFILE } from './profile';

const RACE_TYPES = Object.values(RaceType);
const PRIORITIES = Object.values(RacePriority);
const MAX_NAME_LENGTH = 100;

const TRAVEL_PREFIX = 'travel=';
/** A travel day further out than this is not race travel */
const MAX_TRAVEL_DAYS_BEFORE = 7;

export const MSG_RACE_USAGE = `❌ Usage: /race add <yyyy-MM-dd> <type> <A|B|C> <name> [travel=<yyyy-MM-dd>]
Type: ${RACE_TYPES.join('|')}
Example: /race add 2027-06-12 olympic A Prague Triathlon travel=2027-06-11
travel= is optional: a travel day in the 3 days before the race becomes a rest day.
Or /race list to see your upcoming races.
Or /race move <yyyy-MM-dd> <yyyy-MM-dd> to change a race's date.`;

export const MSG_REPROJECTION_COMING =
  'It is your A-race: a re-projection of your season is on its way.';

export const MSG_RACE_MOVE_USAGE =
  '❌ Usage: /race move <current yyyy-MM-dd> <new yyyy-MM-dd>, e.g. /race move 2027-06-12 2027-06-26';

export interface RaceRecord extends Race {
  id: string;
}

export interface RaceRepo {
  create(userId: string, race: Race): Promise<RaceRecord>;
  /** Races dated on/after `fromDate`, date ascending. */
  listUpcoming(userId: string, fromDate: string): Promise<RaceRecord[]>;
  findByDate(userId: string, date: string): Promise<RaceRecord[]>;
  /** Sets the race date and travel day. Returns false when the race is gone. */
  moveDate(
    userId: string,
    raceId: string,
    date: string,
    travelDate: string | null
  ): Promise<boolean>;
}

/** An A-race date change that the block review re-projects the season for. */
export interface RaceMove {
  raceId: string;
  previousDate: string;
  newDate: string;
}

export interface RaceCommandDeps {
  repo: RaceRepo;
  /** The id of the active season's A-race, or null without an active season */
  activeARaceId(userId: string): Promise<string | null>;
  /** Enqueues a block review (trigger race_move) for the athlete */
  queueBlockReview(userId: string, move: RaceMove): Promise<void>;
  now(): Date;
}

export type ParsedRace = { ok: true; race: Race } | { ok: false; error: string };

/** The `travel=<date>` token pulled out of `args`; the other args keep their order. */
function splitTravel(args: string[]): { rest: string[]; travel: string | null } {
  const token = args.find((a) => a.toLowerCase().startsWith(TRAVEL_PREFIX));
  if (token === undefined) return { rest: args, travel: null };
  return { rest: args.filter((a) => a !== token), travel: token.slice(TRAVEL_PREFIX.length) };
}

function travelError(travel: string, raceDate: string): string | null {
  if (!isIsoDate(travel)) return `❌ travel=${travel} is not a yyyy-MM-dd date.`;
  const daysBefore = differenceInCalendarDays(parseISO(raceDate), parseISO(travel));
  if (daysBefore < 1 || daysBefore > MAX_TRAVEL_DAYS_BEFORE) {
    return `❌ The travel day must be 1 to ${MAX_TRAVEL_DAYS_BEFORE.toString()} days before the race.`;
  }
  return null;
}

/**
 * `<yyyy-MM-dd> <type> <A|B|C> <name…> [travel=<yyyy-MM-dd>]`; the race must be after `today`
 * (athlete-local) and the travel day 1–7 days before it.
 */
export function parseRaceAddArgs(args: string[], today: string): ParsedRace {
  const { rest, travel } = splitTravel(args);
  const [date, type, priority, ...nameParts] = rest;
  const name = nameParts.join(' ').trim();
  if (!date || !type || !priority || !name) return { ok: false, error: MSG_RACE_USAGE };

  if (!isIsoDate(date)) return { ok: false, error: `❌ ${date} is not a yyyy-MM-dd date.` };
  if (date <= today) return { ok: false, error: '❌ The race date must be after today.' };

  const raceType = type.toLowerCase() as RaceType;
  if (!RACE_TYPES.includes(raceType)) {
    return { ok: false, error: `❌ Race type must be one of: ${RACE_TYPES.join(', ')}` };
  }
  const racePriority = priority.toUpperCase() as RacePriority;
  if (!PRIORITIES.includes(racePriority)) {
    return { ok: false, error: '❌ Priority must be A, B or C.' };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      error: `❌ Race name is limited to ${MAX_NAME_LENGTH.toString()} characters.`,
    };
  }
  const travelIssue = travel === null ? null : travelError(travel, date);
  if (travelIssue) return { ok: false, error: travelIssue };
  const race: Race = { date, type: raceType, priority: racePriority, name };
  return { ok: true, race: travel === null ? race : { ...race, travelDate: travel } };
}

function formatRace(race: Race): string {
  const line = `${format(parseISO(race.date), 'EEE MMM d, yyyy')} · ${race.priority} · ${race.type} · ${race.name}`;
  if (!race.travelDate) return line;
  return line + ' · ✈️ ' + format(parseISO(race.travelDate), 'EEE MMM d');
}

/** The travel day kept the same number of days before the moved race. */
function movedTravel(race: Race, to: string): string | null {
  if (!race.travelDate) return null;
  const shift = differenceInCalendarDays(parseISO(to), parseISO(race.date));
  return addDaysIso(race.travelDate, shift);
}

async function handleRaceAdd(
  userId: string,
  args: string[],
  today: string,
  deps: RaceCommandDeps
): Promise<string> {
  const parsed = parseRaceAddArgs(args, today);
  if (!parsed.ok) return parsed.error;

  await deps.repo.create(userId, parsed.race);
  const hint =
    parsed.race.priority === RacePriority.A
      ? '\n\nRun /season new to build a season plan towards it.'
      : '';
  return `✅ Race added: ${formatRace(parsed.race)}${hint}`;
}

async function handleRaceList(
  userId: string,
  today: string,
  deps: RaceCommandDeps
): Promise<string> {
  const races = await deps.repo.listUpcoming(userId, today);
  if (races.length === 0) return '📭 No upcoming races. Add one with /race add.';
  const lines = races.map((r) => '• ' + formatRace(r));
  return ['🏁 Upcoming races', '', ...lines].join('\n');
}

function parseMoveArgs(args: string[], today: string): { from: string; to: string } | string {
  const [from, to, ...rest] = args;
  if (!from || !to || rest.length > 0) return MSG_RACE_MOVE_USAGE;
  if (!isIsoDate(from)) return `❌ ${from} is not a yyyy-MM-dd date.`;
  if (!isIsoDate(to)) return `❌ ${to} is not a yyyy-MM-dd date.`;
  if (to <= today) return '❌ The new race date must be after today.';
  if (to === from) return '❌ The race is already on ' + from + '.';
  return { from, to };
}

/**
 * `/race move <date> <new date>`: moves the race on `date`. When it is the active season's
 * A-race, a block review offers to re-project the remaining blocks for the new date.
 */
async function handleRaceMove(
  userId: string,
  args: string[],
  today: string,
  deps: RaceCommandDeps
): Promise<string> {
  const parsed = parseMoveArgs(args, today);
  if (typeof parsed === 'string') return parsed;

  const races = await deps.repo.findByDate(userId, parsed.from);
  if (races.length === 0) return `❌ No race on ${parsed.from}. See /race list.`;
  if (races.length > 1) return `❌ More than one race on ${parsed.from}; can't tell which to move.`;
  const race = races[0];
  const travelDate = movedTravel(race, parsed.to);
  if (!(await deps.repo.moveDate(userId, race.id, parsed.to, travelDate))) {
    return `❌ No race on ${parsed.from}. See /race list.`;
  }

  const moved = `✅ Race moved: ${formatRace({ ...race, date: parsed.to, travelDate })}`;
  if ((await deps.activeARaceId(userId)) !== race.id) return moved;
  await deps.queueBlockReview(userId, {
    raceId: race.id,
    previousDate: parsed.from,
    newDate: parsed.to,
  });
  return [moved, '', MSG_REPROJECTION_COMING].join('\n');
}

/** `/race add …`, `/race list` and `/race move …`. */
export async function handleRace(
  user: { id: string; profile: Profile | null },
  args: string[],
  deps: RaceCommandDeps
): Promise<string> {
  if (!user.profile) return MSG_NO_PROFILE;
  const today = localToday(deps.now(), user.profile.timezone);
  switch (args[0]?.toLowerCase()) {
    case 'add':
      return handleRaceAdd(user.id, args.slice(1), today, deps);
    case 'list':
      return handleRaceList(user.id, today, deps);
    case 'move':
      return handleRaceMove(user.id, args.slice(1), today, deps);
    default:
      return MSG_RACE_USAGE;
  }
}
