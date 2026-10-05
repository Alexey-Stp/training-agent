import {
  blockReviewData,
  escapeHtml,
  formatBlockDiff,
  type BlockVerdict,
  type TrainingBlock,
} from '@triathlon/core';
import type { BlockReviewText } from '@triathlon/ai';
import type { InlineButton, RichReply } from '../reply';
import { STALE_NOTE } from './weekly-review-render';

export const SEASON_KEPT_LINE = 'Season unchanged.';

export interface BlockReportInput {
  runId: string;
  verdict: BlockVerdict;
  review: BlockReviewText;
  /** Set on a race move: the A-race dates before and after */
  raceMove: { name: string; from: string; to: string } | null;
  /** Old and re-projected blocks when the report proposes a re-projection, else null */
  diff: { before: TrainingBlock[]; after: TrainingBlock[]; freezeThrough: string } | null;
  /** The activity sync failed: the stats may miss activities */
  stale: boolean;
}

/** LLM text on one line, HTML-escaped */
function oneLine(text: string): string {
  return escapeHtml(text.replaceAll('\n', ' ').trim());
}

function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return day + '.' + month;
}

function header(input: BlockReportInput): string {
  const v = input.verdict;
  const move = input.raceMove;
  if (move) {
    const dates = shortDate(move.from) + ' → ' + shortDate(move.to);
    return '🧱 <b>A-race moved</b> · ' + escapeHtml(move.name) + ' ' + dates;
  }
  const block = 'Block ' + v.blockOrder.toString() + ' (' + v.blockType + ') review';
  return '🧱 <b>' + block + '</b> · ' + shortDate(v.from) + ' → ' + shortDate(v.to);
}

function volumeLine(v: BlockVerdict): string {
  if (v.volumeAchievedPct === null) return '📦 Volume: no weekly stats';
  const hours = (v.achievedWeeklyHours ?? 0).toFixed(1) + '/' + v.targetWeeklyHours.toFixed(1);
  return '📦 Volume ' + v.volumeAchievedPct.toFixed(0) + '% of target (' + hours + ' h/wk)';
}

function signed(value: number): string {
  return value > 0 ? '+' + value.toFixed(1) : value.toFixed(1);
}

function ctlLine(v: BlockVerdict): string | null {
  if (v.ctlStart === null || v.ctlEnd === null || v.ctlDelta === null) return null;
  const target = v.targetCtl === null ? '' : ' · target ' + v.targetCtl.toFixed(1);
  const range = v.ctlStart.toFixed(1) + ' → ' + v.ctlEnd.toFixed(1);
  return '📈 CTL ' + range + ' (' + signed(v.ctlDelta) + ')' + target;
}

function complianceLine(v: BlockVerdict): string | null {
  const weeks = v.weekly.flatMap((w) =>
    w.compliancePct === null ? [] : [w.compliancePct.toFixed(0) + '%']
  );
  if (weeks.length === 0) return null;
  return '📊 Compliance ' + v.complianceTrend + ': ' + weeks.join(' · ');
}

function reviewLines(review: BlockReviewText): string[] {
  return [
    oneLine(review.summary),
    ...review.wins.map((w) => '✅ ' + oneLine(w)),
    ...review.concerns.map((c) => '⚠️ ' + oneLine(c)),
    ...(review.note === null ? [] : ['ℹ️ ' + oneLine(review.note)]),
  ];
}

function diffLines(diff: NonNullable<BlockReportInput['diff']>): string[] {
  const { before, after, summary } = formatBlockDiff(diff.before, diff.after, diff.freezeThrough);
  return [
    '<b>Re-projection</b> · ' + escapeHtml(summary),
    'Before:',
    '<pre>' + escapeHtml(before) + '</pre>',
    'After:',
    '<pre>' + escapeHtml(after) + '</pre>',
    'Past weeks stay as they are. Confirm to apply it from tomorrow.',
  ];
}

export function blockReviewKeyboard(runId: string): InlineButton[][] {
  return [
    [
      { text: '✅ Confirm re-projection', data: blockReviewData('confirm', runId) },
      { text: '✖ Decline', data: blockReviewData('decline', runId) },
    ],
  ];
}

/**
 * The block review report: the verdict against the block targets, the coach's words and, when
 * a re-projection is proposed, the old-vs-new block tables with Confirm/Decline.
 */
export function renderBlockReport(input: BlockReportInput): RichReply {
  const v = input.verdict;
  const stats = [volumeLine(v), ctlLine(v), complianceLine(v)].filter(
    (line): line is string => line !== null
  );
  const lines = [
    header(input),
    ...(input.stale ? [STALE_NOTE] : []),
    ...stats,
    '',
    ...reviewLines(input.review),
    '',
    ...(input.diff ? diffLines(input.diff) : [SEASON_KEPT_LINE]),
  ];
  const reply: RichReply = { text: lines.join('\n'), html: true };
  return input.diff ? { ...reply, keyboard: blockReviewKeyboard(input.runId) } : reply;
}
