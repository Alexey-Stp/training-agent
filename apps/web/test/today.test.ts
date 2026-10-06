import { afterEach, describe, expect, it } from 'vitest';
import { Intensity, Sport } from '@triathlon/core';
import { loadToday } from '../src/today/load';
import { get, MemoryReadRepo, NOW, session, signIn, startApp, type Harness } from './harness';

// NOW is 2026-10-06T08:00Z: Tuesday 6 Oct in Prague
const TODAY = '2026-10-06';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function repoWith(userId = 'user-a'): MemoryReadRepo {
  const reads = new MemoryReadRepo();
  reads.timezones.set(userId, 'Europe/Prague');
  return reads;
}

const deps = (reads: MemoryReadRepo) => ({ reads, now: () => NOW });

describe('loadToday', () => {
  it('shows the persisted sessions of local today', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [
      session({ date: TODAY, slot: 'run-0', sport: Sport.run, title: 'Threshold run' }),
      session({ date: TODAY, slot: 'bike-0' }),
      session({ date: '2026-10-07' }),
    ]);
    const model = await loadToday('user-a', null, deps(reads));
    expect(model.kind).toBe('sessions');
    expect(model.kind === 'sessions' && model.sessions.map((s) => s.slot)).toEqual([
      'bike-0',
      'run-0',
    ]);
  });

  it('uses the athlete timezone for "today"', async () => {
    const reads = new MemoryReadRepo();
    reads.timezones.set('user-a', 'Pacific/Honolulu'); // still 5 Oct there
    reads.sessions.set('user-a', [session({ date: '2026-10-05' })]);
    const model = await loadToday('user-a', null, deps(reads));
    expect(model).toMatchObject({ kind: 'sessions', today: '2026-10-05', date: '2026-10-05' });
  });

  it('is a rest day when other days have sessions but this one has none', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [session({ date: '2026-10-05' })]);
    expect(await loadToday('user-a', null, deps(reads))).toMatchObject({ kind: 'rest' });
  });

  it('treats a stored rest session as a rest day', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [session({ date: TODAY, sport: Sport.rest, title: 'Rest' })]);
    expect(await loadToday('user-a', null, deps(reads))).toMatchObject({ kind: 'rest' });
  });

  it('is a rest day with an active season and nothing stored yet', async () => {
    const reads = repoWith();
    reads.activeSeasons.add('user-a');
    expect(await loadToday('user-a', null, deps(reads))).toMatchObject({ kind: 'rest' });
  });

  it('is "no plan yet" without a season or stored sessions', async () => {
    expect(await loadToday('user-a', null, deps(repoWith()))).toMatchObject({ kind: 'no_plan' });
  });

  it('shows another day when asked', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [session({ date: '2026-10-09', title: 'Friday ride' })]);
    expect(await loadToday('user-a', '2026-10-09', deps(reads))).toMatchObject({
      kind: 'sessions',
      date: '2026-10-09',
      today: TODAY,
    });
  });

  it('asks for a profile when there is none', async () => {
    expect(await loadToday('user-a', null, deps(new MemoryReadRepo()))).toEqual({
      kind: 'no_profile',
    });
  });
});

async function page(reads: MemoryReadRepo, path = '/', overrides = {}): Promise<string> {
  h = await startApp(['user-a'], { reads, ...overrides });
  const cookie = await signIn(h, 'user-a');
  const res = await get(h, path, cookie);
  expect(res.status).toBe(200);
  return res.text();
}

describe('Today page', () => {
  it('renders title, time, duration and ordered interval steps', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [
      session({
        date: TODAY,
        title: 'VO2 intervals',
        durationMin: 55,
        intensity: Intensity.z5,
        description: 'Keep cadence high',
        steps: [
          { kind: 'warmup', durationMin: 15, zone: Intensity.z2 },
          {
            kind: 'repeat',
            count: 5,
            work: { durationMin: 3, zone: Intensity.z5 },
            rest: { durationMin: 3, zone: Intensity.z1 },
          },
          { kind: 'cooldown', durationMin: 10, zone: Intensity.z1 },
        ],
      }),
    ]);
    const html = await page(reads);
    expect(html).toContain('Today · Tue 6 Oct');
    expect(html).toContain('🚴 VO2 intervals');
    expect(html).toContain('Any time today');
    expect(html).toContain('55m');
    expect(html).toContain('Keep cadence high');
    const steps = [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) =>
      m[1].replaceAll(/<[^>]+>/g, '')
    );
    expect(steps).toEqual(['Warmup 15′ Z2', 'Main set 5 × 3′ Z5 / 3′ Z1 easy', 'Cooldown 10′ Z1']);
  });

  it('badges a session edited in intervals.icu', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [
      session({ date: TODAY, status: 'modified_externally', externalChange: 'duration changed' }),
    ]);
    const html = await page(reads);
    expect(html).toContain('edited in intervals.icu');
    expect(html).toContain('title="duration changed"');
  });

  it('renders stored text escaped', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [session({ date: TODAY, title: '<script>x</script>' })]);
    const html = await page(reads);
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says so when the steps cannot be read', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [session({ date: TODAY, steps: null })]);
    expect(await page(reads)).toContain('No interval detail');
  });

  it('renders the rest day card', async () => {
    const reads = repoWith();
    reads.activeSeasons.add('user-a');
    expect(await page(reads)).toContain('Rest day');
  });

  it('renders "No plan yet" with the season deep link', async () => {
    const html = await page(repoWith(), '/', { botUsername: 'TriCoachBot' });
    expect(html).toContain('No plan yet');
    expect(html).toContain('href="https://t.me/TriCoachBot?start=season_new"');
  });

  it('falls back to the /season new hint without a bot username', async () => {
    expect(await page(repoWith())).toContain('/season new');
  });

  it('opens another day from ?date and links back to today', async () => {
    const reads = repoWith();
    reads.sessions.set('user-a', [session({ date: '2026-10-08', title: 'Thursday ride' })]);
    const html = await page(reads, '/today?date=2026-10-08');
    expect(html).toContain('Thu 8 Oct');
    expect(html).toContain('Thursday ride');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/today?date=2026-10-07"');
  });

  it('ignores an invalid ?date and shows today', async () => {
    const html = await page(repoWith(), '/today?date=2026-13-40');
    expect(html).toContain('Today · Tue 6 Oct');
  });
});
