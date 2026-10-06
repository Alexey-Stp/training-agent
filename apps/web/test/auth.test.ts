import { afterEach, describe, expect, it } from 'vitest';
import { signMagicLink } from '@triathlon/core';
import { get, NOW, post, SECRET, signIn, startApp, tokenFor, type Harness } from './harness';

let h: Harness;

afterEach(async () => {
  await h.close();
});

function warnings(harness: Harness): unknown[] {
  return harness.logger.entries
    .filter((e) => e.level === 'warn' && e.message === 'dashboard auth rejected')
    .map((e) => e.details);
}

describe('health and assets', () => {
  it('answers /healthz without a session', async () => {
    h = await startApp([]);
    const res = await get(h, '/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('serves the stylesheet with long caching and security headers on every response', async () => {
    h = await startApp([]);
    const res = await get(h, '/app.css');
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('magic-link sign-in', () => {
  it('starts a session from a valid link and redirects to the shell', async () => {
    h = await startApp(['user-a']);
    const res = await get(h, '/auth?t=' + tokenFor('user-a'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const shell = await get(h, '/', cookie.split(';')[0]);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('cache-control')).toBe('no-store');
    expect(await shell.text()).toContain('You are signed in');
  });

  it('sets Secure cookies when configured', async () => {
    h = await startApp(['user-a'], { secureCookies: true });
    const res = await get(h, '/auth?t=' + tokenFor('user-a'));
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it.each([
    ['missing', '/auth'],
    ['malformed', '/auth?t=not-a-token'],
    ['bad_signature', '/auth?t=' + tokenFor('user-a', 'other-secret-'.padEnd(40, 'y'))],
    ['expired', '/auth?t=' + tokenFor('user-a', SECRET, new Date(NOW.getTime() - 16 * 60_000))],
  ])('rejects a %s token with the 401 page and a structured warning', async (reason, path) => {
    h = await startApp(['user-a']);
    const res = await get(h, path);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Link expired');
    expect(warnings(h)).toEqual([expect.objectContaining({ reason })]);
  });

  it('logs the token id of a rejected signed token', async () => {
    h = await startApp(['user-a']);
    const { token, payload } = signMagicLink(
      'user-a',
      SECRET,
      15,
      new Date(NOW.getTime() - 3600_000)
    );
    await get(h, '/auth?t=' + token);
    expect(warnings(h)).toEqual([
      expect.objectContaining({ reason: 'expired', tokenId: payload.jti }),
    ]);
  });

  it('accepts a link once: a replay is rejected', async () => {
    h = await startApp(['user-a']);
    const token = tokenFor('user-a');
    expect((await get(h, '/auth?t=' + token)).status).toBe(303);
    const replay = await get(h, '/auth?t=' + token);
    expect(replay.status).toBe(401);
    expect(warnings(h)).toEqual([expect.objectContaining({ reason: 'replayed' })]);
  });

  it('rejects a valid link for a user that no longer exists', async () => {
    h = await startApp([]);
    expect((await get(h, '/auth?t=' + tokenFor('ghost'))).status).toBe(401);
    expect(warnings(h)).toEqual([expect.objectContaining({ reason: 'unknown_user' })]);
  });

  it('rejects every link when no secret is configured', async () => {
    h = await startApp(['user-a'], { linkSecret: undefined });
    expect((await get(h, '/auth?t=' + tokenFor('user-a'))).status).toBe(401);
    expect(warnings(h)).toEqual([expect.objectContaining({ reason: 'disabled' })]);
  });

  it('never logs the token itself', async () => {
    h = await startApp(['user-a']);
    const token = tokenFor('user-a', 'other-secret-'.padEnd(40, 'y'));
    await get(h, '/auth?t=' + token);
    expect(JSON.stringify(h.logger.entries)).not.toContain(token);
  });
});

describe('session guard', () => {
  it.each([
    ['no_session', undefined],
    ['unknown_session', 'ta_session=forged-session-id'],
  ])('answers %s with 401 and no athlete data', async (reason, cookie) => {
    h = await startApp(['user-a']);
    const res = await get(h, '/', cookie);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('signed in');
    expect(warnings(h)).toEqual([expect.objectContaining({ reason, tokenId: null })]);
  });

  it('drops the session of a deleted user', async () => {
    const known = new Set(['user-a']);
    h = await startApp([], { users: { exists: (id) => Promise.resolve(known.has(id)) } });
    const cookie = await signIn(h, 'user-a');
    known.delete('user-a');
    expect((await get(h, '/', cookie)).status).toBe(401);
  });

  it('renders a 404 page for unknown paths', async () => {
    h = await startApp([]);
    expect((await get(h, '/nope')).status).toBe(404);
  });
});

describe('sign-out', () => {
  it('ends the session with a valid CSRF token', async () => {
    h = await startApp(['user-a']);
    const cookie = await signIn(h, 'user-a');
    const res = await post(h, '/logout', { csrf: 'csrf-user-a' }, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await get(h, '/', cookie)).status).toBe(401);
  });

  it('refuses a sign-out without the CSRF token', async () => {
    h = await startApp(['user-a']);
    const cookie = await signIn(h, 'user-a');
    expect((await post(h, '/logout', { csrf: 'wrong' }, cookie)).status).toBe(403);
    expect((await get(h, '/', cookie)).status).toBe(200);
  });
});
