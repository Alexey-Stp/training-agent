import { randomBytes } from 'node:crypto';
import { encryptSecret } from '@triathlon/core';
import type { PlannedSessionDraft } from '@triathlon/core';
import { IcuHttpError } from '@triathlon/integrations-icu';
import type { CreateEventInput, IcuEvent, UpdateEventInput } from '@triathlon/integrations-icu';
import type { IcuConnectionRecord } from '../src/icu-connect';
import type { MarkPushedInput, PlanPushRepo } from '../src/plan-push';
import type { PlanReconcileRepo } from '../src/plan-reconcile';
import type { PlanDiff, PlannedSessionRecord, PlanStoreRepo } from '../src/plan-store';

export const USER_ID = 'user-1';
export const KEY = randomBytes(32);
export const API_KEY = 'secret-icu-api-key-123456';

/**
 * In-memory PlannedSession repo with the same conditional-write semantics as db.ts.
 * Every write bumps updatedAt so markPushed's "unchanged since read" check is exercised.
 */
export class MemoryPlanRepo implements PlanStoreRepo, PlanPushRepo, PlanReconcileRepo {
  readonly rows = new Map<string, PlannedSessionRecord>();
  connection: IcuConnectionRecord | null;
  /** Makes the next markPushed throw, simulating a crash after the ICU call. */
  failNextMarkPushed = false;
  private seq = 0;
  private clock = Date.parse('2026-09-28T00:00:00Z');

  constructor() {
    const enc = encryptSecret(API_KEY, KEY);
    this.connection = {
      userId: USER_ID,
      icuAthleteId: 'i12345',
      icuAthleteName: 'Jane Athlete',
      apiKeyCiphertext: enc.ciphertext,
      apiKeyIv: enc.iv,
      lastActivitySyncAt: null,
      lastWellnessSyncAt: null,
    };
  }

  private tick(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  private copy(row: PlannedSessionRecord): PlannedSessionRecord {
    return structuredClone(row);
  }

  private sorted(filter: (row: PlannedSessionRecord) => boolean): PlannedSessionRecord[] {
    return [...this.rows.values()]
      .filter(filter)
      .sort((a, b) => `${a.date}|${a.slot}`.localeCompare(`${b.date}|${b.slot}`))
      .map((row) => this.copy(row));
  }

  /** Test helper: the row stored for (date, slot). */
  get(date: string, slot: string): PlannedSessionRecord | undefined {
    return [...this.rows.values()].find((r) => r.date === date && r.slot === slot);
  }

  /** Test helper: inserts a row directly. */
  insert(
    draft: PlannedSessionDraft,
    fields: Partial<PlannedSessionRecord> = {}
  ): PlannedSessionRecord {
    const row: PlannedSessionRecord = {
      ...structuredClone(draft),
      id: `p${(++this.seq).toString()}`,
      userId: USER_ID,
      status: 'draft',
      icuEventId: null,
      pushedHash: null,
      externalChange: null,
      deletedAt: null,
      coachDecisionId: null,
      updatedAt: this.tick(),
      ...fields,
    };
    this.rows.set(row.id, row);
    return this.copy(row);
  }

  /** Test helper: changes a stored row, bumping updatedAt like any write. */
  update(id: string, fields: Partial<PlannedSessionRecord>): void {
    Object.assign(this.rows.get(id)!, structuredClone(fields), { updatedAt: this.tick() });
  }

  findConnection(userId: string) {
    return Promise.resolve(this.connection?.userId === userId ? this.connection : null);
  }

  listWindow(userId: string, from: string, to: string) {
    return Promise.resolve(
      this.sorted((r) => r.userId === userId && r.date >= from && r.date <= to)
    );
  }

  applyPlan(_userId: string, diff: PlanDiff, now: Date) {
    for (const d of diff.creates) {
      if (!this.get(d.date, d.slot)) this.insert(d);
    }
    for (const { id, data } of diff.updates) {
      const row = this.rows.get(id)!;
      Object.assign(row, structuredClone(data), {
        status: 'draft',
        deletedAt: null,
        updatedAt: this.tick(),
      });
    }
    for (const id of diff.softDeletes) {
      Object.assign(this.rows.get(id)!, { deletedAt: now, updatedAt: this.tick() });
    }
    for (const id of diff.hardDeletes) this.rows.delete(id);
    return Promise.resolve();
  }

  listPending(userId: string, fromDate: string) {
    return Promise.resolve(
      this.sorted(
        (r) =>
          r.userId === userId &&
          r.date >= fromDate &&
          (r.deletedAt !== null
            ? r.coachDecisionId === null || r.icuEventId !== null
            : r.status === 'draft')
      )
    );
  }

  markPushed(read: PlannedSessionRecord, { icuEventId, pushedHash }: MarkPushedInput) {
    if (this.failNextMarkPushed) {
      this.failNextMarkPushed = false;
      return Promise.reject(new Error('DB down'));
    }
    const row = this.rows.get(read.id)!;
    if (row.updatedAt.getTime() === read.updatedAt.getTime()) {
      Object.assign(row, {
        status: 'pushed',
        icuEventId,
        pushedHash,
        externalChange: null,
        updatedAt: this.tick(),
      });
    } else {
      Object.assign(row, { icuEventId, updatedAt: this.tick() });
    }
    return Promise.resolve();
  }

  remove(read: PlannedSessionRecord) {
    const row = this.rows.get(read.id);
    if (row?.deletedAt && row.coachDecisionId === null) this.rows.delete(read.id);
    else if (row)
      Object.assign(row, { icuEventId: null, pushedHash: null, updatedAt: this.tick() });
    return Promise.resolve();
  }

  flagExternal(id: string, expectedHash: string | null, reason: string) {
    const row = this.rows.get(id);
    if (row?.pushedHash !== expectedHash || row.deletedAt !== null) {
      return Promise.resolve(false);
    }
    Object.assign(row, {
      status: 'modified_externally',
      externalChange: reason,
      updatedAt: this.tick(),
    });
    return Promise.resolve(true);
  }

  listPushed(userId: string, fromDate: string) {
    return Promise.resolve(
      this.sorted(
        (r) =>
          r.userId === userId &&
          r.status === 'pushed' &&
          r.icuEventId !== null &&
          r.deletedAt === null &&
          r.date >= fromDate
      )
    );
  }

  listModifiedExternally(userId: string, fromDate: string) {
    return Promise.resolve(
      this.sorted(
        (r) => r.userId === userId && r.status === 'modified_externally' && r.date >= fromDate
      )
    );
  }
}

/** Fake intervals.icu calendar: assigns event ids, keeps external_id, 404s on unknown ids. */
export class FakeIcuCalendar {
  readonly events = new Map<number, IcuEvent>();
  private nextId = 5000;
  readonly calls: string[] = [];

  private notFound(endpoint: string): IcuHttpError {
    return new IcuHttpError(404, endpoint, '{"error":"Not found"}');
  }

  /** Test helper: what the athlete does in the ICU web app. */
  edit(eventId: number, change: Partial<IcuEvent>): void {
    Object.assign(this.events.get(eventId)!, change);
  }

  listEvents = (oldest?: string, newest?: string): Promise<IcuEvent[]> => {
    this.calls.push(`list ${oldest ?? ''}..${newest ?? ''}`);
    return Promise.resolve(
      [...this.events.values()]
        .filter((e) => {
          const date = e.start_date_local.slice(0, 10);
          return (!oldest || date >= oldest) && (!newest || date <= newest);
        })
        .map((e) => structuredClone(e))
    );
  };

  getEvent = (eventId: number): Promise<IcuEvent> => {
    this.calls.push(`get ${eventId.toString()}`);
    const event = this.events.get(eventId);
    return event
      ? Promise.resolve(structuredClone(event))
      : Promise.reject(this.notFound('GET /athlete/:id/events/:id'));
  };

  createEvent = (data: CreateEventInput): Promise<IcuEvent> => {
    const id = this.nextId++;
    this.calls.push(`create ${id.toString()}`);
    // ICU echoes the event back with its own fields added
    const event: IcuEvent = { ...structuredClone(data), id, icu_training_load: 50 };
    this.events.set(id, event);
    return Promise.resolve(structuredClone(event));
  };

  updateEvent = (eventId: number, data: UpdateEventInput): Promise<IcuEvent> => {
    this.calls.push(`update ${eventId.toString()}`);
    const event = this.events.get(eventId);
    if (!event) return Promise.reject(this.notFound('PUT /athlete/:id/events/:id'));
    Object.assign(event, structuredClone(data));
    return Promise.resolve(structuredClone(event));
  };

  deleteEvent = (eventId: number): Promise<void> => {
    this.calls.push(`delete ${eventId.toString()}`);
    if (!this.events.delete(eventId)) {
      return Promise.reject(this.notFound('DELETE /athlete/:id/events/:id'));
    }
    return Promise.resolve();
  };
}
