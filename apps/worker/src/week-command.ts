import { format, parseISO } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { Profile } from '@prisma/client';
import {
  addDaysIso,
  blockEndDate,
  blockWeekStart,
  expandWeek,
  raceWeekHours,
  seasonWeekTargets,
  TrainingBlockType,
  weekIndexForDate,
  weekVolume,
  type ExpandedWeek,
  type RulesContext,
  type SeasonPlan,
  type TrainingBlock,
} from '@triathlon/core';
import { MSG_NO_PROFILE, toUserProfile } from './profile';
import { racesForRange, type UpcomingRaces } from './season-races';
import { formatDayHeader, formatSession, groupSessionsByDate } from './session-format';

export const MSG_NO_SEASON =
  "📭 You don't have an active season plan yet, so there is no block week to show. Build one with /season new, or use /plan for a 7-day plan.";
export const MSG_NOT_IN_SEASON =
  '📭 Today is outside your active season plan, so there is no block week to show.';
export const MSG_WEEK_USAGE = '❌ Usage: /week show';

export interface SeasonRepo {
  /** The athlete's active season plan, blocks ordered by `order`. */
  findActiveSeason(userId: string): Promise<SeasonPlan | null>;
}

export interface WeekShowDeps {
  repo: SeasonRepo;
  races: UpcomingRaces;
  /** Rules-engine input for a week starting on `date` (handlers.ts `getRulesContext`) */
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
  now: () => Date;
}

const BLOCK_LABEL: Record<TrainingBlockType, string> = {
  [TrainingBlockType.base]: 'Base',
  [TrainingBlockType.build]: 'Build',
  [TrainingBlockType.peak]: 'Peak',
  [TrainingBlockType.taper]: 'Taper',
  [TrainingBlockType.race]: 'Race',
  [TrainingBlockType.recovery]: 'Recovery',
  [TrainingBlockType.transition]: 'Transition',
};

function findBlockWeek(
  blocks: TrainingBlock[],
  date: string
): { block: TrainingBlock; weekIndex: number } | null {
  for (const block of blocks) {
    const weekIndex = weekIndexForDate(block, date);
    if (weekIndex !== null) return { block, weekIndex };
  }
  return null;
}

function hours(value: number): string {
  return `${value.toFixed(1)}h`;
}

function shortDate(date: string): string {
  return format(parseISO(date), 'MMM d');
}

function formatWeek(block: TrainingBlock, weekIndex: number, week: ExpandedWeek): string {
  const planned = weekVolume(week.plan.sessions);
  const { targets } = week;
  const weekEnd = blockEndDate({ startDate: week.weekStart, weeks: 1 });

  let response = `📆 Week ${weekIndex + 1}/${block.weeks} · ${BLOCK_LABEL[block.type]} block (${shortDate(week.weekStart)} – ${shortDate(weekEnd)})\n`;
  if (block.focus) response += `🎯 ${block.focus}\n`;
  response += `⏱ ${hours(planned.hours)} planned of ${hours(targets.hours)} target\n`;
  response += `🏊 ${hours(planned.swimH)}/${hours(targets.swimH)} · 🚴 ${hours(planned.bikeH)}/${hours(targets.bikeH)} · 🏃 ${hours(planned.runH)}/${hours(targets.runH)}\n`;

  for (const [date, sessions] of groupSessionsByDate(week.plan.sessions)) {
    response += formatDayHeader(date);
    response += sessions.map((s) => formatSession(s)).join('');
  }

  if (week.plan.warnings.length > 0) {
    response += `\n⚠️ Adjustments:\n${week.plan.warnings.join('\n')}\n`;
  }
  if (week.violations.length > 0) {
    const issues = week.violations.map((v) => '• ' + v.message).join('\n');
    response += `\n❗ Still breaks hard rules:\n${issues}\n`;
  }
  return response;
}

/**
 * `/week show`: the current week of the active season plan, expanded into sessions and
 * checked by the rules engine. Read-only; /plan still owns the stored PlannedSessions.
 */
export async function handleWeekShow(
  user: { id: string; profile: Profile | null },
  deps: WeekShowDeps
): Promise<string> {
  if (!user.profile) return MSG_NO_PROFILE;
  const season = await deps.repo.findActiveSeason(user.id);
  if (!season) return MSG_NO_SEASON;

  const profile = toUserProfile(user.profile);
  const today = format(toZonedTime(deps.now(), profile.timezone), 'yyyy-MM-dd');
  const found = findBlockWeek(season.blocks, today);
  if (!found) return MSG_NOT_IN_SEASON;

  const { block, weekIndex } = found;
  const weekStart = blockWeekStart(block, weekIndex);
  const range = { from: weekStart, to: addDaysIso(weekStart, 6) };
  const [context, races] = await Promise.all([
    deps.getRulesContext(user.id, weekStart),
    racesForRange(deps.races, user.id, season, range),
  ]);
  const week = expandWeek(block, weekIndex, profile, {
    context,
    targets: seasonWeekTargets(block, weekIndex),
    races,
    aRaceWeekHours: raceWeekHours(season.blocks),
  });
  return formatWeek(block, weekIndex, week);
}
