import { afterEach, describe, expect, it } from 'vitest';
import { addDaysIso, Intensity } from '@triathlon/core';
import { loadToday } from '../src/today/load';
import type { WellnessDay } from '../src/plan/read-store';
import { get, MemoryReadRepo, NOW, session, signIn, startApp, type Harness } from './harness';

const TODAY = '2026-10-06';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function wellness(date: string, patch: Partial<WellnessDay> = {}): WellnessDay {
  return {
    date,
    hrv: null,
    restingHr: null,
    sleepHours: null,
    tsb: null,
    subjectiveReadiness: null,
    soreness: null,
    ...patch,
  };
}

function repo(): MemoryReadRepo {
  const reads = new MemoryReadRepo();
  reads.timezones.set('user-a', 'Europe/Prague');
  return reads;
}

const completed = session({
  date: TODAY,
  title: 'Endurance ride',
  durationMin: 90,
  intensity: Intensity.z2,
  status: 'completed',
  deviationPct: -6.7,
  actualIntensity: Intensity.z3,
  activity: {
    name: 'Morning Ride',
    // 05:12Z is 07:12 in Prague (CEST)
    startTime: new Date('2026-10-06T05:12:00Z'),
    durationSec: 84 * 60,
    distanceM: 42_300,
    avgHr: 141.4,
    avgPower: 198.6,
  },
});

async function todayHtml(reads: MemoryReadRepo, path = '/'): Promise<string> {
  h = await startApp(['user-a'], { reads });
  const cookie = await signIn(h, 'user-a');
  return (await get(h, path, cookie)).text();
}

function cells(html: string): string[][] {
  return [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => c[1])
  );
}

describe('Today: planned vs actual', () => {
  it('shows a completed session side by side with its matched activity', async () => {
    const reads = repo();
    reads.sessions.set('user-a', [completed]);
    const html = await todayHtml(reads);
    expect(html).toContain('Completed');
    expect(html).toContain('Started 07:12');
    expect(html).toContain('Planned vs actual: Morning Ride');
    expect(cells(html)).toEqual([
      ['', 'Planned', 'Actual'],
      ['Duration', '1h 30m', '1h 24m (−7%)'],
      ['Zone', 'Z2', 'Z3'],
      ['Start', 'Any time', '07:12'],
      ['Distance', '—', '42.3 km'],
      ['Avg power', '—', '199 W'],
      ['Avg HR', '—', '141 bpm'],
    ]);
  });

  it('shows a dash when the close-out could not guess the zone', async () => {
    const reads = repo();
    reads.sessions.set('user-a', [
      {
        ...completed,
        actualIntensity: null,
        deviationPct: null,
        activity: completed.activity && {
          ...completed.activity,
          distanceM: null,
          avgHr: null,
          avgPower: null,
        },
      },
    ]);
    const rows = cells(await todayHtml(reads));
    expect(rows).toContainEqual(['Zone', 'Z2', '—']);
    expect(rows).toContainEqual(['Duration', '1h 30m', '1h 24m']);
    expect(rows).toHaveLength(4);
  });

  it('marks a missed session and shows no comparison', async () => {
    const reads = repo();
    reads.sessions.set('user-a', [session({ date: TODAY, status: 'skipped' })]);
    const html = await todayHtml(reads);
    expect(html).toContain('Missed');
    expect(html).not.toContain('<table>');
  });
});

describe('Today: readiness line', () => {
  it('shows the brief verdict from today’s check-in', async () => {
    const reads = repo();
    reads.sessions.set('user-a', [session({ date: TODAY })]);
    reads.wellness.set('user-a', [wellness(TODAY, { subjectiveReadiness: 2 })]);
    expect(await todayHtml(reads)).toContain('🔴 Low readiness (2/5): keep today easy.');
  });

  it('flags HRV below the 30-day baseline', async () => {
    const reads = repo();
    const history = Array.from({ length: 10 }, (_, i) =>
      wellness(addDaysIso(TODAY, -(i + 1)), { hrv: 60 + (i % 2) })
    );
    reads.wellness.set('user-a', [...history, wellness(TODAY, { hrv: 40 })]);
    const model = await loadToday('user-a', null, { reads, now: () => NOW });
    expect(model.kind !== 'no_profile' && model.readiness?.emoji).toBe('🟡');
  });

  it('is neutral without wellness data', async () => {
    const model = await loadToday('user-a', null, { reads: repo(), now: () => NOW });
    expect(model.kind !== 'no_profile' && model.readiness?.emoji).toBe('⚪');
  });

  it('is left out on other days and does not read wellness for them', async () => {
    const reads = repo();
    const model = await loadToday('user-a', '2026-10-08', { reads, now: () => NOW });
    expect(model.kind !== 'no_profile' && model.readiness).toBeNull();
    expect(reads.calls.some((c) => c.method === 'findWellness')).toBe(false);
  });
});
