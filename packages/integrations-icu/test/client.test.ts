import { describe, it, expect, vi } from 'vitest';
import { IcuClient } from '../src/client';
import { IcuAuthError, IcuContractError, IcuRateLimitError } from '../src/errors';
import athleteFixture from './fixtures/athlete.json';
import activitiesFixture from './fixtures/activities.json';
import wellnessFixture from './fixtures/wellness.json';
import eventsFixture from './fixtures/events.json';

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE_CONFIG = {
  athleteId: 'i12345',
  apiKey: 'test-api-key',
  baseDelayMs: 0,
} as const;

// ── getAthlete ────────────────────────────────────────────────────────────────

describe('IcuClient.getAthlete', () => {
  it('happy path: returns typed athlete and tolerates unknown fields', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(athleteFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.getAthlete();

    expect(result.id).toBe(athleteFixture.id);
    expect(result.name).toBe(athleteFixture.name);
    // Unknown fields are kept via .passthrough()
    expect((result as Record<string, unknown>).email).toBe(athleteFixture.email);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/athlete/i12345');
  });
});

// ── listActivities ────────────────────────────────────────────────────────────

describe('IcuClient.listActivities', () => {
  it('happy path: returns typed activities array', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(activitiesFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.listActivities('2024-01-01', '2024-01-31');

    expect(result).toHaveLength(activitiesFixture.length);
    expect(result[0].id).toBe(activitiesFixture[0].id);
    expect(result[0].type).toBe(activitiesFixture[0].type);
    // Unknown fields tolerated
    expect((result[0] as Record<string, unknown>).average_watts).toBe(220);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('oldest=2024-01-01');
    expect(url).toContain('newest=2024-01-31');
  });

  it('429 then 200: succeeds after one retry and asserts retry count', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, 429))
      .mockResolvedValueOnce(jsonResponse(activitiesFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.listActivities('2024-01-01', '2024-01-31');

    expect(result).toHaveLength(activitiesFixture.length);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 failed + 1 successful
  });
});

// ── listWellness ──────────────────────────────────────────────────────────────

describe('IcuClient.listWellness', () => {
  it('happy path: returns typed wellness array', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(wellnessFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.listWellness('2024-01-15', '2024-01-16');

    expect(result).toHaveLength(wellnessFixture.length);
    expect(result[0].id).toBe(wellnessFixture[0].id);
    // Unknown fields tolerated
    expect((result[0] as Record<string, unknown>).ctl).toBe(52.3);
  });
});

// ── listEvents ────────────────────────────────────────────────────────────────

describe('IcuClient.listEvents', () => {
  it('happy path: returns typed events array', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(eventsFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.listEvents();

    expect(result).toHaveLength(eventsFixture.length);
    expect(result[0].id).toBe(eventsFixture[0].id);
    expect(result[0].name).toBe(eventsFixture[0].name);
  });
});

// ── createEvent ───────────────────────────────────────────────────────────────

describe('IcuClient.createEvent', () => {
  it('happy path: posts body and returns created event', async () => {
    const created = eventsFixture[0];
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(created));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const input = { start_date_local: '2024-01-20', name: 'Sprint Race A', type: 'Race' };
    const result = await client.createEvent(input);

    expect(result.id).toBe(created.id);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/events');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject(input);
  });
});

// ── updateEvent ───────────────────────────────────────────────────────────────

describe('IcuClient.updateEvent', () => {
  it('happy path: sends PUT with partial body and returns updated event', async () => {
    const updated = { ...eventsFixture[0], name: 'Updated Name' };
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(updated));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.updateEvent(1001, { name: 'Updated Name' });

    expect(result.name).toBe('Updated Name');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/events/1001');
    expect(init.method).toBe('PUT');
  });
});

// ── deleteEvent ───────────────────────────────────────────────────────────────

describe('IcuClient.deleteEvent', () => {
  it('happy path: sends DELETE and resolves void', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    await expect(client.deleteEvent(1001)).resolves.toBeUndefined();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/events/1001');
    expect(init.method).toBe('DELETE');
  });
});

// ── Auth errors ───────────────────────────────────────────────────────────────

describe('IcuClient auth errors', () => {
  it('401: throws IcuAuthError immediately with zero retries', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    await expect(client.getAthlete()).rejects.toThrow(IcuAuthError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retries
  });

  it('IcuAuthError has correct name', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    try {
      await client.getAthlete();
    } catch (e) {
      expect(e).toBeInstanceOf(IcuAuthError);
      expect((e as IcuAuthError).name).toBe('IcuAuthError');
      expect((e as IcuAuthError).status).toBe(401);
    }
  });
});

// ── Rate limit errors ─────────────────────────────────────────────────────────

describe('IcuClient rate limit errors', () => {
  it('429 × 4: throws IcuRateLimitError after 3 retries (4 total attempts)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(null, 429));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    await expect(client.getAthlete()).rejects.toThrow(IcuRateLimitError);
    expect(mockFetch).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('5xx × 4: throws after exhausting retries', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'Server Error' }, 503));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    await expect(client.getAthlete()).rejects.toThrow(IcuRateLimitError);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

// ── Contract errors ───────────────────────────────────────────────────────────

describe('IcuClient contract errors', () => {
  it('malformed athlete response: throws IcuContractError with endpoint name', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ unexpected: 'shape' }));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const err = await client.getAthlete().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcuContractError);
    expect((err as IcuContractError).endpoint).toBe('GET /athlete/:id');
    expect((err as IcuContractError).zodError).toBeDefined();
  });

  it('activities endpoint receives object instead of array: throws IcuContractError', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ not: 'an-array' }));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const err = await client.listActivities('2024-01-01', '2024-01-31').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcuContractError);
    expect((err as IcuContractError).endpoint).toBe('GET /athlete/:id/activities');
  });

  it('wellness endpoint receives object instead of array: throws IcuContractError', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ wrong: true }));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const err = await client.listWellness('2024-01-01', '2024-01-31').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcuContractError);
    expect((err as IcuContractError).endpoint).toBe('GET /athlete/:id/wellness');
  });
});

// ── Auth header ───────────────────────────────────────────────────────────────

describe('IcuClient auth header', () => {
  it('sends correct Basic auth header with API_KEY prefix', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(athleteFixture));
    const client = new IcuClient({ ...BASE_CONFIG, apiKey: 'my-secret-key', fetch: mockFetch });

    await client.getAthlete();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('API_KEY:my-secret-key').toString('base64')}`;
    expect(headers['Authorization']).toBe(expected);
  });
});
