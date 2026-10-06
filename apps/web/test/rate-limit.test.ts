import { afterEach, describe, expect, it } from 'vitest';
import { get, post, signIn, startApp, tokenFor, type Harness } from './harness';

let h: Harness;

afterEach(async () => {
  await h.close();
});

const warnings = (harness: Harness) =>
  harness.logger.entries.filter((e) => e.message === 'dashboard rate limited');

describe('rate limiting', () => {
  it('limits sign-in attempts per client and answers 429 with a page', async () => {
    h = await startApp(['user-a'], { rateLimit: { authLimit: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await get(h, '/auth?t=bad-' + String(i))).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);

    const limited = await get(h, '/auth?t=' + tokenFor('user-a'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await limited.text()).toContain('Too many requests');
    expect(warnings(h).length).toBeGreaterThan(0);
  });

  it('a limited sign-in does not consume the token', async () => {
    h = await startApp(['user-a'], { rateLimit: { authLimit: 1 } });
    await get(h, '/auth?t=bad');
    const token = tokenFor('user-a');
    expect((await get(h, '/auth?t=' + token)).status).toBe(429);
    expect(h.sessions.used.size).toBe(0);
  });

  it('limits sign-out too, with the same counter', async () => {
    h = await startApp(['user-a'], { rateLimit: { authLimit: 2 } });
    const cookie = await signIn(h, 'user-a'); // 1st hit
    expect((await post(h, '/logout', { csrf: 'wrong' }, cookie)).status).toBe(403); // 2nd
    expect((await post(h, '/logout', { csrf: 'csrf-user-a' }, cookie)).status).toBe(429);
  });

  it('does not count page loads against the sign-in limit', async () => {
    h = await startApp(['user-a'], { rateLimit: { authLimit: 2 } });
    const cookie = await signIn(h, 'user-a');
    for (let i = 0; i < 6; i++) expect((await get(h, '/week', cookie)).status).toBe(200);
  });

  it('has a general limit for all pages, but not for /healthz', async () => {
    h = await startApp(['user-a'], { rateLimit: { generalLimit: 3, authLimit: 50 } });
    const cookie = await signIn(h, 'user-a');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await get(h, '/week', cookie)).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
    for (let i = 0; i < 6; i++) expect((await get(h, '/healthz')).status).toBe(200);
  });
});
