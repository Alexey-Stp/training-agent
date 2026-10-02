/**
 * Contract between the bot's `/season new` wizard and the worker: the internal command names
 * the bot enqueues and the inline-button callback data the worker puts on its preview reply.
 */

/** args: [weeklyHours, weakSport | 'none'] */
export const SEASON_PREVIEW_COMMAND = 'season_preview';
/** args: [draftId] or [draftId, 'replace'] */
export const SEASON_CONFIRM_COMMAND = 'season_confirm';
/** args: [draftId] */
export const SEASON_CANCEL_COMMAND = 'season_cancel';

/** Weekly hours the wizard accepts */
export const SEASON_MIN_WEEKLY_HOURS = 3;
export const SEASON_MAX_WEEKLY_HOURS = 30;

/** Weak-sport answers; `none` gives the default sport split */
export const WEAK_SPORT_CHOICES = ['swim', 'bike', 'run', 'none'] as const;
export type WeakSportChoice = (typeof WEAK_SPORT_CHOICES)[number];

export function isWeakSportChoice(value: string): value is WeakSportChoice {
  return (WEAK_SPORT_CHOICES as readonly string[]).includes(value);
}

/** Wizard hours answer (e.g. "10", "7.5", "12h"), or null when it isn't a number in range. */
export function parseWeeklyHours(value: string): number | null {
  const match = /^(\d{1,2}(?:[.,]\d)?)\s*h?$/i.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1].replace(',', '.'));
  return hours >= SEASON_MIN_WEEKLY_HOURS && hours <= SEASON_MAX_WEEKLY_HOURS ? hours : null;
}

/** `replace` confirms a draft that replaces the active season; `save` refuses to. */
export type SeasonDecision = 'save' | 'replace' | 'cancel';

const DECISIONS: readonly SeasonDecision[] = ['save', 'replace', 'cancel'];
/** Draft ids are Prisma cuids; the bound also keeps callback data under Telegram's 64 bytes */
const DRAFT_ID_RE = /^[a-z0-9]{1,40}$/i;

/** Callback data of a preview button, e.g. `sd:save:<draftId>`. */
export function seasonDecisionData(decision: SeasonDecision, draftId: string): string {
  return `sd:${decision}:${draftId}`;
}

/** Inverse of `seasonDecisionData`; null for anything else. */
export function parseSeasonDecision(
  data: string
): { decision: SeasonDecision; draftId: string } | null {
  const [prefix, decision, draftId, ...rest] = data.split(':');
  if (prefix !== 'sd' || rest.length > 0 || draftId === undefined) return null;
  if (!DECISIONS.includes(decision as SeasonDecision) || !DRAFT_ID_RE.test(draftId)) return null;
  return { decision: decision as SeasonDecision, draftId };
}
