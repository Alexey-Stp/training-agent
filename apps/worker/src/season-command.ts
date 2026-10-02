import { format, parseISO } from 'date-fns';
import type { Profile } from '@prisma/client';
import {
  addDaysIso,
  assertValidSeasonPlan,
  escapeHtml,
  formatSeasonTable,
  generateSeasonPlan,
  isWeakSportChoice,
  localToday,
  parseWeeklyHours,
  RacePriority,
  SeasonGenerationError,
  seasonDecisionData,
  SeasonPlanStatus,
  seasonRange,
  Sport,
  weekIndexForDate,
  type GeneratedSeason,
  type Race,
  type SeasonPlan,
  type TrainingBlock,
  type WeakSportChoice,
} from '@triathlon/core';
import { MSG_NO_PROFILE } from './profile';
import type { RaceRecord, RaceRepo } from './race-command';
import type { InlineButton, Reply } from './reply';
import type { SeasonRepo } from './week-command';

/** Weeks of history the current training load is averaged over */
const LOAD_WEEKS = 4;
/** Share of the available hours assumed as current load when nothing was synced */
const DEFAULT_LOAD_SHARE = 0.5;

export const MSG_SEASON_USAGE = '❌ Usage: /season new | /season show';
export const MSG_NO_A_RACE =
  '📭 A season plan is built towards an A race, and you have none coming up.\nAdd one first, e.g. /race add 2027-06-12 olympic A Prague Triathlon';
export const MSG_BAD_WIZARD_INPUT =
  '❌ Something was off with your answers. Please run /season new again.';
export const MSG_DRAFT_GONE =
  '⌛ That season preview is no longer available. Run /season new to build a fresh one.';
export const MSG_NO_ACTIVE_SEASON =
  "📭 You don't have an active season plan yet. Build one with /season new.";
export const MSG_DRAFT_DISCARDED = '✖ Season preview discarded. Nothing was changed.';

const WEAK_SPORTS: Record<WeakSportChoice, Sport | undefined> = {
  swim: Sport.swim,
  bike: Sport.bike,
  run: Sport.run,
  none: undefined,
};

export interface SeasonDraftInput {
  startDate: string;
  aRaceId: string;
  blocks: TrainingBlock[];
}

export type ActivateDraftResult =
  | { status: 'activated'; replaced: boolean }
  /** The draft was activated before (a retried confirm) */
  | { status: 'already_active' }
  /** Another season is active and the confirm didn't acknowledge replacing it */
  | { status: 'needs_replace' }
  | { status: 'not_found' };

export interface SeasonStoreRepo extends SeasonRepo {
  /** Deletes the user's other drafts and stores this one (status draft); returns its id. */
  replaceDraft(userId: string, draft: SeasonDraftInput): Promise<string>;
  /**
   * Atomically makes the draft the active season. Archives the current active season only
   * when `replace` is set; without it an active season makes this return needs_replace.
   */
  activateDraft(
    userId: string,
    draftId: string,
    opts: { replace: boolean }
  ): Promise<ActivateDraftResult>;
  /** Returns true if a draft was deleted. */
  deleteDraft(userId: string, draftId: string): Promise<boolean>;
}

export interface SeasonCommandDeps {
  seasons: SeasonStoreRepo;
  races: RaceRepo;
  /** Training hours synced from intervals.icu, dated from..to (athlete-local, inclusive) */
  loadTrainingHours(userId: string, from: string, to: string): Promise<number>;
  hasIcuConnection(userId: string): Promise<boolean>;
  /** Queues an immediate rolling publish for the user */
  publish(userId: string, draftId: string): Promise<void>;
  /** The season is saved either way; the scheduled publisher picks it up on its next run */
  onPublishError(error: unknown, userId: string): void;
  now(): Date;
}

type UserRef = { id: string; profile: Profile | null };

function longDate(date: string): string {
  return format(parseISO(date), 'EEE MMM d, yyyy');
}

function raceLabel(race: Race): string {
  return `${race.name} (${race.type}, ${longDate(race.date)})`;
}

function parseWizardArgs(args: string[]): { hours: number; weakSport: Sport | undefined } | null {
  const hours = parseWeeklyHours(args[0] ?? '');
  const choice = args[1]?.toLowerCase() ?? '';
  if (hours === null || !isWeakSportChoice(choice)) return null;
  return { hours, weakSport: WEAK_SPORTS[choice] };
}

/** Average weekly hours of the last 4 weeks before today; null when nothing was synced. */
async function currentLoad(
  userId: string,
  today: string,
  deps: SeasonCommandDeps
): Promise<number | null> {
  const total = await deps.loadTrainingHours(
    userId,
    addDaysIso(today, -LOAD_WEEKS * 7),
    addDaysIso(today, -1)
  );
  return total > 0 ? Math.round((total / LOAD_WEEKS) * 10) / 10 : null;
}

function blockAt(blocks: TrainingBlock[], date: string): TrainingBlock | undefined {
  return blocks.find((b) => weekIndexForDate(b, date) !== null);
}

/** B/C races inside the season, with the block they fall in. */
function otherRaceLines(races: RaceRecord[], aRace: RaceRecord, blocks: TrainingBlock[]): string[] {
  return races
    .filter((r) => r.id !== aRace.id)
    .flatMap((r) => {
      const block = blockAt(blocks, r.date);
      return block
        ? [`• ${escapeHtml(`${longDate(r.date)} ${r.priority} ${r.name}`)} (${block.type} block)`]
        : [];
    });
}

function previewKeyboard(draftId: string, replacing: boolean): InlineButton[][] {
  const confirm = replacing
    ? { text: '♻️ Replace current season', data: seasonDecisionData('replace', draftId) }
    : { text: '✅ Save season', data: seasonDecisionData('save', draftId) };
  return [[confirm, { text: '✖ Cancel', data: seasonDecisionData('cancel', draftId) }]];
}

interface PreviewInput {
  aRace: RaceRecord;
  hours: number;
  weakSport: Sport | undefined;
  load: number | null;
  assumedLoad: number;
  generated: GeneratedSeason;
  otherRaces: string[];
  active: SeasonPlan | null;
}

function previewText(p: PreviewInput): string {
  const weeks = p.generated.blocks.reduce((sum, b) => sum + b.weeks, 0);
  const lines = [
    `🗓 <b>Season plan: ${escapeHtml(raceLabel(p.aRace))}</b>`,
    `${weeks.toString()} weeks from ${longDate(p.generated.startDate)} · up to ${p.hours.toString()}h/week · weak sport: ${p.weakSport ?? 'none'}`,
    '',
    `<pre>${escapeHtml(formatSeasonTable(p.generated.blocks))}</pre>`,
    p.load === null
      ? `No synced training in the last 4 weeks, so I assumed ${p.assumedLoad.toString()}h/week as your current load.`
      : `Current load: ${p.load.toString()}h/week (last 4 weeks).`,
  ];
  if (p.otherRaces.length > 0) lines.push('', '🏁 Other races in this season:', ...p.otherRaces);
  if (p.generated.warnings.length > 0) {
    lines.push('', 'ℹ️ Notes:', ...p.generated.warnings.map((w) => `• ${escapeHtml(w)}`));
  }
  lines.push('');
  if (p.active) {
    const current = p.active.aRace ? escapeHtml(raceLabel(p.active.aRace)) : 'no A race';
    lines.push(
      `⚠️ <b>You already have an active season</b> (${current}). Saving this one replaces it; past sessions are not touched.`
    );
  }
  lines.push(p.active ? 'Replace your current season with this plan?' : 'Save this season plan?');
  return lines.join('\n');
}

/**
 * Last step of the `/season new` wizard: generates the season towards the next A race and
 * stores it as a draft. The reply shows the block table with confirm/cancel buttons.
 * Nothing becomes active until the athlete confirms.
 */
export async function handleSeasonPreview(
  user: UserRef,
  args: string[],
  deps: SeasonCommandDeps
): Promise<Reply> {
  if (!user.profile) return MSG_NO_PROFILE;
  const input = parseWizardArgs(args);
  if (!input) return MSG_BAD_WIZARD_INPUT;

  const today = localToday(deps.now(), user.profile.timezone);
  const races = await deps.races.listUpcoming(user.id, addDaysIso(today, 1));
  const aRace = races.find((r) => r.priority === RacePriority.A);
  if (!aRace) return MSG_NO_A_RACE;

  const load = await currentLoad(user.id, today, deps);
  const assumedLoad = Math.round(input.hours * DEFAULT_LOAD_SHARE * 10) / 10;
  let generated: GeneratedSeason;
  try {
    generated = generateSeasonPlan({
      aRace,
      weeklyHoursAvailable: input.hours,
      currentWeeklyLoad: load ?? assumedLoad,
      weakSport: input.weakSport,
      startDate: today,
    });
  } catch (error) {
    if (!(error instanceof SeasonGenerationError)) throw error;
    return `❌ I can't build a season towards ${raceLabel(aRace)}:\n${error.issues.map((i) => `• ${i}`).join('\n')}`;
  }
  // A generator bug, not a user error: let the job fail loudly
  assertValidSeasonPlan({
    startDate: generated.startDate,
    status: SeasonPlanStatus.draft,
    aRace,
    blocks: generated.blocks,
  });

  const draftId = await deps.seasons.replaceDraft(user.id, {
    startDate: generated.startDate,
    aRaceId: aRace.id,
    blocks: generated.blocks,
  });
  const active = await deps.seasons.findActiveSeason(user.id);
  const otherRaces = otherRaceLines(races, aRace, generated.blocks);

  return {
    text: previewText({ aRace, ...input, load, assumedLoad, generated, otherRaces, active }),
    html: true,
    keyboard: previewKeyboard(draftId, active !== null),
  };
}

async function savedReply(
  userId: string,
  replaced: boolean,
  deps: SeasonCommandDeps
): Promise<string> {
  const head = replaced ? '♻️ Season replaced.' : '✅ Season saved.';
  const next = (await deps.hasIcuConnection(userId))
    ? 'The coming days are being put on your intervals.icu calendar, and kept up to date from now on.'
    : 'Link intervals.icu with /connect icu to get the sessions on your calendar.';
  return `${head} ${next}\nSee it with /season show, this week with /week show.`;
}

/** Confirm button of the preview: activates the draft (args: [draftId, 'replace'?]). */
export async function handleSeasonConfirm(
  user: UserRef,
  args: string[],
  deps: SeasonCommandDeps
): Promise<Reply> {
  const [draftId, flag] = args;
  if (!draftId) return MSG_DRAFT_GONE;

  const result = await deps.seasons.activateDraft(user.id, draftId, {
    replace: flag === 'replace',
  });
  switch (result.status) {
    case 'not_found':
      return MSG_DRAFT_GONE;
    case 'needs_replace':
      // A season became active after the preview was sent: ask again, explicitly
      return {
        text: '⚠️ You already have an active season now. Replace it with this plan?',
        keyboard: previewKeyboard(draftId, true),
      };
    case 'already_active':
      return savedReply(user.id, false, deps);
    case 'activated':
      break;
  }

  try {
    await deps.publish(user.id, draftId);
  } catch (error) {
    deps.onPublishError(error, user.id);
  }
  return savedReply(user.id, result.replaced, deps);
}

/** Cancel button of the preview: discards the draft (args: [draftId]). */
export async function handleSeasonCancel(
  user: UserRef,
  args: string[],
  deps: SeasonCommandDeps
): Promise<string> {
  const [draftId] = args;
  const deleted = draftId ? await deps.seasons.deleteDraft(user.id, draftId) : false;
  return deleted ? MSG_DRAFT_DISCARDED : MSG_DRAFT_GONE;
}

function currentPosition(season: SeasonPlan, today: string): string {
  const range = seasonRange(season);
  if (range && today < range.from) return `Starts ${longDate(range.from)}.`;
  const block = blockAt(season.blocks, today);
  if (!block) return 'Today is past the end of this season.';
  const week = (weekIndexForDate(block, today) ?? 0) + 1;
  return `Now: block ${block.order.toString()} (${block.type}), week ${week.toString()}/${block.weeks.toString()}.`;
}

/** `/season show`: the active season's block table. */
export async function handleSeasonShow(user: UserRef, deps: SeasonCommandDeps): Promise<Reply> {
  if (!user.profile) return MSG_NO_PROFILE;
  const season = await deps.seasons.findActiveSeason(user.id);
  if (!season) return MSG_NO_ACTIVE_SEASON;

  const today = localToday(deps.now(), user.profile.timezone);
  const title = season.aRace ? escapeHtml(raceLabel(season.aRace)) : 'no A race';
  return {
    text: [
      `🗓 <b>Season plan: ${title}</b>`,
      currentPosition(season, today),
      '',
      `<pre>${escapeHtml(formatSeasonTable(season.blocks))}</pre>`,
      'This week in detail: /week show',
    ].join('\n'),
    html: true,
  };
}

/** `/season show`. `/season new` is the bot's wizard; it only reaches the worker as season_preview. */
export async function handleSeason(
  user: UserRef,
  args: string[],
  deps: SeasonCommandDeps
): Promise<Reply> {
  return args[0]?.toLowerCase() === 'show' ? handleSeasonShow(user, deps) : MSG_SEASON_USAGE;
}
