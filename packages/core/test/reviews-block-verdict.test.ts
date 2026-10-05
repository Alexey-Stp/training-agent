import { describe, it, expect } from 'vitest';
import {
  blockIsoWeeks,
  complianceTrend,
  computeBlockVerdict,
  reprojectionSeed,
  WEEKLY_STATS_VERSION,
  WeeklyStats,
} from '../src/reviews';
import { TrainingBlock, TrainingBlockType } from '../src/season';

const BLOCK: TrainingBlock = {
  order: 2,
  type: TrainingBlockType.build,
  startDate: '2026-09-14', // Monday, 2026-W38
  weeks: 3,
  focus: 'Race-specific endurance and threshold',
  targetWeeklyHours: 10,
  targetSwimM: 5000,
  targetBikeH: 5.5,
  targetRunKm: 30,
  targetCtl: null,
};

function stats(
  isoWeek: string,
  actualMin: number,
  plannedMin: number,
  ctl: { start: number; end: number } | null = null
): WeeklyStats {
  const volume = {
    plannedMin,
    actualMin,
    compliancePct: plannedMin > 0 ? Math.round((actualMin / plannedMin) * 1000) / 10 : null,
    plannedDistanceKm: null,
    actualDistanceKm: 0,
    plannedTss: null,
    actualTss: 0,
    plannedSessions: 5,
    activities: 5,
  };
  return {
    version: WEEKLY_STATS_VERSION,
    isoWeek,
    from: '',
    to: '',
    unplannedWeek: plannedMin === 0,
    bySport: [],
    total: volume,
    keySessions: { hit: [], missed: [], pending: [] },
    intensity: { easyMin: 0, hardMin: 0, unknownMin: 0, easyPct: null, hardPct: null },
    load: {
      start: ctl ? { date: '', ctl: ctl.start, atl: null, tsb: null } : null,
      end: ctl ? { date: '', ctl: ctl.end, atl: null, tsb: null } : null,
      ctlDelta: null,
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

describe('computeBlockVerdict', () => {
  it('lists the ISO weeks of the block', () => {
    expect(blockIsoWeeks(BLOCK)).toEqual(['2026-W38', '2026-W39', '2026-W40']);
  });

  it('reports 70% volume, the CTL delta and a declining trend', () => {
    const verdict = computeBlockVerdict(BLOCK, [
      stats('2026-W40', 300, 600, { start: 52, end: 53 }),
      stats('2026-W38', 480, 600, { start: 50, end: 51 }),
      stats('2026-W39', 480, 600, { start: 51, end: 52 }),
    ]);
    expect(verdict.volumeAchievedPct).toBe(70);
    expect(verdict.achievedWeeklyHours).toBe(7);
    expect(verdict.ctlStart).toBe(50);
    expect(verdict.ctlEnd).toBe(53);
    expect(verdict.ctlDelta).toBe(3);
    expect(verdict.ctlGap).toBeNull();
    expect(verdict.weekly.map((w) => w.compliancePct)).toEqual([80, 80, 50]);
    expect(verdict.complianceTrend).toBe('declining');
    expect(verdict.missingWeeks).toEqual([]);
    expect(verdict.to).toBe('2026-10-04');
  });

  it('compares the CTL end with targetCtl when set', () => {
    const verdict = computeBlockVerdict({ ...BLOCK, targetCtl: 60 }, [
      stats('2026-W38', 600, 600, { start: 50, end: 55 }),
    ]);
    expect(verdict.ctlGap).toBe(-5);
  });

  it('leaves weeks without stats out of the volume and lists them', () => {
    const verdict = computeBlockVerdict(BLOCK, [stats('2026-W39', 600, 600)]);
    expect(verdict.volumeAchievedPct).toBe(100);
    expect(verdict.missingWeeks).toEqual(['2026-W38', '2026-W40']);
    expect(verdict.complianceTrend).toBe('unknown');
    expect(verdict.ctlDelta).toBeNull();
  });

  it('has no volume verdict without any stats', () => {
    const verdict = computeBlockVerdict(BLOCK, []);
    expect(verdict.volumeAchievedPct).toBeNull();
    expect(verdict.achievedWeeklyHours).toBeNull();
  });
});

describe('complianceTrend', () => {
  it('treats small changes as flat', () => {
    expect(complianceTrend([90, 92, 93])).toBe('flat');
    expect(complianceTrend([70, 85, 95])).toBe('improving');
  });
});

describe('reprojectionSeed', () => {
  const verdict = { volumeAchievedPct: 70, achievedWeeklyHours: 7, targetWeeklyHours: 10 };

  it('scales the next block by the share achieved', () => {
    expect(reprojectionSeed(verdict, { targetWeeklyHours: 11 })).toBe(7.7);
  });

  it('caps over-achievement at one ramp step', () => {
    expect(
      reprojectionSeed({ ...verdict, volumeAchievedPct: 130 }, { targetWeeklyHours: 10 })
    ).toBe(10.8);
  });

  it('falls back to the achieved hours without a volume verdict', () => {
    expect(reprojectionSeed({ ...verdict, volumeAchievedPct: null }, undefined)).toBe(7);
  });
});
