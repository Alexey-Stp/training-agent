import {
  READINESS_VALUES,
  SORENESS_LEVELS,
  checkInData,
  sorenessLabel,
  type CheckInField,
} from '@triathlon/core';
import { hasDeviceData, type HrvBaseline, type WellnessDay } from '@triathlon/ai';
import type { InlineButton, RichReply } from '../reply';

/** Why the morning check-in is asked: no device wellness today, or HRV off the baseline */
export type CheckInReason = 'no_data' | 'hrv_deviation';

/** The athlete's answers so far (`Wellness.subjectiveReadiness` / `soreness`) */
export interface CheckInAnswers {
  subjectiveReadiness: number | null;
  soreness: number | null;
}

/** Writes the subjective check-in columns only; sync owns the device columns. */
export interface CheckInRepo {
  /**
   * Sets one answer of the day, creating the Wellness row if needed. The first answer wins: a
   * field that is already set is left alone. Returns the day's answers after the write.
   */
  recordCheckIn(
    userId: string,
    date: string,
    field: CheckInField,
    value: number
  ): Promise<CheckInAnswers>;
}

function hrvDeviates(hrv: HrvBaseline): boolean {
  if (hrv.status !== 'ok' || hrv.today === null || hrv.mean === null || hrv.sd === null) {
    return false;
  }
  return Math.abs(hrv.today - hrv.mean) > hrv.sd;
}

export function isCheckInComplete(answers: CheckInAnswers): boolean {
  return answers.subjectiveReadiness !== null && answers.soreness !== null;
}

/**
 * Whether the brief asks the check-in first: today has no device data, or HRV is more than 1 SD
 * from its 30-day mean in either direction. Too few HRV readings for a baseline doesn't trigger
 * it, and neither does a day the athlete already answered.
 */
export function checkInReason(today: WellnessDay | null, hrv: HrvBaseline): CheckInReason | null {
  if (today && isCheckInComplete(today)) return null;
  if (!today || !hasDeviceData(today)) return 'no_data';
  return hrvDeviates(hrv) ? 'hrv_deviation' : null;
}

const SORENESS_BUTTONS: readonly { text: string; value: number }[] = [
  { text: '🙂 None', value: SORENESS_LEVELS.none },
  { text: '😐 Mild', value: SORENESS_LEVELS.mild },
  { text: '😣 Severe', value: SORENESS_LEVELS.severe },
];

function readinessRow(): InlineButton[] {
  return READINESS_VALUES.map((v) => ({ text: v.toString(), data: checkInData('r', v) }));
}

function sorenessRow(): InlineButton[] {
  return SORENESS_BUTTONS.map((b) => ({ text: b.text, data: checkInData('s', b.value) }));
}

function answerLines(answers: CheckInAnswers): string[] {
  const lines: string[] = [];
  if (answers.subjectiveReadiness !== null) {
    lines.push('Readiness: ' + answers.subjectiveReadiness.toString() + '/5 ✓');
  }
  const soreness = sorenessLabel(answers.soreness);
  if (soreness !== null) lines.push('Soreness: ' + soreness + ' ✓');
  return lines;
}

/**
 * The check-in message: readiness 1–5 and soreness none/mild/severe, one row each. A row
 * disappears once it is answered.
 */
export function renderCheckIn(answers: CheckInAnswers): RichReply {
  const keyboard = [
    ...(answers.subjectiveReadiness === null ? [readinessRow()] : []),
    ...(answers.soreness === null ? [sorenessRow()] : []),
  ];
  const lines = [
    '🌅 <b>Quick check-in before your brief</b>',
    'How ready do you feel (1 = wrecked, 5 = great), and how sore are you?',
    ...answerLines(answers),
  ];
  return { text: lines.join('\n'), html: true, keyboard };
}

/** The check-in once both answers are in, or after the brief already went out. */
export function renderCheckInDone(answers: CheckInAnswers, briefPending: boolean): RichReply {
  const tail = briefPending
    ? 'Thanks! Your brief is on its way.'
    : 'Thanks, saved. Today’s brief has already been sent.';
  const lines = ['🌅 <b>Check-in</b>', ...answerLines(answers), tail];
  return { text: lines.join('\n'), html: true, keyboard: [] };
}
