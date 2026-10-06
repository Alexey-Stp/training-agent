import { describe, it, expect } from 'vitest';
import {
  bikeTarget,
  computeRaceMetrics,
  normalizedPower,
  pickRaceActivity,
  RaceStreams,
  RaceType,
  runTarget,
} from '../src';

const SEC = 1800; // 30 minutes of 1 Hz data
const time = Array.from({ length: SEC }, (_, i) => i);
const flat = (value: number, n = SEC) => Array.from({ length: n }, () => value);
const half = (a: number, b: number) => [...flat(a, SEC / 2), ...flat(b, SEC / 2)];

const BIKE = bikeTarget(300, RaceType.half); // 234–246 W
const RUN = runTarget({ paceSecPerKm: 300, basedOn: 'test' }, RaceType.half); // 330 ±2%
const AVERAGES = { durationSec: SEC, distanceM: 10000, avgHr: 150, avgPower: 240 };

function input(streams: RaceStreams | null, sport: 'bike' | 'run' | 'other' = 'bike') {
  return {
    raceType: RaceType.half,
    activitySport: sport,
    averages: AVERAGES,
    streams,
    targets: { bike: BIKE, run: RUN },
  };
}

describe('normalizedPower', () => {
  it('equals the power of a steady effort', () => {
    expect(normalizedPower(time, flat(200))).toBeCloseTo(200, 6);
  });

  it('is above the average for a variable effort', () => {
    const watts = Array.from({ length: SEC }, (_, i) => (Math.floor(i / 60) % 2 === 0 ? 100 : 300));
    const np = normalizedPower(time, watts) ?? 0;
    expect(np).toBeGreaterThan(200);
    expect(np).toBeLessThan(300);
  });

  it('is null for a stream shorter than the window', () => {
    expect(normalizedPower([0, 1, 2], [100, 100, 100])).toBeNull();
  });
});

describe('computeRaceMetrics, power tier', () => {
  it('compares NP with the T-1 band and names a positive split when power fades', () => {
    const m = computeRaceMetrics(input({ timeSec: time, watts: half(255, 225) }));
    expect(m.tier).toBe('power');
    expect(m.split).toBe('positive');
    expect(m.power?.firstHalfPower).toBe(255);
    expect(m.power?.secondHalfPower).toBe(225);
    expect(m.power?.powerFadePct).toBeCloseTo(11.8, 1);
    expect(m.power?.vsTarget).toMatchObject({ basis: 'np', lowW: 234, highW: 246 });
    expect(m.power?.vsTarget?.status).toBe('within');
  });

  it('names a negative split and flags NP above the band', () => {
    const m = computeRaceMetrics(input({ timeSec: time, watts: half(250, 270) }));
    expect(m.split).toBe('negative');
    expect(m.power?.vsTarget?.status).toBe('above');
  });

  it('calls a flat effort even and below band when too easy', () => {
    const m = computeRaceMetrics(input({ timeSec: time, watts: flat(200) }));
    expect(m.split).toBe('even');
    expect(m.power?.normalizedPower).toBe(200);
    expect(m.power?.vsTarget?.status).toBe('below');
  });

  it('measures HR drift as lost power per heartbeat', () => {
    const m = computeRaceMetrics(
      input({ timeSec: time, watts: flat(240), heartrate: half(140, 154) })
    );
    expect(m.hrDriftBasis).toBe('power');
    expect(m.hrDriftPct).toBeCloseTo(9.1, 1);
    expect(m.avgHr).toBe(147);
  });
});

describe('computeRaceMetrics, hr tier and none tier', () => {
  it('uses speed and HR on a run without power', () => {
    const base = input(
      { timeSec: time, velocity: half(3.2, 2.8), heartrate: half(150, 160) },
      'run'
    );
    const m = computeRaceMetrics({ ...base, averages: { ...AVERAGES, avgPower: null } });
    expect(m.tier).toBe('hr');
    expect(m.power).toBeNull();
    expect(m.split).toBe('positive');
    expect(m.pace?.firstHalfPaceSecPerKm).toBe(313);
    expect(m.pace?.secondHalfPaceSecPerKm).toBe(357);
    expect(m.hrDriftBasis).toBe('speed');
  });

  it('falls back to the raw HR rise with heart rate only', () => {
    const m = computeRaceMetrics(input({ timeSec: time, heartrate: half(150, 159) }));
    expect(m.tier).toBe('hr');
    expect(m.hrDriftBasis).toBe('hr');
    expect(m.hrDriftPct).toBeCloseTo(6, 1);
    expect(m.split).toBeNull();
  });

  it('uses only the stored averages without streams', () => {
    const m = computeRaceMetrics(input(null));
    expect(m.tier).toBe('none');
    expect(m.split).toBeNull();
    expect(m.hrDriftPct).toBeNull();
    expect(m.power).toMatchObject({ avgPower: 240, normalizedPower: null });
    expect(m.power?.vsTarget).toMatchObject({ basis: 'avg', status: 'within' });
    expect(m.avgHr).toBe(150);
  });

  it('compares a run average pace with the run band', () => {
    const m = computeRaceMetrics(input(null, 'run'));
    expect(m.pace?.avgPaceSecPerKm).toBe(180);
    expect(m.pace?.vsTarget?.status).toBe('below');
    expect(m.power?.vsTarget).toBeNull();
  });

  it('skips targets for a multisport activity', () => {
    const m = computeRaceMetrics(input(null, 'other'));
    expect(m.power?.vsTarget).toBeNull();
    expect(m.pace?.vsTarget).toBeNull();
  });

  it('treats unusable streams as none', () => {
    const m = computeRaceMetrics(input({ timeSec: time, watts: flat(0), heartrate: [] }));
    expect(m.tier).toBe('none');
  });
});

describe('pickRaceActivity', () => {
  const act = (icuId: string, startDateLocal: string, durationSec: number) => ({
    icuId,
    startDateLocal,
    durationSec,
  });

  it('takes the longest activity of the race day', () => {
    const picked = pickRaceActivity(
      [act('a', '2026-10-11', 600), act('b', '2026-10-11', 9000), act('c', '2026-10-10', 20000)],
      '2026-10-11'
    );
    expect(picked?.icuId).toBe('b');
  });

  it('is null when nothing happened that day', () => {
    expect(pickRaceActivity([act('a', '2026-10-10', 600)], '2026-10-11')).toBeNull();
  });

  it('breaks a tie by id', () => {
    const picked = pickRaceActivity(
      [act('z', '2026-10-11', 100), act('m', '2026-10-11', 100)],
      '2026-10-11'
    );
    expect(picked?.icuId).toBe('m');
  });
});
