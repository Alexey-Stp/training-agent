import { describe, it, expect } from 'vitest';
import {
  closeoutNotices,
  deviationPct,
  guessIntensity,
  isKeySession,
  matchActivities,
  type CloseoutActivity,
  type CloseoutSession,
} from '../src/closeout';
import { Intensity, Sport } from '../src/types';

function session(
  id: string,
  sport: Sport,
  durationMin: number,
  extra: Partial<CloseoutSession> = {}
): CloseoutSession {
  return {
    id,
    slot: sport + '-1',
    sport,
    title: id,
    durationMin,
    intensity: Intensity.z2,
    deleted: false,
    ...extra,
  };
}

function activity(
  id: string,
  sport: Sport,
  durationMin: number,
  extra: Partial<CloseoutActivity> = {}
): CloseoutActivity {
  return {
    id,
    icuId: 'i' + id,
    sport,
    name: id,
    startTime: new Date('2026-10-05T07:00:00Z'),
    durationSec: durationMin * 60,
    avgHr: null,
    avgPower: null,
    ...extra,
  };
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);
const pairs = (result: ReturnType<typeof matchActivities>) =>
  result.matches.map((m) => [m.session.id, m.activity.id]);

describe('matchActivities', () => {
  it('matches an exact same-sport activity', () => {
    const result = matchActivities(
      [session('s1', Sport.bike, 60)],
      [activity('a1', Sport.bike, 60)]
    );
    expect(pairs(result)).toEqual([['s1', 'a1']]);
    expect(result.skipped).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it('takes the candidate with the closest duration', () => {
    const result = matchActivities(
      [session('s1', Sport.run, 50)],
      [activity('short', Sport.run, 20), activity('close', Sport.run, 48)]
    );
    expect(pairs(result)).toEqual([['s1', 'close']]);
    expect(ids(result.unmatched)).toEqual(['short']);
  });

  it('keeps two sessions of one sport one-to-one by minimal gap', () => {
    const result = matchActivities(
      [
        session('easy', Sport.run, 40, { slot: 'run-1' }),
        session('long', Sport.run, 90, { slot: 'run-2' }),
      ],
      [activity('a90', Sport.run, 85), activity('a40', Sport.run, 42)]
    );
    expect(pairs(result).sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['easy', 'a40'],
      ['long', 'a90'],
    ]);
  });

  it('breaks equal gaps by slot, then start time, regardless of input order', () => {
    const early = activity('early', Sport.swim, 30, {
      startTime: new Date('2026-10-05T06:00:00Z'),
    });
    const late = activity('late', Sport.swim, 30, { startTime: new Date('2026-10-05T18:00:00Z') });
    const s = session('s1', Sport.swim, 30);
    expect(pairs(matchActivities([s], [late, early]))).toEqual([['s1', 'early']]);
    expect(pairs(matchActivities([s], [early, late]))).toEqual([['s1', 'early']]);
  });

  it('skips every session when there are no activities', () => {
    const result = matchActivities([session('s1', Sport.bike, 60)], []);
    expect(result.matches).toEqual([]);
    expect(ids(result.skipped)).toEqual(['s1']);
  });

  it('never matches across sports', () => {
    const result = matchActivities(
      [session('ride', Sport.bike, 60)],
      [activity('run', Sport.run, 60)]
    );
    expect(result.matches).toEqual([]);
    expect(ids(result.skipped)).toEqual(['ride']);
    expect(ids(result.unmatched)).toEqual(['run']);
  });

  it('ignores rest days and tombstoned sessions', () => {
    const result = matchActivities(
      [session('rest', Sport.rest, 0), session('gone', Sport.run, 45, { deleted: true })],
      [activity('a1', Sport.run, 45)]
    );
    expect(result.matches).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(ids(result.unmatched)).toEqual(['a1']);
  });
});

describe('deviationPct', () => {
  it.each([
    [60, 60 * 60, 0],
    [60, 90 * 60, 50],
    [60, 30 * 60, -50],
    [90, 100 * 60, 11.1],
    [45, 30 * 60, -33.3],
  ])('planned %i min, actual %i s → %d%%', (planned, actual, expected) => {
    expect(deviationPct(planned, actual)).toBe(expected);
  });

  it('is null when nothing was planned', () => {
    expect(deviationPct(0, 1800)).toBeNull();
  });
});

describe('guessIntensity', () => {
  const thresholds = { ftp: 300, lthr: 170 };

  it.each([
    [150, Intensity.z1],
    [200, Intensity.z2],
    [260, Intensity.z3],
    [300, Intensity.z4],
    [330, Intensity.z5],
  ])('bike at %i W of 300 FTP → %s', (watts, zone) => {
    expect(guessIntensity({ sport: Sport.bike, avgPower: watts, avgHr: 150 }, thresholds)).toBe(
      zone
    );
  });

  it.each([
    [140, Intensity.z1],
    [148, Intensity.z2],
    [158, Intensity.z3],
    [165, Intensity.z4],
    [172, Intensity.z5],
  ])('run at %i bpm of 170 LTHR → %s', (hr, zone) => {
    expect(guessIntensity({ sport: Sport.run, avgPower: null, avgHr: hr }, thresholds)).toBe(zone);
  });

  it('falls back to heart rate on a ride without power', () => {
    expect(guessIntensity({ sport: Sport.bike, avgPower: null, avgHr: 140 }, thresholds)).toBe(
      Intensity.z1
    );
  });

  it('is null without the numbers', () => {
    expect(
      guessIntensity({ sport: Sport.run, avgPower: null, avgHr: 150 }, { ftp: 300, lthr: null })
    ).toBeNull();
    expect(
      guessIntensity({ sport: Sport.swim, avgPower: null, avgHr: null }, thresholds)
    ).toBeNull();
  });
});

describe('isKeySession', () => {
  it('counts hard or long sessions', () => {
    expect(isKeySession({ intensity: Intensity.z5, durationMin: 45 })).toBe(true);
    expect(isKeySession({ intensity: Intensity.z2, durationMin: 180 })).toBe(true);
    expect(isKeySession({ intensity: Intensity.z2, durationMin: 45 })).toBe(false);
  });
});

describe('closeoutNotices', () => {
  const config = { deviationThresholdPct: 25 };
  const kinds = (sessions: CloseoutSession[], activities: CloseoutActivity[]) =>
    closeoutNotices(matchActivities(sessions, activities), config).map((n) => n.kind);

  it('stays quiet when the day went as planned', () => {
    const vo2 = session('vo2', Sport.bike, 60, { intensity: Intensity.z5 });
    expect(kinds([vo2], [activity('a1', Sport.bike, 62)])).toEqual([]);
  });

  it('stays quiet at exactly the threshold and speaks just above it', () => {
    expect(kinds([session('s1', Sport.run, 60)], [activity('a1', Sport.run, 75)])).toEqual([]);
    const over = activity('a1', Sport.run, 60, { durationSec: 75 * 60 + 6 });
    expect(kinds([session('s1', Sport.run, 60)], [over])).toEqual(['deviation']);
  });

  it('reports a short session as a negative deviation', () => {
    const [notice] = closeoutNotices(
      matchActivities([session('s1', Sport.run, 50)], [activity('a1', Sport.run, 30)]),
      config
    );
    expect(notice).toMatchObject({ kind: 'deviation', deviationPct: -40 });
  });

  it('stays quiet about a skipped easy session', () => {
    expect(kinds([session('easy', Sport.swim, 45)], [])).toEqual([]);
  });

  it('reports a skipped key session', () => {
    expect(kinds([session('long', Sport.bike, 180)], [])).toEqual(['missed_key']);
  });

  it('reports an unplanned workout', () => {
    expect(kinds([], [activity('a1', Sport.run, 45)])).toEqual(['unplanned']);
  });
});
