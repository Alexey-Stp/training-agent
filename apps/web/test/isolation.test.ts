import { afterEach, describe, expect, it } from 'vitest';
import { signMagicLink } from '@triathlon/core';
import {
  defaultSettings,
  get,
  MemoryReadRepo,
  MemorySettingsRepo,
  NOW,
  SECRET,
  post,
  session,
  signIn,
  startApp,
  type Harness,
} from './harness';

/**
 * Two athletes with distinct data. Whatever athlete A sends (another user id in the query or
 * body, B's dates or weeks, a forged session cookie, a link for B signed with another key),
 * A's pages show A's data only, and nothing of B's ever reaches the HTML.
 */
const B_MARKERS = ['B-SECRET-RIDE', 'B-SECRET-RUN', 'B-NOTES', '2002'];

let h: Harness;

afterEach(async () => {
  await h.close();
});

async function twoAthletes() {
  const reads = new MemoryReadRepo();
  reads.timezones.set('user-a', 'Europe/Prague');
  reads.timezones.set('user-b', 'Europe/Prague');
  reads.sessions.set('user-a', [session({ date: '2026-10-06', title: 'A ride' })]);
  reads.sessions.set('user-b', [
    session({ date: '2026-10-06', title: 'B-SECRET-RIDE', description: 'B-NOTES' }),
    session({ date: '2026-10-09', slot: 'run-0', title: 'B-SECRET-RUN' }),
  ]);
  const settings = new MemorySettingsRepo();
  settings.profiles.set('user-a', defaultSettings('1001'));
  settings.profiles.set('user-b', { ...defaultSettings('2002'), notifyChatId: '-100777' });
  h = await startApp(['user-a', 'user-b'], { reads, settings });
  const cookie = await signIn(h, 'user-a');
  return { reads, settings, cookie };
}

function expectNoB(html: string): void {
  for (const marker of B_MARKERS) expect(html).not.toContain(marker);
}

describe('athlete isolation', () => {
  it.each([
    '/?userId=user-b',
    '/today?date=2026-10-06&userId=user-b',
    '/today?date=2026-10-09&user=user-b&id=user-b',
    '/week?userId=user-b',
    '/week?week=2026-W41&uid=user-b',
    '/settings?userId=user-b',
  ])('%s shows only the signed-in athlete’s data', async (path) => {
    const { reads, cookie } = await twoAthletes();
    const res = await get(h, path, cookie);
    expect(res.status).toBe(200);
    expectNoB(await res.text());
    expect(reads.calls.every((c) => c.userId === 'user-a')).toBe(true);
  });

  it('A sees their own session on the shared date', async () => {
    const { cookie } = await twoAthletes();
    const html = await (await get(h, '/today?date=2026-10-06', cookie)).text();
    expect(html).toContain('A ride');
  });

  it('a settings POST naming B changes only A', async () => {
    const { settings, cookie } = await twoAthletes();
    const form = {
      csrf: 'csrf-user-a',
      userId: 'user-b',
      ftp: '300',
      lthr: '',
      timezone: 'Europe/Prague',
      briefTime: '',
      closeoutTime: '',
      swimDays: ['Wed'],
      swimOptional: '',
      bikeVo2Day: 'Thu',
      longBikeDay: 'Sun',
      noLongRunDay: 'Sun',
      notifyChatId: '',
    };
    expect((await post(h, '/settings', form, cookie)).status).toBe(303);
    expect(settings.profiles.get('user-a')?.ftp).toBe(300);
    expect(settings.profiles.get('user-b')).toMatchObject({ ftp: 355, notifyChatId: '-100777' });
  });

  it('a forged session cookie gets 401 and no data', async () => {
    const { reads } = await twoAthletes();
    const res = await get(h, '/today?date=2026-10-06', 'ta_session=user-b');
    expect(res.status).toBe(401);
    expectNoB(await res.text());
    expect(reads.calls).toEqual([]);
  });

  it('a link for B signed with another key gets 401 and no session', async () => {
    await twoAthletes();
    const forged = signMagicLink('user-b', 'attacker-key-'.padEnd(40, 'z'), 15, NOW).token;
    const res = await get(h, '/auth?t=' + forged);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expectNoB(await res.text());
  });

  it('B’s link cannot be replayed after B used it', async () => {
    await twoAthletes();
    const token = signMagicLink('user-b', SECRET, 15, NOW).token;
    expect((await get(h, '/auth?t=' + token)).status).toBe(303);
    expect((await get(h, '/auth?t=' + token)).status).toBe(401);
  });
});

describe('every page requires a session', () => {
  it.each(['/', '/today', '/today?date=2026-10-06', '/week', '/settings'])(
    'GET %s without a session is a 401 with no athlete data',
    async (path) => {
      const { reads } = await twoAthletes();
      const res = await get(h, path);
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain('Link expired');
      expect(html).not.toContain('A ride');
      expectNoB(html);
      expect(reads.calls).toEqual([]);
    }
  );
});
