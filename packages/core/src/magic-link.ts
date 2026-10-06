import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Dashboard magic link (TA-52): the worker signs a short-lived token for the athlete's User.id
 * after /dashboard, the web app verifies it once and starts a server session.
 * Format: `base64url(JSON payload).base64url(HMAC-SHA256(payload part))`.
 */
export const MAGIC_LINK_VERSION = 1;

export interface MagicLinkPayload {
  v: number;
  /** Token id: logged on rejection and consumed once (replay guard) */
  jti: string;
  /** User.id (cuid), never the Telegram id */
  uid: string;
  /** Expiry, epoch seconds */
  exp: number;
}

export type MagicLinkRejection = 'missing' | 'malformed' | 'bad_signature' | 'expired' | 'replayed';

export type MagicLinkResult =
  | { ok: true; payload: MagicLinkPayload }
  | { ok: false; reason: MagicLinkRejection; tokenId: string | null };

function sign(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function signMagicLink(
  userId: string,
  secret: string,
  ttlMinutes: number,
  now: Date = new Date()
): { token: string; payload: MagicLinkPayload } {
  const payload: MagicLinkPayload = {
    v: MAGIC_LINK_VERSION,
    jti: randomBytes(12).toString('base64url'),
    uid: userId,
    exp: Math.floor(now.getTime() / 1000) + Math.round(ttlMinutes * 60),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: [body, sign(body, secret).toString('base64url')].join('.'), payload };
}

function parsePayload(body: string): MagicLinkPayload | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const p = value as Record<string, unknown>;
    const valid =
      p.v === MAGIC_LINK_VERSION &&
      typeof p.jti === 'string' &&
      p.jti.length > 0 &&
      typeof p.uid === 'string' &&
      p.uid.length > 0 &&
      typeof p.exp === 'number' &&
      Number.isFinite(p.exp);
    return valid
      ? { v: p.v as number, jti: p.jti as string, uid: p.uid as string, exp: p.exp as number }
      : null;
  } catch {
    return null;
  }
}

/**
 * Checks shape, signature (constant time) and expiry. It does not consume the token: the
 * caller marks `jti` used (and reports `replayed` when it already was).
 */
export function verifyMagicLink(
  token: string | undefined | null,
  secret: string,
  now: Date = new Date()
): MagicLinkResult {
  if (!token) return { ok: false, reason: 'missing', tokenId: null };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'malformed', tokenId: null };
  }
  const [body, signature] = parts;
  const payload = parsePayload(body);
  if (!payload) return { ok: false, reason: 'malformed', tokenId: null };

  const expected = sign(body, secret);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature', tokenId: payload.jti };
  }
  if (payload.exp * 1000 <= now.getTime()) {
    return { ok: false, reason: 'expired', tokenId: payload.jti };
  }
  return { ok: true, payload };
}
