import { describe, it, expect, vi } from 'vitest';
import { IcuClient } from '../src/client';
import {
  IcuAuthError,
  IcuContractError,
  IcuHttpError,
  IcuRateLimitError,
  IcuServerError,
} from '../src/errors';
import athleteFixture from './fixtures/athlete.json';
import activitiesFixture from './fixtures/activities.json';
import wellnessFixture from './fixtures/wellness.json';
import eventsFixture from './fixtures/events.json';
import workoutEventFixture from './fixtures/workout-event.json';
import streamsFixture from './fixtures/activity-streams.json';

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
    // Typed optional metrics
    expect(result[0].moving_time).toBe(3600);
    expect(result[0].icu_training_load).toBe(62);
    expect(result[1].average_watts).toBeUndefined();
    // Unknown fields tolerated
    expect((result[0] as Record<string, unknown>).total_elevation_gain).toBe(500);
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

// ── getActivityStreams ────────────────────────────────────────────────────────

describe('IcuClient.getActivityStreams', () => {
  it('happy path: returns the requested streams, gaps as null', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(streamsFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.getActivityStreams('i987', ['time', 'watts', 'heartrate']);

    expect(result.map((s) => s.type)).toEqual(['time', 'watts', 'heartrate']);
    expect(result[1].data).toEqual([210, 215, null, 220, 225]);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/activity/i987/streams.json');
    expect(url).toContain('types=time%2Cwatts%2Cheartrate');
  });

  it('404 throws IcuHttpError without retrying', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(null, 404));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const err = await client.getActivityStreams('i987').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcuHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('object instead of array: throws IcuContractError', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ watts: [1] }));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const err = await client.getActivityStreams('i987').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcuContractError);
    expect((err as IcuContractError).endpoint).toBe('GET /activity/:id/streams');
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
    expect(result[0]).toMatchObject({ ctl: 52.3, atl: 58.1, hrv: 72, sleepSecs: 27000 });
    expect(result[1].weight).toBeUndefined();
    // Unknown fields tolerated
    expect((result[0] as Record<string, unknown>).rampRate).toBe(-0.8);
  });

  it('null metrics (no HRV strap) pass the contract', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: '2024-01-17', hrv: null, restingHR: null, ctl: 51 }]));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const [day] = await client.listWellness('2024-01-17', '2024-01-17');

    expect(day).toMatchObject({ hrv: null, restingHR: null, ctl: 51 });
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

  it('passes oldest/newest as query params when given', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(eventsFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    await client.listEvents('2026-01-01', '2026-01-31');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('oldest=2026-01-01');
    expect(url).toContain('newest=2026-01-31');
  });

  it('omits the query string when no range is given', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(eventsFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    await client.listEvents();

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://intervals.icu/api/v1/athlete/i12345/events');
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

describe('IcuClient.createEvent (workout)', () => {
  it('sends category, moving_time and external_id and parses the workout event', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(workoutEventFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const input = {
      category: 'WORKOUT',
      start_date_local: '2026-09-29T00:00:00',
      name: 'Run Intervals',
      type: 'Run',
      description: workoutEventFixture.description,
      moving_time: 3300,
      external_id: 'ta-p1',
    };
    const result = await client.createEvent(input);

    expect(result).toMatchObject({
      id: 2001,
      category: 'WORKOUT',
      type: 'Run',
      external_id: 'ta-p1',
      moving_time: 3300,
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(input);
  });
});

// ── getEvent ──────────────────────────────────────────────────────────────────

describe('IcuClient.getEvent', () => {
  it('happy path: returns the event by id', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(workoutEventFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.getEvent(2001);

    expect(result.id).toBe(2001);
    expect(result.description).toBe(workoutEventFixture.description);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://intervals.icu/api/v1/athlete/i12345/events/2001');
    expect(init.method).toBeUndefined();
  });

  it('404: throws IcuHttpError with status 404 and no retry', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const error: unknown = await client.getEvent(9999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IcuHttpError);
    expect((error as IcuHttpError).status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
});

describe('IcuClient server and http errors', () => {
  it('5xx × 4: throws IcuServerError after exhausting retries', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'Server Error' }, 503));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const err = await client.getAthlete().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcuServerError);
    expect((err as IcuServerError).status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('500 then 200: succeeds after one retry', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Server Error' }, 500))
      .mockResolvedValueOnce(jsonResponse(athleteFixture));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const result = await client.getAthlete();

    expect(result.id).toBe(athleteFixture.id);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('404: throws IcuHttpError with endpoint name, no retry', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
    const client = new IcuClient({ ...BASE_CONFIG, fetch: mockFetch });

    const err = await client.deleteEvent(999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcuHttpError);
    expect((err as IcuHttpError).status).toBe(404);
    expect((err as IcuHttpError).endpoint).toBe('DELETE /athlete/:id/events/:id');
    expect((err as IcuHttpError).body).toBe('Not Found');
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
