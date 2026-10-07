import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Intensity, signMagicLink, Sport } from '@triathlon/core';
import { createApp, type AppDeps } from '../src/app';
import { newSessionId, type SessionStore, type WebSession } from '../src/auth/session-store';
import type { SettingsRepo, SettingsView } from '../src/settings/store';
import type { ProfileSettings } from '../src/settings/validate';
import type { DashboardReadRepo, DaySession, WellnessDay } from '../src/plan/read-store';

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
    settings: new MemorySettingsRepo(),
    reads: new MemoryReadRepo(),
    chats: { verify: () => Promise.resolve({ ok: true }) },
    events: { changed: () => Promise.resolve() },
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
  // Sign with the app's own clock: the Postgres integration test runs on the real one
  const token = tokenFor(userId, SECRET, h.deps.now());
  const res = await fetch(h.baseUrl + '/auth?t=' + token, { redirect: 'manual' });
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

export function defaultSettings(telegramId: string): SettingsView {
  return {
    ftp: 355,
    lthr: null,
    timezone: 'Europe/Prague',
    briefTime: null,
    closeoutTime: null,
    swimDays: ['Wed', 'Fri', 'Sun_optional'],
    bikeVo2Day: 'Thu',
    longBikeDay: 'Sun',
    noLongRunDay: 'Sun',
    notifyChatId: null,
    telegramId,
  };
}

/** Profiles by userId; `writes` counts every save (the read-only checks assert on it). */
export class MemorySettingsRepo implements SettingsRepo {
  readonly profiles = new Map<string, SettingsView>();
  writes = 0;

  load(userId: string): Promise<SettingsView | null> {
    const p = this.profiles.get(userId);
    return Promise.resolve(p ? { ...p, swimDays: [...p.swimDays] } : null);
  }

  save(userId: string, settings: ProfileSettings): Promise<void> {
    const current = this.profiles.get(userId);
    if (!current) return Promise.reject(new Error('no profile'));
    this.writes += 1;
    this.profiles.set(userId, { ...current, ...settings });
    return Promise.resolve();
  }
}

/**
 * Training data per user. Holds only what the read interface can return; there is nothing to
 * write through, and `calls` counts reads (isolation tests check the userId of each).
 */
export class MemoryReadRepo implements DashboardReadRepo {
  readonly timezones = new Map<string, string>();
  readonly sessions = new Map<string, DaySession[]>();
  readonly wellness = new Map<string, WellnessDay[]>();
  readonly activeSeasons = new Set<string>();
  readonly calls: { method: string; userId: string }[] = [];

  findTimezone(userId: string): Promise<string | null> {
    this.calls.push({ method: 'findTimezone', userId });
    return Promise.resolve(this.timezones.get(userId) ?? null);
  }

  findSessions(userId: string, from: string, to: string): Promise<DaySession[]> {
    this.calls.push({ method: 'findSessions', userId });
    const rows = (this.sessions.get(userId) ?? []).filter((s) => s.date >= from && s.date <= to);
    return Promise.resolve(
      [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot))
    );
  }

  hasActiveSeason(userId: string): Promise<boolean> {
    this.calls.push({ method: 'hasActiveSeason', userId });
    return Promise.resolve(this.activeSeasons.has(userId));
  }

  findWellness(userId: string, from: string, to: string): Promise<WellnessDay[]> {
    this.calls.push({ method: 'findWellness', userId });
    const rows = (this.wellness.get(userId) ?? []).filter((w) => w.date >= from && w.date <= to);
    return Promise.resolve([...rows].sort((a, b) => a.date.localeCompare(b.date)));
  }
}

/** A planned session row with sensible defaults (bike Z2, pushed, no activity). */
export function session(overrides: Partial<DaySession> & { date: string }): DaySession {
  return {
    id: 'ps-' + overrides.date + '-' + (overrides.slot ?? 'bike-0'),
    slot: 'bike-0',
    sport: Sport.bike,
    title: 'Endurance ride',
    description: null,
    durationMin: 60,
    intensity: Intensity.z2,
    steps: [{ kind: 'steady', durationMin: 60, zone: Intensity.z2 }],
    status: 'pushed',
    externalChange: null,
    deviationPct: null,
    actualIntensity: null,
    activity: null,
    ...overrides,
  };
}
