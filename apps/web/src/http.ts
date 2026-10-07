import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'ta_session';

function decodeCookie(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Value of one cookie from the Cookie header (no cookie-parser dependency). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeCookie(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

export function sessionCookie(value: string, options: CookieOptions): string {
  const parts = [
    SESSION_COOKIE + '=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + String(options.maxAgeSeconds),
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

/** Constant-time string comparison (CSRF tokens). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Headers on every response: no scripts at all (CSP), no framing, and no Referer, so a
 * magic-link token in the URL never leaks to another site.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/** HTML response that is never cached (pages carry athlete data or a token). */
export function sendHtml(res: Response, status: number, body: string): void {
  res.status(status).setHeader('Cache-Control', 'no-store').type('html').send(body);
}
