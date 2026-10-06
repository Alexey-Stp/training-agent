import { afterEach, describe, expect, it } from 'vitest';
import { Sport } from '@triathlon/core';
import { loadWeek, parseWeekParam } from '../src/week/load';
import { get, MemoryReadRepo, NOW, session, signIn, startApp, type Harness } from './harness';

// NOW: Tuesday 2026-10-06 in Prague, ISO week 2026-W41 (Mon 5 – Sun 11 Oct)
let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function repo(): MemoryReadRepo {
  const reads = new MemoryReadRepo();
  reads.timezones.set('user-a', 'Europe/Prague');
  reads.sessions.set('user-a', [
    session({ date: '2026-10-04', title: 'Last Sunday' }),
    session({ date: '2026-10-05', status: 'completed' }),
    session({ date: '2026-10-06', slot: 'run-0', sport: Sport.run, durationMin: 45 }),
    session({ date: '2026-10-06', slot: 'swim-0', sport: Sport.swim, durationMin: 40 }),
    session({ date: '2026-10-07', sport: Sport.rest, title: 'Rest', durationMin: 0 }),
    session({ date: '2026-10-11', durationMin: 180 }),
    session({ date: '2026-10-12', title: 'Next Monday' }),
  ]);
  return reads;
}

describe('loadWeek', () => {
  it('builds Monday..Sunday of the local week with sports and totals', async () => {
    const model = await loadWeek('user-a', null, { reads: repo(), now: () => NOW });
    if (model.kind !== 'week') throw new Error('expected a week');
    expect(model.key).toBe('2026-W41');
    expect(model.days.map((d) => d.date)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
    expect(model.days.map((d) => d.totalMin)).toEqual([60, 85, 0, 0, 0, 0, 180]);
    expect(model.days[1]).toMatchObject({ isToday: true, sports: [Sport.run, Sport.swim] });
    expect(model.days[0].done).toBe(true);
    expect(model.days[2].sessions).toHaveLength(0);
    expect(model.totalMin).toBe(325);
    expect([model.previous, model.next]).toEqual(['2026-W40', '2026-W42']);
  });

  it('opens another week from its key, across a year boundary', async () => {
    const model = await loadWeek('user-a', '2026-W53', { reads: repo(), now: () => NOW });
    expect(model.kind === 'week' && [model.range, model.next]).toEqual([
      { from: '2026-12-28', to: '2027-01-03' },
      '2027-W01',
    ]);
  });

  it('validates week keys', () => {
    expect(parseWeekParam('2026-W41')).toBe('2026-W41');
    expect(parseWeekParam('2027-W53')).toBeNull();
    expect(parseWeekParam('2026-41')).toBeNull();
    expect(parseWeekParam(['2026-W41'])).toBeNull();
  });
});

describe('Week page', () => {
  async function weekHtml(path = '/week'): Promise<string> {
    h = await startApp(['user-a'], { reads: repo() });
    const cookie = await signIn(h, 'user-a');
    const res = await get(h, path, cookie);
    expect(res.status).toBe(200);
    return res.text();
  }

  it('renders 7 tappable day cells with today highlighted', async () => {
    const html = await weekHtml();
    expect(html).toContain('Week 41 · 5–11 Oct');
    const hrefs = [...html.matchAll(/class="day[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(7);
    expect(hrefs[0]).toBe('/today?date=2026-10-05');
    expect(html).toContain('class="day today" href="/today?date=2026-10-06" aria-current="date"');
    expect(html).toContain('🏃🏊');
    expect(html).toContain('1h 25m');
    expect(html).toContain('3h');
    expect(html).toContain('1h ✓');
    expect(html).toContain('Rest');
    expect(html).not.toContain('Last Sunday');
    expect(html).not.toContain('Next Monday');
  });

  it('describes each cell for screen readers', async () => {
    expect(await weekHtml()).toContain('aria-label="Tuesday 6 October: run 45m, swim 40m"');
  });

  it('pages to other weeks and back', async () => {
    const html = await weekHtml('/week?week=2026-W42');
    expect(html).toContain('Week 42 · 12–18 Oct');
    expect(html).toContain('href="/week?week=2026-W41"');
    expect(html).toContain('href="/week"');
    expect(html).not.toContain('class="day today"');
  });

  it('falls back to the current week for a bad key', async () => {
    expect(await weekHtml('/week?week=nope')).toContain('Week 41');
  });

  it('tap-through opens that day in Today', async () => {
    const reads = repo();
    h = await startApp(['user-a'], { reads });
    const cookie = await signIn(h, 'user-a');
    const html = await (await get(h, '/today?date=2026-10-11', cookie)).text();
    expect(html).toContain('Sun 11 Oct');
    expect(html).toContain('3h');
  });
});
