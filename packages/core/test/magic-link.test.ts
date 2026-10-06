import { describe, expect, it } from 'vitest';
import { signMagicLink, verifyMagicLink } from '../src/magic-link';
import { envSchema } from '../src/config';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-10-06T08:00:00Z');

describe('magic link', () => {
  it('verifies a fresh token and returns its payload', () => {
    const { token, payload } = signMagicLink('user-1', SECRET, 15, NOW);
    const result = verifyMagicLink(token, SECRET, NOW);
    expect(result).toEqual({ ok: true, payload });
    expect(payload.uid).toBe('user-1');
    expect(payload.exp).toBe(NOW.getTime() / 1000 + 15 * 60);
  });

  it('gives every token its own id', () => {
    const a = signMagicLink('user-1', SECRET, 15, NOW).payload.jti;
    const b = signMagicLink('user-1', SECRET, 15, NOW).payload.jti;
    expect(a).not.toBe(b);
  });

  it('rejects a missing token', () => {
    expect(verifyMagicLink(undefined, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'missing',
      tokenId: null,
    });
    expect(verifyMagicLink('', SECRET, NOW)).toMatchObject({ reason: 'missing' });
  });

  it('rejects malformed tokens', () => {
    for (const token of ['abc', 'a.b.c', '.sig', 'body.', 'bm90IGpzb24.c2ln']) {
      expect(verifyMagicLink(token, SECRET, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('rejects a token signed with another secret', () => {
    const { token, payload } = signMagicLink('user-1', 'b'.repeat(32), 15, NOW);
    expect(verifyMagicLink(token, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
      tokenId: payload.jti,
    });
  });

  it('rejects a payload swapped to another user', () => {
    const { token } = signMagicLink('user-1', SECRET, 15, NOW);
    const [, signature] = token.split('.');
    const forged = signMagicLink('user-2', 'b'.repeat(32), 15, NOW).token.split('.')[0];
    expect(verifyMagicLink([forged, signature].join('.'), SECRET, NOW)).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an expired token, also exactly at expiry', () => {
    const { token, payload } = signMagicLink('user-1', SECRET, 15, NOW);
    const atExpiry = new Date(payload.exp * 1000);
    expect(verifyMagicLink(token, SECRET, atExpiry)).toEqual({
      ok: false,
      reason: 'expired',
      tokenId: payload.jti,
    });
  });
});

describe('dashboard config', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: 't',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    SECRETS_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('leaves the dashboard off by default', () => {
    const env = envSchema.parse(base);
    expect(env.DASHBOARD_BASE_URL).toBeUndefined();
    expect(env.DASHBOARD_LINK_TTL_MINUTES).toBe(15);
    expect(env.WEB_PORT).toBe(3000);
  });

  it('requires the link secret with a base URL', () => {
    const result = envSchema.safeParse({ ...base, DASHBOARD_BASE_URL: 'https://coach.example' });
    expect(result.success).toBe(false);
  });

  it('treats empty values as unset', () => {
    const env = envSchema.parse({ ...base, DASHBOARD_BASE_URL: '', TELEGRAM_BOT_USERNAME: '' });
    expect(env.DASHBOARD_BASE_URL).toBeUndefined();
    expect(env.TELEGRAM_BOT_USERNAME).toBeUndefined();
  });
});
