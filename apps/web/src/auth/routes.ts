import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { verifyMagicLink, type MagicLinkResult } from '@triathlon/core';
import { clearSessionCookie, readCookie, SESSION_COOKIE, sendHtml, sessionCookie } from '../http';
import { renderSignedOut } from '../views/auth-pages';
import { currentSession, rejectAuth, requireCsrf, requireSession, type UserRepo } from './guard';
import { createLimiters, type RateLimitConfig } from '../rate-limit';
import type { SessionStore } from './session-store';

export interface AuthDeps {
  logger: Pick<Logger, 'warn' | 'info'>;
  sessions: SessionStore;
  users: UserRepo;
  /** DASHBOARD_LINK_SECRET; unset rejects every link */
  linkSecret?: string;
  sessionTtlHours: number;
  /** Secure cookies everywhere but local development (plain http) */
  secureCookies: boolean;
  now: () => Date;
  /** Sign-in and sign-out request limits; defaults in rate-limit.ts */
  rateLimit?: Partial<RateLimitConfig>;
}

type Rejected =
  | Extract<MagicLinkResult, { ok: false }>
  | { ok: false; reason: 'disabled' | 'unknown_user'; tokenId: string | null };

/** Verifies the token, consumes it once and checks the user; a payload only when all pass. */
async function acceptLink(
  deps: AuthDeps,
  token: string | undefined
): Promise<{ ok: true; userId: string } | Rejected> {
  if (!deps.linkSecret) return { ok: false, reason: 'disabled', tokenId: null };
  const now = deps.now();
  const result = verifyMagicLink(token, deps.linkSecret, now);
  if (!result.ok) return result;

  const { jti, uid, exp } = result.payload;
  // The used-id key lives as long as the token could still verify
  const ttlSeconds = exp - Math.floor(now.getTime() / 1000) + 60;
  if (!(await deps.sessions.consumeToken(jti, ttlSeconds))) {
    return { ok: false, reason: 'replayed', tokenId: jti };
  }
  if (!(await deps.users.exists(uid))) return { ok: false, reason: 'unknown_user', tokenId: jti };
  return { ok: true, userId: uid };
}

export function authRouter(deps: AuthDeps): Router {
  const router = Router();
  const ttlSeconds = deps.sessionTtlHours * 3600;

  // Sign-in checks a signature and talks to Redis and the database: limit it per client
  router.use(['/auth', '/logout'], createLimiters(deps.logger, deps.rateLimit).auth);

  // GET /auth?t=<token>: the magic link from /dashboard. Success starts a session and
  // redirects, so the token leaves the address bar and history.
  router.get('/auth', async (req: Request, res: Response) => {
    const token = typeof req.query.t === 'string' ? req.query.t : undefined;
    const accepted = await acceptLink(deps, token);
    if (!accepted.ok) {
      rejectAuth(deps.logger, res, {
        reason: accepted.reason,
        tokenId: accepted.tokenId,
        path: req.path,
      });
      return;
    }
    // A link opened in a browser that is already signed in replaces that session
    const previous = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (previous) await deps.sessions.destroy(previous);

    const session = await deps.sessions.create(accepted.userId, ttlSeconds);
    deps.logger.info({ userId: accepted.userId }, 'dashboard session started');
    res.setHeader(
      'Set-Cookie',
      sessionCookie(session.id, { secure: deps.secureCookies, maxAgeSeconds: ttlSeconds })
    );
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, '/');
  });

  router.post(
    '/logout',
    requireSession(deps),
    requireCsrf(deps.logger),
    async (_req: Request, res: Response) => {
      await deps.sessions.destroy(currentSession(res).id);
      res.setHeader('Set-Cookie', clearSessionCookie(deps.secureCookies));
      sendHtml(res, 200, renderSignedOut());
    }
  );

  return router;
}
