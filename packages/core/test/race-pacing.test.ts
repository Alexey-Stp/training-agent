import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bikeTarget,
  buildPacingPlan,
  estimateRunThreshold,
  formatPace,
  fuelingPlan,
  raceBriefKind,
  raceChecklist,
  runTarget,
  RunEffort,
  RacePriority,
  RaceType,
} from '../src';

const TODAY = '2026-10-10';

function effort(date: string, durationMin: number, km: number | null): RunEffort {
  return { date, durationSec: durationMin * 60, distanceM: km === null ? null : km * 1000 };
}

describe('bikeTarget', () => {
  it('half-distance at FTP 300 is 234–246 W, with its source', () => {
    expect(bikeTarget(300, RaceType.half)).toEqual({
      lowW: 234,
      highW: 246,
      pctLow: 78,
      pctHigh: 82,
      source: 'from FTP 300',
    });
  });

  it.each([
    [RaceType.sprint, 264, 276],
    [RaceType.olympic, 249, 261],
    [RaceType.half, 234, 246],
    [RaceType.full, 204, 216],
  ])('%s at FTP 300 → %i–%i W', (type, low, high) => {
    const target = bikeTarget(300, type);
    expect([target?.lowW, target?.highW]).toEqual([low, high]);
  });

  it.each([RaceType.run, RaceType.other])('%s has no bike target', (type) => {
    expect(bikeTarget(300, type)).toBeNull();
  });

  it('has no target without a valid FTP', () => {
    expect(bikeTarget(0, RaceType.half)).toBeNull();
  });

  it('keeps the band ordered and inside the % band for any FTP', () => {
    fc.assert(
      fc.property(fc.integer({ min: 50, max: 500 }), (ftp) => {
        const target = bikeTarget(ftp, RaceType.half);
        expect(target).not.toBeNull();
        expect(target!.lowW).toBeLessThanOrEqual(target!.highW);
        expect(target!.lowW).toBeGreaterThanOrEqual(Math.floor(ftp * 0.78));
        expect(target!.highW).toBeLessThanOrEqual(Math.ceil(ftp * 0.82));
      })
    );
  });
});

describe('estimateRunThreshold', () => {
  it('returns null without any data (no invented pace)', () => {
    expect(estimateRunThreshold([], TODAY)).toBeNull();
  });

  it('takes the fastest qualifying 20–60 min run', () => {
    const result = estimateRunThreshold(
      [effort('2026-10-01', 30, 6), effort('2026-09-20', 50, 10.5), effort('2026-09-25', 40, 7)],
      TODAY
    );
    // 50 min / 10.5 km = 285.7 s/km
    expect(result?.paceSecPerKm).toBe(286);
    expect(result?.basedOn).toContain('2026-09-20');
  });

  it('ignores too short, too long, stale, future and distance-less runs', () => {
    const result = estimateRunThreshold(
      [
        effort('2026-10-01', 15, 4), // too short
        effort('2026-10-01', 90, 18), // too long
        effort('2026-04-01', 40, 9), // stale
        effort('2026-10-20', 40, 9), // future
        effort('2026-10-02', 40, null), // no distance
      ],
      TODAY
    );
    expect(result).toBeNull();
  });
});

describe('runTarget', () => {
  it('is null without threshold data', () => {
    expect(runTarget(null, RaceType.half)).toBeNull();
  });

  it('applies the race-type factor and a ±2% band', () => {
    const threshold = { paceSecPerKm: 300, basedOn: 'best run' };
    const target = runTarget(threshold, RaceType.half);
    expect(target).toEqual({ lowSecPerKm: 323, highSecPerKm: 337, source: 'from best run' });
  });

  it('has no target for an unknown race type', () => {
    expect(runTarget({ paceSecPerKm: 300, basedOn: 'x' }, RaceType.other)).toBeNull();
  });
});

describe('buildPacingPlan', () => {
  it('leaves run null when there is no recent run data', () => {
    const plan = buildPacingPlan({
      raceType: RaceType.half,
      ftp: 300,
      runEfforts: [],
      today: TODAY,
    });
    expect(plan.run).toBeNull();
    expect(plan.bike?.source).toBe('from FTP 300');
    expect(plan.fueling).toEqual({ carbsLowGPerH: 60, carbsHighGPerH: 80 });
  });

  it('fills the run target from recent efforts', () => {
    const plan = buildPacingPlan({
      raceType: RaceType.olympic,
      ftp: 280,
      runEfforts: [effort('2026-10-01', 40, 8)],
      today: TODAY,
    });
    expect(plan.run).not.toBeNull();
  });
});

describe('fuelingPlan', () => {
  it('has no default for other races', () => {
    expect(fuelingPlan(RaceType.other)).toBeNull();
  });
});

describe('formatPace', () => {
  it('formats m:ss/km', () => {
    expect(formatPace(312)).toBe('5:12/km');
    expect(formatPace(305)).toBe('5:05/km');
  });
});

describe('raceBriefKind', () => {
  const race = (priority: RacePriority) => ({ date: '2026-10-17', priority });

  it.each([
    [RacePriority.A, '2026-10-10', 't7'],
    [RacePriority.A, '2026-10-16', 't1'],
    [RacePriority.B, '2026-10-10', null],
    [RacePriority.B, '2026-10-16', 't1'],
    [RacePriority.C, '2026-10-10', null],
    [RacePriority.C, '2026-10-16', 't1'],
    [RacePriority.A, '2026-10-12', null],
    [RacePriority.A, '2026-10-17', null],
  ])('priority %s on %s → %s', (priority, today, expected) => {
    expect(raceBriefKind(race(priority), today)).toBe(expected);
  });
});

describe('raceChecklist', () => {
  const titles = (type: RaceType) => raceChecklist(type).map((s) => s.title);
  const gear = (type: RaceType) => raceChecklist(type)[0].items.join(' | ');

  it('always has gear, nutrition and admin sections', () => {
    for (const type of Object.values(RaceType)) {
      expect(titles(type)).toEqual(['Gear', 'Nutrition', 'Admin']);
    }
  });

  it('a triathlon lists swim, bike and run gear', () => {
    expect(gear(RaceType.half)).toMatch(/goggles/);
    expect(gear(RaceType.half)).toMatch(/Helmet/);
    expect(gear(RaceType.half)).toMatch(/Run shoes/);
  });

  it('a running race has no swim or bike gear', () => {
    expect(gear(RaceType.run)).not.toMatch(/goggles|Helmet/);
  });

  it('a full distance adds special-needs bags', () => {
    expect(gear(RaceType.full)).toMatch(/special-needs/);
    expect(gear(RaceType.sprint)).not.toMatch(/special-needs/);
  });
});
