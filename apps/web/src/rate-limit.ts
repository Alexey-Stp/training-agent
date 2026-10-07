import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Logger } from 'pino';
import { sendHtml } from './http';
import { renderPage } from './views/layout';

export interface RateLimitConfig {
  windowMs: number;
  /** Requests per window and client for the sign-in and sign-out routes */
  authLimit: number;
  /** Requests per window and client for everything else */
  generalLimit: number;
}

/** 15 minutes; sign-in is rare, pages are tapped a lot (a Week → Today → Week trip is 3 hits) */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  authLimit: 20,
  generalLimit: 600,
};

function renderTooMany(): string {
  const body =
    '<div class="card notice bad"><h1>Too many requests</h1><p>Please wait a few minutes and try again.</p></div>';
  return renderPage({ title: 'Too many requests', body });
}

function limiter(
  limit: number,
  config: RateLimitConfig,
  logger: Pick<Logger, 'warn'>
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ path: req.path }, 'dashboard rate limited');
      sendHtml(res, 429, renderTooMany());
    },
  });
}

/**
 * Per-client counters kept in this process's memory: enough for one web instance. Running
 * several instances needs a shared store (e.g. rate-limit-redis) to count across them.
 */
export function createLimiters(
  logger: Pick<Logger, 'warn'>,
  config: Partial<RateLimitConfig> = {}
): { auth: RateLimitRequestHandler; general: RateLimitRequestHandler } {
  const merged = { ...DEFAULT_RATE_LIMIT, ...config };
  return {
    auth: limiter(merged.authLimit, merged, logger),
    general: limiter(merged.generalLimit, merged, logger),
  };
}
