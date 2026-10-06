import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { readCookie, safeEqual, SESSION_COOKIE, sendHtml } from '../http';
import { renderExpired } from '../views/auth-pages';
import type { SessionStore, WebSession } from './session-store';

export interface UserRepo {
  exists(userId: string): Promise<boolean>;
}

export interface GuardDeps {
  logger: Pick<Logger, 'warn'>;
  sessions: SessionStore;
  users: UserRepo;
}

export type AuthRejection = 'no_session' | 'unknown_session' | 'unknown_user';

/** Loud failure: one structured warning, the 401 "link expired" page, no athlete data. */
export function rejectAuth(
  logger: Pick<Logger, 'warn'>,
  res: Response,
  details: { reason: string; tokenId: string | null; path: string }
): void {
  logger.warn(details, 'dashboard auth rejected');
  sendHtml(res, 401, renderExpired());
}

/**
 * Lets a request through only with a live session of an existing user and puts the session
 * in `res.locals.session`. Handlers take the user id from there and nowhere else.
 */
export function requireSession(deps: GuardDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await resolveSession(deps, readCookie(req.headers.cookie, SESSION_COOKIE));
    if ('reason' in result) {
      rejectAuth(deps.logger, res, { reason: result.reason, tokenId: null, path: req.path });
      return;
    }
    res.locals.session = result.session;
    next();
  };
}

async function resolveSession(
  deps: GuardDeps,
  sessionId: string | undefined
): Promise<{ session: WebSession } | { reason: AuthRejection }> {
  if (!sessionId) return { reason: 'no_session' };
  const session = await deps.sessions.get(sessionId);
  if (!session) return { reason: 'unknown_session' };
  if (!(await deps.users.exists(session.userId))) return { reason: 'unknown_user' };
  return { session };
}

/** The session `requireSession` attached; throws when a route forgot the guard. */
export function currentSession(res: Response): WebSession {
  const session = res.locals.session as WebSession | undefined;
  if (!session) throw new Error('route is missing requireSession');
  return session;
}

/** POST forms must echo the session's CSRF token; a mismatch is a 403 and writes nothing. */
export function requireCsrf(logger: Pick<Logger, 'warn'>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = currentSession(res);
    const body = req.body as Record<string, unknown> | undefined;
    const token = typeof body?.csrf === 'string' ? body.csrf : '';
    if (!safeEqual(token, session.csrf)) {
      logger.warn({ userId: session.userId, path: req.path }, 'dashboard csrf rejected');
      sendHtml(res, 403, renderExpired());
      return;
    }
    next();
  };
}
