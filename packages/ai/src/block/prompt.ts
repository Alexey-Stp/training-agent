import {
  blockEndDate,
  formatSeasonTable,
  type BlockVerdict,
  type Race,
  type TrainingBlock,
} from '@triathlon/core';
import { loadPromptTemplate, renderTemplate } from '../context/template';

export const BLOCK_PROMPT_VERSION = 'block-v1';

/** `block_end`: the block's last day; `race_move`: the A-race date changed mid-season */
export type BlockReviewTrigger = 'block_end' | 'race_move';

export interface BlockReviewConfig {
  /** Volume achieved outside 100 ± this % always proposes the re-projection */
  thresholdPct: number;
}

export const DEFAULT_BLOCK_REVIEW_CONFIG: BlockReviewConfig = { thresholdPct: 15 };

export interface BlockPromptInput {
  /** Review day, athlete-local */
  date: string;
  trigger: BlockReviewTrigger;
  /** The reviewed block (on a race move, the block in progress) */
  block: TrainingBlock;
  verdict: BlockVerdict;
  aRace: Race | null;
  /** The A-race date before the move; null unless `trigger` is `race_move` */
  previousRaceDate: string | null;
  /** The old blocks after the freeze date */
  remaining: readonly TrainingBlock[];
  /** The re-projected blocks after the freeze date; null when no valid one exists */
  proposed: readonly TrainingBlock[] | null;
  /** Why there is no re-projection, when `proposed` is null */
  proposalIssue: string | null;
}

const FENCE = '```';

/** `value` with fixed decimals, or 'n/a'. Fixed precision keeps the prompt byte-stable. */
function num(value: number | null, digits = 1): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function signed(value: number | null): string {
  if (value === null) return 'n/a';
  return value > 0 ? '+' + value.toFixed(1) : value.toFixed(1);
}

function renderTrigger(input: BlockPromptInput): string {
  if (input.trigger === 'block_end') return 'The block ends today.';
  const from = input.previousRaceDate ?? 'n/a';
  const to = input.aRace?.date ?? 'n/a';
  return `The athlete moved the A-race from ${from} to ${to}; the block is still in progress.`;
}

function renderTargets(block: TrainingBlock): string {
  const ctl = block.targetCtl === null ? 'no CTL target' : 'CTL target ' + num(block.targetCtl);
  const perWeek = [
    num(block.targetWeeklyHours) + ' h',
    'swim ' + block.targetSwimM.toString() + ' m',
    'bike ' + num(block.targetBikeH) + ' h',
    'run ' + num(block.targetRunKm) + ' km',
  ].join(', ');
  return [
    `Focus: ${block.focus}. ${block.weeks.toString()} weeks.`,
    `Per week: ${perWeek}; ${ctl}.`,
  ].join('\n');
}

function renderVolume(v: BlockVerdict): string {
  if (v.volumeAchievedPct === null) return 'Volume achieved: n/a (no weekly stats).';
  const hours = `${num(v.achievedWeeklyHours)} of ${num(v.targetWeeklyHours)} h/week`;
  return `Volume achieved: ${num(v.volumeAchievedPct)}% of target (${hours}).`;
}

function renderVerdict(v: BlockVerdict): string {
  const gap = v.ctlGap === null ? '' : ', ' + signed(v.ctlGap) + ' vs target';
  const ctl = `CTL: ${num(v.ctlStart)} → ${num(v.ctlEnd)} (${signed(v.ctlDelta)}${gap}).`;
  const missing =
    v.missingWeeks.length === 0 ? [] : ['Weeks without stats: ' + v.missingWeeks.join(', ') + '.'];
  return [renderVolume(v), ctl, `Compliance trend: ${v.complianceTrend}.`, ...missing].join('\n');
}

function renderWeekly(v: BlockVerdict): string {
  if (v.weekly.length === 0) return 'No weekly stats.';
  return v.weekly
    .map((w) => {
      const pct = w.compliancePct === null ? 'nothing planned' : num(w.compliancePct) + '%';
      const minutes = w.actualMin.toFixed(0) + ' of ' + w.plannedMin.toFixed(0) + ' min';
      return `- ${w.isoWeek}: ${minutes} (${pct})`;
    })
    .join('\n');
}

function renderRace(input: BlockPromptInput): string {
  const race = input.aRace;
  if (!race) return 'No A-race set.';
  return `A-race: ${race.name} (${race.type}) on ${race.date}.`;
}

function table(blocks: readonly TrainingBlock[]): string {
  return blocks.length === 0 ? '(none)' : formatSeasonTable([...blocks]);
}

function renderProposal(input: BlockPromptInput): string {
  if (input.proposed === null) {
    return 'No re-projection is possible: ' + (input.proposalIssue ?? 'unknown reason') + '.';
  }
  const first = input.proposed.at(0);
  const last = input.proposed.at(-1);
  const span = first && last ? first.startDate + ' → ' + blockEndDate(last) : 'n/a';
  return [
    `Remaining blocks re-projected from the volume actually achieved (${span}):`,
    '',
    FENCE,
    table(input.proposed),
    FENCE,
  ].join('\n');
}

/** Values for every placeholder of `block-v1`. Pure and byte-deterministic. */
export function renderBlockSections(
  input: BlockPromptInput,
  config: BlockReviewConfig = DEFAULT_BLOCK_REVIEW_CONFIG
): Record<string, string> {
  const { block, verdict } = input;
  return {
    order: block.order.toString(),
    type: block.type,
    from: verdict.from,
    to: verdict.to,
    date: input.date,
    trigger: renderTrigger(input),
    targets: renderTargets(block),
    verdict: renderVerdict(verdict),
    weekly: renderWeekly(verdict),
    race: renderRace(input),
    remaining: table(input.remaining),
    proposal: renderProposal(input),
    threshold: config.thresholdPct.toFixed(0),
  };
}

/** The block review prompt: the block verdict, the season and the proposed re-projection. */
export function buildBlockPrompt(
  input: BlockPromptInput,
  config: BlockReviewConfig = DEFAULT_BLOCK_REVIEW_CONFIG
): string {
  const template = loadPromptTemplate(BLOCK_PROMPT_VERSION);
  return renderTemplate(template, renderBlockSections(input, config));
}
