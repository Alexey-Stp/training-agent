import { afterEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createDashboardReadRepo, createUserRepo } from '../src/db';
import { get, signIn, startApp, type Harness } from './harness';

/**
 * A Prisma client stand-in that answers the read calls the dashboard repos make and records
 * every call. Any other method (create, update, upsert, delete*, raw SQL) is recorded as a
 * write and throws, so a write slipping into Today/Week fails loudly.
 */
interface Call {
  model: string;
  method: string;
  args: { where?: Record<string, unknown> } | undefined;
}

const READS: Record<string, Record<string, (args: unknown) => unknown>> = {
  user: { findUnique: () => ({ id: 'user-a' }) },
  profile: { findUnique: () => ({ timezone: 'Europe/Prague' }) },
  plannedSession: {
    findMany: () => [
      {
        id: 'ps1',
        userId: 'user-a',
        date: '2026-10-06',
        slot: 'bike-0',
        sport: 'bike',
        title: 'Endurance ride',
        description: null,
        durationMin: 60,
        intensity: 'z2',
        steps: [{ kind: 'steady', durationMin: 60, zone: 'z2' }],
        status: 'pushed',
        externalChange: null,
        deviationPct: null,
        actualIntensity: null,
        activity: null,
      },
    ],
  },
  seasonPlan: { findFirst: () => ({ id: 'season-1' }) },
  wellness: { findMany: () => [] },
};

function recordingClient(): { client: PrismaClient; calls: Call[]; writes: Call[] } {
  const calls: Call[] = [];
  const writes: Call[] = [];
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => (args: Call['args']) => {
          const call = { model, method, args };
          const read = READS[model]?.[method];
          if (!read) {
            writes.push(call);
            return Promise.reject(new Error('write attempted: ' + model + '.' + method));
          }
          calls.push(call);
          return Promise.resolve(read(args));
        },
      }
    );
  const client = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop.startsWith('$')) {
          return () => {
            writes.push({ model: '$client', method: prop, args: undefined });
            return Promise.reject(new Error('raw access attempted: ' + prop));
          };
        }
        return delegate(prop);
      },
    }
  ) as unknown as PrismaClient;
  return { client, calls, writes };
}

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('read-only guarantee (Prisma repos)', () => {
  it('any number of Today/Week loads issues zero writes', async () => {
    const { client, calls, writes } = recordingClient();
    h = await startApp(['user-a'], {
      reads: createDashboardReadRepo(client),
      users: createUserRepo(client),
    });
    const cookie = await signIn(h, 'user-a');
    const paths = ['/', '/today?date=2026-10-08', '/week', '/week?week=2026-W42'];
    const pages = await Promise.all(
      Array.from({ length: 10 }, () => paths.map((p) => get(h as Harness, p, cookie))).flat()
    );
    expect(pages.every((res) => res.status === 200)).toBe(true);
    expect(writes).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('scopes every training-data query by the signed-in user', async () => {
    const { client, calls } = recordingClient();
    h = await startApp(['user-a'], {
      reads: createDashboardReadRepo(client),
      users: createUserRepo(client),
    });
    const cookie = await signIn(h, 'user-a');
    await get(h, '/', cookie);
    await get(h, '/week', cookie);
    const training = calls.filter((c) => c.model !== 'user');
    expect(training.length).toBeGreaterThan(0);
    for (const call of training) expect(call.args?.where?.userId).toBe('user-a');
  });

  it('never reads tombstoned sessions', async () => {
    const { client, calls } = recordingClient();
    await createDashboardReadRepo(client).findSessions('user-a', '2026-10-05', '2026-10-11');
    expect(calls[0].args?.where).toMatchObject({ userId: 'user-a', deletedAt: null });
  });
});
