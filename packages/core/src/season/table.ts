import { format, parseISO } from 'date-fns';
import { TrainingBlock } from './types';
import { blockEndDate } from './validate';

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

interface Column {
  header: string;
  align: 'left' | 'right';
  cell(block: TrainingBlock): string;
}

function shortDate(date: string): string {
  return format(parseISO(date), 'dd.MM');
}

const COLUMNS: Column[] = [
  { header: '#', align: 'right', cell: (b) => b.order.toString() },
  { header: 'Type', align: 'left', cell: (b) => b.type },
  {
    header: 'Dates',
    align: 'left',
    cell: (b) => `${shortDate(b.startDate)}-${shortDate(blockEndDate(b))}`,
  },
  { header: 'Wk', align: 'right', cell: (b) => b.weeks.toString() },
  { header: 'h/wk', align: 'right', cell: (b) => b.targetWeeklyHours.toFixed(1) },
  { header: 'Swim', align: 'right', cell: (b) => `${(b.targetSwimM / 1000).toFixed(1)}k` },
  { header: 'Bike', align: 'right', cell: (b) => `${b.targetBikeH.toFixed(1)}h` },
  { header: 'Run', align: 'right', cell: (b) => `${Math.round(b.targetRunKm).toString()}km` },
];

function pad(text: string, width: number, align: Column['align']): string {
  return align === 'left' ? text.padEnd(width) : text.padStart(width);
}

/**
 * Fixed-width block table (one row per block, weekly targets per sport), meant for a
 * monospace `<pre>` reply. The text is plain; escape it before sending as HTML.
 */
export function formatSeasonTable(blocks: TrainingBlock[]): string {
  const sorted = [...blocks].sort((a, b) => a.order - b.order);
  const rows = [COLUMNS.map((c) => c.header), ...sorted.map((b) => COLUMNS.map((c) => c.cell(b)))];
  const widths = COLUMNS.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r) =>
      r
        .map((text, i) => pad(text, widths[i], COLUMNS[i].align))
        .join(' ')
        .trimEnd()
    )
    .join('\n');
}

export interface BlockDiff {
  /** Old blocks after the freeze */
  before: string;
  /** Re-projected blocks after the freeze */
  after: string;
  /** e.g. `Next block: 10.8 → 7.6 h/wk · remaining 98.0 → 84.4 h` */
  summary: string;
}

function totalHours(blocks: TrainingBlock[]): number {
  return blocks.reduce((sum, b) => sum + b.targetWeeklyHours * b.weeks, 0);
}

function after(blocks: TrainingBlock[], freezeThrough: string): TrainingBlock[] {
  return blocks.filter((b) => blockEndDate(b) > freezeThrough).sort((a, b) => a.order - b.order);
}

/**
 * Old-vs-new tables of the blocks after `freezeThrough` (plain text for `<pre>`), plus a summary
 * of the next block's weekly hours and the remaining season volume.
 */
export function formatBlockDiff(
  oldBlocks: TrainingBlock[],
  newBlocks: TrainingBlock[],
  freezeThrough: string
): BlockDiff {
  const oldRest = after(oldBlocks, freezeThrough);
  const newRest = after(newBlocks, freezeThrough).filter((b) => b.startDate > freezeThrough);
  const oldNext = oldRest.find((b) => b.startDate > freezeThrough) ?? oldRest.at(0);
  const newNext = newRest.at(0);
  const parts = [
    'Next block: ' +
      (oldNext?.targetWeeklyHours.toFixed(1) ?? '–') +
      ' → ' +
      (newNext?.targetWeeklyHours.toFixed(1) ?? '–') +
      ' h/wk',
    'remaining ' +
      totalHours(oldRest.filter((b) => b.startDate > freezeThrough)).toFixed(1) +
      ' → ' +
      totalHours(newRest).toFixed(1) +
      ' h',
  ];
  return {
    before: formatSeasonTable(oldRest),
    after: formatSeasonTable(newRest),
    summary: parts.join(' · '),
  };
}
