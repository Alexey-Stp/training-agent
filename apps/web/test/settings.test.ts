import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  get,
  MemorySettingsRepo,
  post,
  signIn,
  startApp,
  type Harness,
} from './harness';

let h: Harness;

afterEach(async () => {
  await h.close();
});

const FORM = {
  csrf: 'csrf-user-a',
  ftp: '290',
  lthr: '170',
  timezone: 'America/New_York',
  briefTime: '05:45',
  closeoutTime: '21:00',
  swimDays: ['Mon', 'Thu'],
  swimOptional: 'Sat',
  bikeVo2Day: 'Wed',
  longBikeDay: 'Sat',
  noLongRunDay: 'Sat',
  notifyChatId: '',
};

async function setup(overrides: Parameters<typeof startApp>[1] = {}) {
  const settings = new MemorySettingsRepo();
  settings.profiles.set('user-a', defaultSettings('1001'));
  settings.profiles.set('user-b', { ...defaultSettings('2002'), ftp: 401 });
  const events = { changed: vi.fn(() => Promise.resolve()) };
  h = await startApp(['user-a', 'user-b'], { settings, events, ...overrides });
  const cookie = await signIn(h, 'user-a');
  return { settings, events, cookie };
}

describe('GET /settings', () => {
  it('shows the signed-in athlete’s profile', async () => {
    const { cookie } = await setup();
    const res = await get(h, '/settings', cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="355"');
    expect(html).toContain('<option selected>Europe/Prague</option>');
    expect(html).toContain('value="Wed" checked');
    expect(html).toContain('id 1001');
    expect(html).not.toContain('401');
  });

  it('requires a session', async () => {
    await setup();
    expect((await get(h, '/settings')).status).toBe(401);
  });

  it('asks for /start when the athlete has no profile yet', async () => {
    h = await startApp(['user-c']);
    const cookie = await signIn(h, 'user-c');
    expect(await (await get(h, '/settings', cookie)).text()).toContain('/start');
  });
});

describe('POST /settings', () => {
  it('saves valid settings, queues the schedule refresh and confirms', async () => {
    const { settings, events, cookie } = await setup();
    const res = await post(h, '/settings', FORM, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/settings?saved=1');
    expect(settings.profiles.get('user-a')).toMatchObject({
      ftp: 290,
      lthr: 170,
      timezone: 'America/New_York',
      briefTime: '05:45',
      closeoutTime: '21:00',
      swimDays: ['Mon', 'Thu', 'Sat_optional'],
      bikeVo2Day: 'Wed',
    });
    expect(events.changed).toHaveBeenCalledWith('user-a');

    const page = await (await get(h, '/settings?saved=1', cookie)).text();
    expect(page).toContain('Settings saved');
    expect(page).toContain('value="290"');
  });

  it('only ever writes the signed-in athlete’s profile', async () => {
    const { settings, cookie } = await setup();
    await post(h, '/settings', { ...FORM, userId: 'user-b' }, cookie);
    expect(settings.profiles.get('user-b')?.ftp).toBe(401);
  });

  it('re-renders with field errors and saves nothing on invalid input', async () => {
    const { settings, events, cookie } = await setup();
    const res = await post(h, '/settings', { ...FORM, ftp: '9000', briefTime: 'soon' }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Nothing was saved');
    expect(html).toContain('id="ftp-error"');
    expect(html).toContain('id="briefTime-error"');
    expect(html).toContain('value="9000"');
    expect(settings.writes).toBe(0);
    expect(events.changed).not.toHaveBeenCalled();
  });

  it('refuses a POST without the session’s CSRF token', async () => {
    const { settings, cookie } = await setup();
    const res = await post(h, '/settings', { ...FORM, csrf: 'csrf-user-b' }, cookie);
    expect(res.status).toBe(403);
    expect(settings.writes).toBe(0);
  });

  it('refuses a POST without a session', async () => {
    const { settings } = await setup();
    expect((await post(h, '/settings', FORM)).status).toBe(401);
    expect(settings.writes).toBe(0);
  });

  it('tests a new notification chat before saving it', async () => {
    const verify = vi.fn(() => Promise.resolve({ ok: true as const }));
    const { settings, cookie } = await setup({ chats: { verify } });
    await post(h, '/settings', { ...FORM, notifyChatId: '-1001234567890' }, cookie);
    expect(verify).toHaveBeenCalledWith('-1001234567890');
    expect(settings.profiles.get('user-a')?.notifyChatId).toBe('-1001234567890');

    // Unchanged chat: no second test message
    await post(h, '/settings', { ...FORM, notifyChatId: '-1001234567890' }, cookie);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('keeps the old chat when the bot cannot post to the new one', async () => {
    const verify = () =>
      Promise.resolve({
        ok: false as const,
        message: 'The bot cannot post there (chat not found).',
      });
    const { settings, cookie } = await setup({ chats: { verify } });
    const res = await post(h, '/settings', { ...FORM, notifyChatId: '-100999' }, cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('chat not found');
    expect(settings.writes).toBe(0);
  });

  it('still saves when the schedule refresh cannot be queued, and logs it', async () => {
    const events = { changed: () => Promise.reject(new Error('redis down')) };
    const { settings, cookie } = await setup({ events });
    expect((await post(h, '/settings', FORM, cookie)).status).toBe(303);
    expect(settings.writes).toBe(1);
    expect(h.logger.entries.some((e) => e.level === 'error')).toBe(true);
  });
});
