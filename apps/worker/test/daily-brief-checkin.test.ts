import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckInField } from '@triathlon/core';
import { emptyWellnessDay, type HrvBaseline, type WellnessDay } from '@triathlon/ai';
import {
  checkInReason,
  renderCheckIn,
  type CheckInAnswers,
  type CheckInRepo,
} from '../src/daily-loop/checkin';
import {
  handleCheckInAnswer,
  MSG_CHECKIN_INVALID,
  MSG_CHECKIN_NOT_FOUND,
  type CheckInAnswerDeps,
} from '../src/daily-loop/checkin-answer';
import type { CheckInRun, DailyBriefStatus } from '../src/daily-loop/run-store';
import type { RichReply } from '../src/reply';

const TODAY = '2026-10-05';
const USER_ID = 'user-1';
const MESSAGE_ID = 777;

function day(values: Partial<WellnessDay> = {}): WellnessDay {
  return { ...emptyWellnessDay(TODAY), ...values };
}

function baseline(today: number | null, status: HrvBaseline['status'] = 'ok'): HrvBaseline {
  const ok = status !== 'insufficient';
  return {
    status,
    samples: ok ? 30 : 3,
    mean: ok ? 60 : null,
    sd: ok ? 2 : null,
    today,
    low: false,
  };
}

const DEVICE = { hrv: 60, restingHr: 48, sleepHours: 7.5 };

describe('checkInReason (trigger matrix)', () => {
  it.each<[string, WellnessDay | null, HrvBaseline, ReturnType<typeof checkInReason>]>([
    ['no wellness row', null, baseline(null, 'no_today'), 'no_data'],
    ['row without device data', day({ weightKg: 70 }), baseline(null, 'no_today'), 'no_data'],
    ['HRV below mean − 1 SD', day({ ...DEVICE, hrv: 57 }), baseline(57), 'hrv_deviation'],
    ['HRV above mean + 1 SD', day({ ...DEVICE, hrv: 63 }), baseline(63), 'hrv_deviation'],
    ['HRV exactly 1 SD off', day({ ...DEVICE, hrv: 58 }), baseline(58), null],
    ['HRV within range', day(DEVICE), baseline(60), null],
    ['device data, no HRV today', day({ restingHr: 48 }), baseline(null, 'no_today'), null],
    ['too little HRV history', day({ ...DEVICE, hrv: 40 }), baseline(40, 'insufficient'), null],
  ])('%s', (_, today, hrv, expected) => {
    expect(checkInReason(today, hrv)).toBe(expected);
  });

  it('does not ask again once both answers are in', () => {
    const answered = day({ subjectiveReadiness: 3, soreness: 1 });
    expect(checkInReason(answered, baseline(null, 'no_today'))).toBeNull();
  });

  it('still asks when only one answer is in', () => {
    const partial = day({ subjectiveReadiness: 3 });
    expect(checkInReason(partial, baseline(null, 'no_today'))).toBe('no_data');
  });
});

describe('renderCheckIn', () => {
  function rows(reply: RichReply): string[][] {
    return (reply.keyboard ?? []).map((row) => row.map((b) => b.data));
  }

  it('asks both questions, one row each', () => {
    const reply = renderCheckIn({ subjectiveReadiness: null, soreness: null });
    expect(reply.html).toBe(true);
    expect(rows(reply)).toEqual([
      ['ci:r:1', 'ci:r:2', 'ci:r:3', 'ci:r:4', 'ci:r:5'],
      ['ci:s:0', 'ci:s:1', 'ci:s:2'],
    ]);
    expect(reply.keyboard?.[1].map((b) => b.text)).toEqual(['🙂 None', '😐 Mild', '😣 Severe']);
  });

  it('drops an answered row and shows the answer', () => {
    const reply = renderCheckIn({ subjectiveReadiness: 4, soreness: null });
    expect(rows(reply)).toEqual([['ci:s:0', 'ci:s:1', 'ci:s:2']]);
    expect(reply.text).toContain('Readiness: 4/5 ✓');
  });
});

/** Same semantics as the Prisma repo: creates the day, first answer per field wins. */
class MemoryCheckIns implements CheckInRepo {
  readonly days = new Map<string, CheckInAnswers>();

  recordCheckIn(
    userId: string,
    date: string,
    field: CheckInField,
    value: number
  ): Promise<CheckInAnswers> {
    const key = userId + '|' + date;
    const answers = this.days.get(key) ?? { subjectiveReadiness: null, soreness: null };
    if (field === 'r') answers.subjectiveReadiness ??= value;
    else answers.soreness ??= value;
    this.days.set(key, answers);
    return Promise.resolve({ ...answers });
  }
}

describe('handleCheckInAnswer', () => {
  let wellness: MemoryCheckIns;
  let run: CheckInRun | null;
  let resume: ReturnType<typeof vi.fn<(userId: string, date: string) => Promise<void>>>;

  function deps(): CheckInAnswerDeps {
    return {
      runs: {
        findByCheckInMessage: (userId, messageId) =>
          Promise.resolve(userId === USER_ID && messageId === MESSAGE_ID ? run : null),
      },
      wellness,
      resume,
    };
  }

  function answer(field: string, value: string, messageId = MESSAGE_ID) {
    return handleCheckInAnswer(
      USER_ID,
      { args: [field, value], telegramMessageId: messageId },
      deps()
    );
  }

  function withStatus(status: DailyBriefStatus): CheckInRun {
    return { id: 'run-1', date: TODAY, status };
  }

  beforeEach(() => {
    wellness = new MemoryCheckIns();
    run = withStatus('awaiting_checkin');
    resume = vi.fn(() => Promise.resolve());
  });

  it('stores the answer for the check-in day and edits the message to the other question', async () => {
    const reply = (await answer('r', '4')) as RichReply;

    expect(wellness.days.get(USER_ID + '|' + TODAY)).toEqual({
      subjectiveReadiness: 4,
      soreness: null,
    });
    expect(reply.editTapped).toBe(true);
    expect(reply.keyboard?.map((row) => row.map((b) => b.data))).toEqual([
      ['ci:s:0', 'ci:s:1', 'ci:s:2'],
    ]);
    expect(resume).not.toHaveBeenCalled();
  });

  it('resumes the brief once both answers are in', async () => {
    await answer('s', '1');
    const reply = (await answer('r', '2')) as RichReply;

    expect(wellness.days.get(USER_ID + '|' + TODAY)).toEqual({
      subjectiveReadiness: 2,
      soreness: 1,
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(USER_ID, TODAY);
    expect(reply).toMatchObject({ editTapped: true, keyboard: [] });
    expect(reply.text).toContain('Soreness: mild ✓');
    expect(reply.text).toContain('Your brief is on its way.');
  });

  it('keeps the first answer when a field is tapped twice', async () => {
    await answer('r', '4');
    await answer('r', '1');

    expect(wellness.days.get(USER_ID + '|' + TODAY)?.subjectiveReadiness).toBe(4);
  });

  it('stores a late answer without resuming a brief that already went out', async () => {
    run = withStatus('sent');
    const reply = (await answer('r', '3')) as RichReply;

    expect(wellness.days.get(USER_ID + '|' + TODAY)?.subjectiveReadiness).toBe(3);
    expect(resume).not.toHaveBeenCalled();
    expect(reply.text).toContain('already been sent');
    expect(reply.keyboard).toEqual([]);
  });

  it('rejects a message that is not a check-in', async () => {
    expect(await answer('r', '3', 999)).toBe(MSG_CHECKIN_NOT_FOUND);
    expect(wellness.days.size).toBe(0);
  });

  it('rejects invalid answers', async () => {
    expect(await answer('r', '9')).toBe(MSG_CHECKIN_INVALID);
    expect(await answer('x', '1')).toBe(MSG_CHECKIN_INVALID);
    expect(wellness.days.size).toBe(0);
  });
});
