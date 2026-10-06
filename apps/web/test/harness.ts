import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { signMagicLink } from '@triathlon/core';
import { createApp, type AppDeps } from '../src/app';
import { newSessionId, type SessionStore, type WebSession } from '../src/auth/session-store';

export const SECRET = 'test-secret-'.padEnd(40, 'x');
export const NOW = new Date('2026-10-06T08:00:00Z');

/** In-memory SessionStore; TTLs are ignored (tests control the clock through the token). */
export class MemorySessionStore implements SessionStore {
  readonly used = new Set<string>();
  readonly sessions = new Map<string, WebSession>();

  consumeToken(jti: string): Promise<boolean> {
    if (this.used.has(jti)) return Promise.resolve(false);
    this.used.add(jti);
    return Promise.resolve(true);
  }

  create(userId: string): Promise<WebSession> {
    const session = { id: newSessionId(), userId, csrf: 'csrf-' + userId };
    this.sessions.set(session.id, session);
    return Promise.resolve(session);
  }

  get(id: string): Promise<WebSession | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  destroy(id: string): Promise<void> {
    this.sessions.delete(id);
    return Promise.resolve();
  }
}

export interface LogEntry {
  level: 'warn' | 'info' | 'error';
  details: unknown;
  message: string;
}

export function recordingLogger(): AppDeps['logger'] & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const log =
    (level: LogEntry['level']) =>
    (details: unknown, message = ''): void => {
      entries.push({ level, details, message });
    };
  return {
    entries,
    warn: log('warn'),
    info: log('info'),
    error: log('error'),
  } as AppDeps['logger'] & {
    entries: LogEntry[];
  };
}

export interface Harness {
  baseUrl: string;
  deps: AppDeps;
  sessions: MemorySessionStore;
  logger: ReturnType<typeof recordingLogger>;
  close(): Promise<void>;
}

/** Starts the app on an ephemeral port with in-memory fakes; overrides replace any dep. */
export async function startApp(
  users: readonly string[],
  overrides: Partial<AppDeps> = {}
): Promise<Harness> {
  const sessions = new MemorySessionStore();
  const logger = recordingLogger();
  const known = new Set(users);
  const deps: AppDeps = {
    logger,
    sessions,
    users: { exists: (id) => Promise.resolve(known.has(id)) },
    linkSecret: SECRET,
    sessionTtlHours: 24,
    secureCookies: false,
    now: () => NOW,
    ...overrides,
  };
  const server: Server = await new Promise((resolve) => {
    const s = createApp(deps).listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: 'http://127.0.0.1:' + String(port),
    deps,
    sessions,
    logger,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function tokenFor(userId: string, secret = SECRET, now = NOW): string {
  return signMagicLink(userId, secret, 15, now).token;
}

/** Signs in through /auth and returns the session cookie header value. */
export async function signIn(h: Harness, userId: string): Promise<string> {
  const res = await fetch(h.baseUrl + '/auth?t=' + tokenFor(userId), { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie');
  if (res.status !== 303 || !cookie) throw new Error('sign-in failed: ' + String(res.status));
  return cookie.split(';')[0];
}

export function get(h: Harness, path: string, cookie?: string): Promise<Response> {
  return fetch(h.baseUrl + path, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}

export function post(
  h: Harness,
  path: string,
  form: Record<string, string | string[]>,
  cookie?: string
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
  }
  return fetch(h.baseUrl + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body,
  });
}
