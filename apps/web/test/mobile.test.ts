import { afterEach, describe, expect, it } from 'vitest';
import { Intensity } from '@triathlon/core';
import { STYLESHEET } from '../src/views/style';
import {
  defaultSettings,
  get,
  MemoryReadRepo,
  MemorySettingsRepo,
  session,
  signIn,
  startApp,
  type Harness,
} from './harness';

/**
 * Mobile budget: pages are small, script-free and fluid. This is a fast CI proxy for the
 * Lighthouse mobile run (see README); it cannot replace a real device check.
 */
const PAGE_BUDGET_BYTES = 30 * 1024;

let h: Harness;

afterEach(async () => {
  await h.close();
});

async function pages(): Promise<{ path: string; html: string }[]> {
  const reads = new MemoryReadRepo();
  reads.timezones.set('user-a', 'Europe/Prague');
  reads.sessions.set(
    'user-a',
    Array.from({ length: 7 }, (_, i) =>
      session({
        date: '2026-10-0' + String(5 + Math.min(i, 4)),
        slot: 'bike-' + String(i),
        title: 'A rather long session title that has to wrap on a small phone screen ' + String(i),
        steps: [
          { kind: 'warmup', durationMin: 15, zone: Intensity.z2 },
          {
            kind: 'repeat',
            count: 6,
            work: { durationMin: 4, zone: Intensity.z4 },
            rest: { durationMin: 2, zone: Intensity.z1 },
          },
          { kind: 'cooldown', durationMin: 10, zone: Intensity.z1 },
        ],
      })
    )
  );
  const settings = new MemorySettingsRepo();
  settings.profiles.set('user-a', defaultSettings('1001'));
  h = await startApp(['user-a'], { reads, settings });
  const cookie = await signIn(h, 'user-a');
  return Promise.all(
    ['/', '/today?date=2026-10-09', '/week', '/settings'].map(async (path) => ({
      path,
      html: await (await get(h, path, cookie)).text(),
    }))
  );
}

describe('mobile budget', () => {
  it('keeps every page plus the stylesheet under the byte budget, with no scripts', async () => {
    for (const { path, html } of await pages()) {
      const bytes = Buffer.byteLength(html) + Buffer.byteLength(STYLESHEET);
      expect(bytes, path).toBeLessThan(PAGE_BUDGET_BYTES);
      expect(html, path).not.toMatch(/<script/i);
      expect(html, path).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
      );
      expect(html, path).toContain('<html lang="en">');
    }
  });

  it('uses no fixed widths wider than a ~390px phone and wraps long words', () => {
    const fixed = [...STYLESHEET.matchAll(/(?:^|[;{])\s*(?:min-)?width:\s*(\d+)px/g)].map((m) =>
      Number(m[1])
    );
    expect(fixed.every((px) => px <= 390)).toBe(true);
    expect(STYLESHEET).toContain('overflow-wrap:anywhere');
    expect(STYLESHEET).toContain('grid-template-columns:repeat(7,minmax(0,1fr))');
  });

  it('labels every form field', async () => {
    const settings = (await pages()).find((p) => p.path === '/settings')?.html ?? '';
    const ids = [...settings.matchAll(/<(?:input|select) id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(settings).toContain('<label for="' + id + '">');
  });
});
