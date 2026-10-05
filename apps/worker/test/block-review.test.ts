import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockReviewData,
  RacePriority,
  RaceType,
  SeasonPlanStatus,
  TrainingBlockType,
  WEEKLY_STATS_VERSION,
  type DateRange,
  type TrainingBlock,
  type WeeklyStats,
} from '@triathlon/core';
import {
  LlmServerError,
  MockProvider,
  type BlockReview,
  type CoachDecisionRecord,
  type CoachDecisionSink,
} from '@triathlon/ai';
import type { StageTimings } from '../src/daily-loop/run-store';
import type { BriefProfile } from '../src/daily-loop/scheduler';
import type { RaceRecord } from '../src/race-command';
import {
  runBlockReviewJob,
  type BlockReviewDeps,
  type BlockReviewJob,
} from '../src/reviews/block-review';
import type {
  ActiveSeasonRecord,
  BlockReviewClaimResult,
  BlockReviewRun,
  BlockReviewRunRepo,
  ClaimKey,
  SavedBlockReport,
} from '../src/reviews/block-review-store';
import type { WeeklyStatsData } from '../src/reviews/weekly-stats-store';

const USER_ID = 'user-1';
const CHAT_ID = 1001;
const PRAGUE: BriefProfile = {
  telegramChatId: CHAT_ID,
  timezone: 'Europe/Prague',
  briefTime: null,
  closeoutTime: null,
};
// Sunday 2026-10-04 19:30 in Prague: the last day of block 2 (build)
const BLOCK_END = new Date('2026-10-04T17:30:00Z');

function block(
  order: number,
  type: TrainingBlockType,
  startDate: string,
  weeks: number,
  hours: number
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus: type,
    targetWeeklyHours: hours,
    targetSwimM: 5000,
    targetBikeH: Math.round(hours * 5.5) / 10,
    targetRunKm: hours * 3,
    targetCtl: null,
  };
}

const BLOCKS: TrainingBlock[] = [
  block(1, TrainingBlockType.base, '2026-08-17', 4, 8),
  block(2, TrainingBlockType.build, '2026-09-14', 3, 10),
  block(3, TrainingBlockType.peak, '2026-10-05', 3, 10.8),
  block(4, TrainingBlockType.taper, '2026-10-26', 2, 6.4),
  block(5, TrainingBlockType.race, '2026-11-09', 1, 4.6),
];

const A_RACE: RaceRecord = {
  id: 'race1',
  date: '2026-11-15',
  name: 'Challenge Prague',
  priority: RacePriority.A,
  type: RaceType.half,
};

const SEASON_VERSION = new Date('2026-08-10T08:00:00Z');

function record(aRace: RaceRecord = A_RACE): ActiveSeasonRecord {
  return {
    id: 'season1',
    updatedAt: SEASON_VERSION,
    weeklyHoursAvailable: 12,
    weakSport: null,
    season: {
      startDate: BLOCKS[0].startDate,
      status: SeasonPlanStatus.active,
      aRace,
      blocks: structuredClone(BLOCKS),
    },
  };
}

/** Stored stats of one week: `actualMin` of 600 planned, CTL rising by 1 */
function week(isoWeek: string, actualMin: number, ctl: number): WeeklyStats {
  const total = {
    plannedMin: 600,
    actualMin,
    compliancePct: Math.round((actualMin / 600) * 1000) / 10,
    plannedDistanceKm: null,
    actualDistanceKm: 0,
    plannedTss: null,
    actualTss: 0,
    plannedSessions: 6,
    activities: 6,
  };
  return {
    version: WEEKLY_STATS_VERSION,
    isoWeek,
    from: '',
    to: '',
    unplannedWeek: false,
    bySport: [],
    total,
    keySessions: { hit: [], missed: [], pending: [] },
    intensity: { easyMin: 0, hardMin: 0, unknownMin: 0, easyPct: null, hardPct: null },
    load: {
      start: { date: '', ctl, atl: null, tsb: null },
      end: { date: '', ctl: ctl + 1, atl: null, tsb: null },
      ctlDelta: 1,
      atlDelta: null,
      tsbDelta: null,
    },
    wellness: {
      daysWithData: 0,
      avgHrv: null,
      avgRestingHr: null,
      avgSleepHours: null,
      avgReadiness: null,
      avgSoreness: null,
      prevAvgHrv: null,
      hrvDeltaPct: null,
    },
  };
}

/** The build block at 70% of its 10 h/week (420 of 600 min each week) */
const UNDER = [week('2026-W38', 480, 50), week('2026-W39', 420, 51), week('2026-W40', 360, 52)];
const COMPLIANT = [week('2026-W38', 600, 50), week('2026-W39', 590, 51), week('2026-W40', 610, 52)];

/** The run, the stored report's extra fields once saved, and its key */
type RunRow = BlockReviewRun &
  Partial<Omit<SavedBlockReport, keyof BlockReviewRun | 'reportKeyboard'>> &
  ClaimKey;

class MemoryRuns implements BlockReviewRunRepo {
  readonly rows = new Map<string, RunRow>();
  private startedAt = new Map<string, Date>();

  claim(key: ClaimKey, now: Date, leaseMs: number): Promise<BlockReviewClaimResult> {
    const id = 'run' + (this.rows.size + 1).toString();
    const mapKey = key.seasonPlanId + '|' + key.key;
    const row: RunRow = this.rows.get(mapKey) ?? {
      ...key,
      id,
      status: 'pending' as const,
      coachDecisionId: null,
      reportText: null,
      reportKeyboard: null,
      stageTimings: {},
    };
    this.rows.set(mapKey, row);
    const started = this.startedAt.get(mapKey)?.getTime() ?? 0;
    const leaseExpired = row.status === 'running' && started < now.getTime() - leaseMs;
    if (row.status === 'pending' || row.status === 'failed' || leaseExpired) {
      row.status = 'running';
      this.startedAt.set(mapKey, now);
      return Promise.resolve({ status: 'claimed', run: structuredClone(row) });
    }
    return Promise.resolve({ status: row.status === 'running' ? 'in_progress' : 'already_sent' });
  }

  byId(id: string) {
    const row = [...this.rows.values()].find((r) => r.id === id);
    if (!row) throw new Error('no run ' + id);
    return row;
  }

  only() {
    const [row] = [...this.rows.values()];
    return row;
  }

  saveReport(id: string, report: SavedBlockReport): Promise<void> {
    Object.assign(this.byId(id), report);
    return Promise.resolve();
  }

  markSent(id: string, _sentAt: Date, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { status: 'sent', stageTimings });
    return Promise.resolve();
  }

  markFailed(id: string, _error: string, stageTimings: StageTimings): Promise<void> {
    Object.assign(this.byId(id), { status: 'failed', stageTimings });
    return Promise.resolve();
  }

  findAnswerable(): Promise<null> {
    return Promise.resolve(null);
  }
}

class MemoryStats {
  rows: WeeklyStats[] = UNDER;
  readonly ranges: DateRange[] = [];
  readonly upserted: string[] = [];

  loadRange(): Promise<WeeklyStatsData> {
    return Promise.resolve({ sessions: [], activities: [], wellness: [], lthr: null });
  }

  upsert(_userId: string, stats: WeeklyStats): Promise<void> {
    this.upserted.push(stats.isoWeek);
    return Promise.resolve();
  }

  listRange(_userId: string, range: DateRange): Promise<WeeklyStats[]> {
    this.ranges.push(range);
    return Promise.resolve(structuredClone(this.rows));
  }
}

class MemoryDecisions implements CoachDecisionSink {
  readonly records: CoachDecisionRecord[] = [];

  write(record: CoachDecisionRecord): Promise<string> {
    this.records.push(record);
    return Promise.resolve('dec' + this.records.length.toString());
  }
}

function llm(...replies: (string | Error)[]): MockProvider {
  const queue = [...replies];
  return new MockProvider({
    respond: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('No scripted reply left');
      if (next instanceof Error) throw next;
      return next;
    },
  });
}

function review(overrides: Partial<BlockReview> = {}): string {
  return JSON.stringify({
    summary: 'You managed 70% of the build volume (7.0 of 10.0 h/week).',
    wins: ['CTL up 3.0'],
    concerns: ['Compliance fell to 60% in the last week'],
    recommendation: 'reproject',
    reason: 'Start the peak from what you actually handled.',
    ...overrides,
  } satisfies BlockReview);
}

let runs: MemoryRuns;
let stats: MemoryStats;
let decisions: MemoryDecisions;
let season: ActiveSeasonRecord;
let sendMessage: ReturnType<typeof vi.fn>;
let syncActivities: ReturnType<typeof vi.fn<BlockReviewDeps['syncActivities']>>;
type ApplyReprojection = BlockReviewDeps['seasons']['applyReprojection'];
let applyReprojection: ReturnType<typeof vi.fn<ApplyReprojection>>;

function deps(
  provider: MockProvider,
  now: Date = BLOCK_END,
  overrides: Partial<BlockReviewDeps> = {}
): BlockReviewDeps {
  return {
    runs,
    profiles: { findBriefProfile: (id) => Promise.resolve(id === USER_ID ? PRAGUE : null) },
    stats,
    seasons: {
      findActiveRecord: () => Promise.resolve(structuredClone(season)),
      applyReprojection,
    },
    syncActivities,
    loadTrainingHours: () => Promise.resolve(32),
    provider,
    decisions,
    config: { thresholdPct: 15 },
    sendMessage: sendMessage as BlockReviewDeps['sendMessage'],
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => now,
    ...overrides,
  };
}

const BLOCK_END_JOB: BlockReviewJob = { userId: USER_ID };

function sentText(call = 0): string {
  return sendMessage.mock.calls[call][1] as string;
}

function sentKeyboard(): { text: string; callback_data: string }[][] {
  const options = sendMessage.mock.calls[0][2] as {
    reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  };
  return options.reply_markup?.inline_keyboard ?? [];
}

beforeEach(() => {
  runs = new MemoryRuns();
  stats = new MemoryStats();
  decisions = new MemoryDecisions();
  season = record();
  sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  syncActivities = vi.fn<BlockReviewDeps['syncActivities']>().mockResolvedValue(undefined);
  applyReprojection = vi.fn<ApplyReprojection>();
});

describe('runBlockReviewJob: block ended at 70% volume', () => {
  it('re-projects the remaining blocks from the achieved load', async () => {
    const result = await runBlockReviewJob(BLOCK_END_JOB, deps(llm(review())));

    expect(result).toMatchObject({ status: 'sent', key: 'block:2', reproject: true });
    const run = runs.only();
    const proposal = run.proposal;
    expect(proposal).toMatchObject({ raceDate: '2026-11-15', frozenCount: 2, truncated: null });
    // 70% of the peak's planned 10.8 h/week
    expect(proposal?.blocks[2].targetWeeklyHours).toBeLessThan(BLOCKS[2].targetWeeklyHours * 0.8);
    expect(proposal?.blocks.map((b) => b.type)).toEqual(BLOCKS.map((b) => b.type));
    expect(run).toMatchObject({ freezeThrough: '2026-10-04', seasonUpdatedAt: SEASON_VERSION });
    expect(run.verdict).toMatchObject({ volumeAchievedPct: 70, complianceTrend: 'declining' });
  });

  it('never touches the past: the reviewed and earlier blocks stay as they are', async () => {
    await runBlockReviewJob(BLOCK_END_JOB, deps(llm(review())));

    const blocks = runs.only().proposal?.blocks ?? [];
    expect(blocks.slice(0, 2)).toEqual(BLOCKS.slice(0, 2));
    expect(blocks.slice(2).every((b) => b.startDate > '2026-10-04')).toBe(true);
    expect(applyReprojection).not.toHaveBeenCalled();
  });

  it('shows the old-vs-new block table with Confirm/Decline', async () => {
    await runBlockReviewJob(BLOCK_END_JOB, deps(llm(review())));

    const text = sentText();
    expect(text).toContain('🧱 <b>Block 2 (build) review</b> · 14.09 → 04.10');
    expect(text).toContain('📦 Volume 70% of target (7.0/10.0 h/wk)');
    expect(text).toContain('📈 CTL 50.0 → 53.0 (+3.0)');
    expect(text).toContain('📊 Compliance declining: 80% · 70% · 60%');
    expect(text).toContain('Before:');
    expect(text).toContain('After:');
    expect(text).toMatchSnapshot();
    const runId = runs.only().id;
    expect(sentKeyboard()).toEqual([
      [
        { text: '✅ Confirm re-projection', callback_data: blockReviewData('confirm', runId) },
        { text: '✖ Decline', callback_data: blockReviewData('decline', runId) },
      ],
    ]);
  });

  it('records one block decision and reads the block weeks from WeeklyStats', async () => {
    await runBlockReviewJob(BLOCK_END_JOB, deps(llm(review())));

    expect(decisions.records).toHaveLength(1);
    expect(decisions.records[0]).toMatchObject({ origin: 'block', finalAction: 'adjust' });
    expect(stats.upserted).toEqual(['2026-W40']);
    expect(stats.ranges).toEqual([{ from: '2026-09-14', to: '2026-09-28' }]);
  });

  it('proposes the re-projection even when the coach says keep', async () => {
    await runBlockReviewJob(BLOCK_END_JOB, deps(llm(review({ recommendation: 'keep' }))));

    expect(sentKeyboard()).toHaveLength(1);
    expect(sentText()).toContain('proposed anyway');
  });

  it('LLM down: proposes it from the threshold alone', async () => {
    const result = await runBlockReviewJob(BLOCK_END_JOB, deps(llm(new LlmServerError(503))));

    expect(result).toMatchObject({ status: 'sent', reproject: true });
    expect(sentText()).toContain('Block 2 (build): 70% of the target volume');
  });
});

describe('runBlockReviewJob: compliant block', () => {
  it('keeps the season without buttons when the coach says keep', async () => {
    stats.rows = COMPLIANT;

    const result = await runBlockReviewJob(
      BLOCK_END_JOB,
      deps(llm(review({ summary: 'Spot on.', recommendation: 'keep' })))
    );

    expect(result).toMatchObject({ status: 'sent', reproject: false });
    expect(runs.only().proposal).toBeNull();
    expect(sentText()).toContain('Season unchanged.');
    expect(sentKeyboard()).toEqual([]);
  });
});

describe('runBlockReviewJob: triggers', () => {
  it('skips a Sunday that ends no block', async () => {
    const result = await runBlockReviewJob(
      BLOCK_END_JOB,
      deps(llm(), new Date('2026-09-27T17:30:00Z'))
    );
    expect(result).toEqual({ status: 'skipped', reason: 'not_block_end' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips the end of the taper: only race week is left', async () => {
    const result = await runBlockReviewJob(
      BLOCK_END_JOB,
      deps(llm(), new Date('2026-11-08T18:30:00Z'))
    );
    expect(result).toEqual({ status: 'skipped', reason: 'no_remaining_blocks' });
  });

  it('skips an athlete without an active season', async () => {
    const result = await runBlockReviewJob(
      BLOCK_END_JOB,
      deps(llm(), BLOCK_END, {
        seasons: {
          findActiveRecord: () => Promise.resolve(null),
          applyReprojection: vi.fn<ApplyReprojection>(),
        },
      })
    );
    expect(result).toEqual({ status: 'skipped', reason: 'no_season' });
  });

  describe('A-race moved', () => {
    // Wednesday of the build's second week
    const MID_BUILD = new Date('2026-09-23T10:00:00Z');
    const MOVED: RaceRecord = { ...A_RACE, date: '2026-11-29' };
    const MOVE_JOB: BlockReviewJob = {
      userId: USER_ID,
      trigger: 'race_move',
      raceId: 'race1',
      previousDate: '2026-11-15',
      newDate: '2026-11-29',
    };

    it('offers a re-projection to the new date, freezing through this Sunday', async () => {
      season = record(MOVED);

      const result = await runBlockReviewJob(
        MOVE_JOB,
        deps(llm(review({ recommendation: 'keep' })), MID_BUILD)
      );

      expect(result).toMatchObject({ status: 'sent', key: 'race:race1:2026-11-29' });
      const run = runs.only();
      expect(run.trigger).toBe('race_move');
      expect(run.freezeThrough).toBe('2026-09-27');
      expect(run.proposal?.truncated).toEqual({ order: 2, weeks: 2 });
      expect(run.proposal?.raceDate).toBe('2026-11-29');
      expect(run.proposal?.blocks[0]).toEqual(BLOCKS[0]);
      expect(run.proposal?.blocks.at(-1)?.startDate).toBe('2026-11-23');
      expect(sentText()).toContain('🧱 <b>A-race moved</b> · Challenge Prague 15.11 → 29.11');
      expect(sentKeyboard()).toHaveLength(1);
    });

    it('skips a job for a race that is no longer the A-race at that date', async () => {
      season = record(A_RACE);
      const result = await runBlockReviewJob(MOVE_JOB, deps(llm(), MID_BUILD));
      expect(result).toEqual({ status: 'skipped', reason: 'race_changed' });
    });

    it('keeps the season when the new date leaves no room for a taper', async () => {
      season = record({ ...A_RACE, date: '2026-09-30' });
      const tooSoon = { ...MOVE_JOB, newDate: '2026-09-30' };

      const result = await runBlockReviewJob(tooSoon, deps(llm(review()), MID_BUILD));

      expect(result).toMatchObject({ status: 'sent', reproject: false });
      expect(sentText()).toContain('No re-projection fits the remaining weeks');
    });
  });
});

describe('runBlockReviewJob: idempotency', () => {
  it('resends the stored report on a retry after a failed send, with one decision', async () => {
    sendMessage.mockRejectedValueOnce(new Error('network down'));
    await expect(runBlockReviewJob(BLOCK_END_JOB, deps(llm(review())))).rejects.toThrow(
      'network down'
    );
    expect(runs.only().status).toBe('failed');

    const provider = llm();
    const result = await runBlockReviewJob(BLOCK_END_JOB, deps(provider));

    expect(result).toMatchObject({ status: 'sent', resumed: true, reproject: true });
    expect(decisions.records).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
    expect(sentText(1)).toBe(sentText(0));
  });

  it('does nothing the second time for the same block', async () => {
    await runBlockReviewJob(BLOCK_END_JOB, deps(llm(review())));
    const again = await runBlockReviewJob(BLOCK_END_JOB, deps(llm()));

    expect(again).toEqual({ status: 'skipped', reason: 'already_sent' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
