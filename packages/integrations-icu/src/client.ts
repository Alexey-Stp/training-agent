import { z } from 'zod';
import {
  IcuAuthError,
  IcuContractError,
  IcuHttpError,
  IcuRateLimitError,
  IcuServerError,
} from './errors';
import {
  ActivityListSchema,
  AthleteSchema,
  EventListSchema,
  EventSchema,
  WellnessListSchema,
  type ActivityList,
  type Athlete,
  type CreateEventInput,
  type EventList,
  type IcuEvent,
  type UpdateEventInput,
  type WellnessList,
} from './schemas';

const ICU_BASE_URL = 'https://intervals.icu/api/v1';
const MAX_RETRIES = 3;

export interface IcuClientConfig {
  /** intervals.icu athlete ID, e.g. "i12345" */
  athleteId: string;
  /** Athlete API key (the password in HTTP basic auth) */
  apiKey: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Base delay (ms) for exponential backoff. Set to 0 in tests. Defaults to 1000. */
  baseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class IcuClient {
  private readonly athleteId: string;
  private readonly authHeader: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseDelayMs: number;

  constructor(config: IcuClientConfig) {
    this.athleteId = config.athleteId;
    // HTTP basic auth: username = "API_KEY", password = athlete API key
    this.authHeader = `Basic ${Buffer.from(`API_KEY:${config.apiKey}`).toString('base64')}`;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseDelayMs = config.baseDelayMs ?? 1000;
  }

  /**
   * Executes a fetch with exponential backoff retry on 429 / 5xx.
   * Throws IcuAuthError immediately on 401 (no retry).
   * Throws IcuRateLimitError (429) or IcuServerError (5xx) after MAX_RETRIES exhaustion.
   * Throws IcuHttpError on any other non-OK status.
   */
  private async executeWithRetry(
    url: string,
    endpoint: string,
    init?: RequestInit
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    };
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let lastStatus = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(Math.pow(2, attempt - 1) * this.baseDelayMs);
      }

      const response = await this.fetchFn(url, { ...init, headers });

      if (response.status === 401) {
        throw new IcuAuthError();
      }

      if (response.ok) {
        return response;
      }

      if (response.status === 429 || response.status >= 500) {
        lastStatus = response.status;
        continue;
      }

      // Other 4xx — not retriable
      const body = await response.text().catch(() => '');
      throw new IcuHttpError(response.status, endpoint, body);
    }

    if (lastStatus === 429) {
      throw new IcuRateLimitError();
    }
    throw new IcuServerError(lastStatus, MAX_RETRIES);
  }

  private async parseResponse<T>(
    response: Response,
    schema: z.ZodType<T>,
    endpoint: string
  ): Promise<T> {
    const json: unknown = await response.json();
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new IcuContractError(endpoint, result.error);
    }
    return result.data;
  }

  /** GET /athlete/:id */
  async getAthlete(): Promise<Athlete> {
    const endpoint = 'GET /athlete/:id';
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}`;
    const response = await this.executeWithRetry(url, endpoint);
    return this.parseResponse(response, AthleteSchema, endpoint);
  }

  /** GET /athlete/:id/activities?oldest=&newest= */
  async listActivities(oldest: string, newest: string): Promise<ActivityList> {
    const params = new URLSearchParams({ oldest, newest }).toString();
    const endpoint = 'GET /athlete/:id/activities';
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}/activities?${params}`;
    const response = await this.executeWithRetry(url, endpoint);
    return this.parseResponse(response, ActivityListSchema, endpoint);
  }

  /** GET /athlete/:id/wellness?oldest=&newest= */
  async listWellness(oldest: string, newest: string): Promise<WellnessList> {
    const params = new URLSearchParams({ oldest, newest }).toString();
    const endpoint = 'GET /athlete/:id/wellness';
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}/wellness?${params}`;
    const response = await this.executeWithRetry(url, endpoint);
    return this.parseResponse(response, WellnessListSchema, endpoint);
  }

  /** GET /athlete/:id/events?oldest=&newest= (both optional) */
  async listEvents(oldest?: string, newest?: string): Promise<EventList> {
    const endpoint = 'GET /athlete/:id/events';
    const params = new URLSearchParams();
    if (oldest !== undefined) params.set('oldest', oldest);
    if (newest !== undefined) params.set('newest', newest);
    const query = params.toString();
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}/events${query ? `?${query}` : ''}`;
    const response = await this.executeWithRetry(url, endpoint);
    return this.parseResponse(response, EventListSchema, endpoint);
  }

  /** GET /athlete/:id/events/:eventId. A missing event throws IcuHttpError with status 404. */
  async getEvent(eventId: number): Promise<IcuEvent> {
    const endpoint = 'GET /athlete/:id/events/:id';
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}/events/${eventId.toString()}`;
    const response = await this.executeWithRetry(url, endpoint);
    return this.parseResponse(response, EventSchema, endpoint);
  }

  /** POST /athlete/:id/events */
  async createEvent(data: CreateEventInput): Promise<IcuEvent> {
    const endpoint = 'POST /athlete/:id/events';
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}/events`;
    const response = await this.executeWithRetry(url, endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return this.parseResponse(response, EventSchema, endpoint);
  }

  /** PUT /athlete/:id/events/:eventId */
  async updateEvent(eventId: number, data: UpdateEventInput): Promise<IcuEvent> {
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}/events/${eventId.toString()}`;
    const endpoint = 'PUT /athlete/:id/events/:id';
    const response = await this.executeWithRetry(url, endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return this.parseResponse(response, EventSchema, endpoint);
  }

  /** DELETE /athlete/:id/events/:eventId */
  async deleteEvent(eventId: number): Promise<void> {
    const url = `${ICU_BASE_URL}/athlete/${this.athleteId}/events/${eventId.toString()}`;
    await this.executeWithRetry(url, 'DELETE /athlete/:id/events/:id', { method: 'DELETE' });
  }
}
