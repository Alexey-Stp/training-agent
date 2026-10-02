import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Profile } from '@prisma/client';
import {
  parseSeasonDecision,
  RacePriority,
  RaceType,
  SeasonPlanStatus,
  type Race,
  type SeasonPlan,
} from '@triathlon/core';
import {
  handleSeason,
  handleSeasonCancel,
  handleSeasonConfirm,
  handleSeasonPreview,
  MSG_BAD_WIZARD_INPUT,
  MSG_DRAFT_DISCARDED,
  MSG_DRAFT_GONE,
  MSG_NO_A_RACE,
  MSG_NO_ACTIVE_SEASON,
  MSG_SEASON_USAGE,
  type ActivateDraftResult,
  type SeasonCommandDeps,
  type SeasonDraftInput,
  type SeasonStoreRepo,
} from '../src/season-command';
import type { RaceRecord, RaceRepo } from '../src/race-command';
import type { RichReply, Reply } from '../src/reply';
import { MSG_NO_PROFILE } from '../src/profile';

const USER_ID = 'user-1';
// Wed 2026-10-07 in Prague
const NOW = new Date('2026-10-07T10:00:00Z');

const PROFILE: Profile = {
  id: 'profile-1',
  userId: USER_ID,
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};
const USER = { id: USER_ID, profile: PROFILE };

const A_RACE: RaceRecord = {
  id: 'race-a',
  date: '2027-06-13',
  name: 'Prague <Olympic>',
  priority: RacePriority.A,
  type: RaceType.olympic,
};
const B_RACE: RaceRecord = {
  id: 'race-b',
  date: '2027-04-18',
  name: 'Brno Sprint',
  priority: RacePriority.B,
  type: RaceType.sprint,
};

interface StoredPlan extends SeasonDraftInput {
  id: string;
  userId: string;
  status: SeasonPlanStatus;
}

/** In-memory SeasonPlan store with db.ts semantics (one draft per user, conditional activation). */
class MemorySeasonRepo implements SeasonStoreRepo {
  readonly plans: StoredPlan[] = [];
  private seq = 0;

  constructor(private readonly races: RaceRecord[]) {}

  findActiveSeason(userId: string): Promise<SeasonPlan | null> {
    const plan = this.plans.find(
      (p) => p.userId === userId && p.status === SeasonPlanStatus.active
    );
    if (!plan) return Promise.resolve(null);
    const aRace: Race | null = this.races.find((r) => r.id === plan.aRaceId) ?? null;
    return Promise.resolve({
      startDate: plan.startDate,
      status: plan.status,
      aRace,
      blocks: plan.blocks,
    });
  }

  replaceDraft(userId: string, draft: SeasonDraftInput): Promise<string> {
    const others = this.plans.filter(
      (p) => !(p.userId === userId && p.status === SeasonPlanStatus.draft)
    );
    this.plans.splice(0, this.plans.length, ...others);
    const id = `plan${(++this.seq).toString()}`;
    this.plans.push({ ...structuredClone(draft), id, userId, status: SeasonPlanStatus.draft });
    return Promise.resolve(id);
  }

  activateDraft(userId: string, draftId: string, { replace }: { replace: boolean }) {
    const plan = this.plans.find((p) => p.id === draftId && p.userId === userId);
    let result: ActivateDraftResult;
    if (plan?.status === SeasonPlanStatus.active) result = { status: 'already_active' };
    else if (plan?.status !== SeasonPlanStatus.draft) result = { status: 'not_found' };
    else {
      const current = this.plans.filter(
        (p) => p.userId === userId && p.status === SeasonPlanStatus.active
      );
      if (current.length > 0 && !replace) result = { status: 'needs_replace' };
      else {
        current.forEach((p) => (p.status = SeasonPlanStatus.archived));
        plan.status = SeasonPlanStatus.active;
        result = { status: 'activated', replaced: current.length > 0 };
      }
    }
    return Promise.resolve(result);
  }

  deleteDraft(userId: string, draftId: string): Promise<boolean> {
    const i = this.plans.findIndex(
      (p) => p.id === draftId && p.userId === userId && p.status === SeasonPlanStatus.draft
    );
    if (i >= 0) this.plans.splice(i, 1);
    return Promise.resolve(i >= 0);
  }
}

let races: RaceRecord[];
let seasons: MemorySeasonRepo;
let hours: number;
let deps: SeasonCommandDeps & { publish: ReturnType<typeof vi.fn> };

function raceRepo(): RaceRepo {
  return {
    create: () => Promise.reject(new Error('not used')),
    listUpcoming: (_userId, fromDate) =>
      Promise.resolve(
        races.filter((r) => r.date >= fromDate).sort((a, b) => a.date.localeCompare(b.date))
      ),
  };
}

function rich(reply: Reply): RichReply {
  expect(typeof reply).toBe('object');
  return reply as RichReply;
}

/** Button labels and decoded decisions of a reply. */
function buttons(reply: Reply) {
  return (rich(reply).keyboard ?? [])
    .flat()
    .map((b) => ({ text: b.text, ...parseSeasonDecision(b.data) }));
}

async function preview(args = ['10', 'bike']) {
  return handleSeasonPreview(USER, args, deps);
}

async function saveSeason(): Promise<string> {
  const draftId = buttons(await preview())[0].draftId as string;
  await handleSeasonConfirm(USER, [draftId], deps);
  return draftId;
}

beforeEach(() => {
  races = [A_RACE, B_RACE];
  seasons = new MemorySeasonRepo(races);
  hours = 26; // 6.5 h/week over the last 4 weeks
  deps = {
    seasons,
    races: raceRepo(),
    loadTrainingHours: vi.fn(() => Promise.resolve(hours)),
    hasIcuConnection: () => Promise.resolve(true),
    publish: vi.fn(() => Promise.resolve()),
    onPublishError: vi.fn(),
    now: () => NOW,
  };
});

describe('handleSeasonPreview', () => {
  it('stores a draft and shows the block table with Save / Cancel', async () => {
    const reply = rich(await preview());

    expect(seasons.plans).toHaveLength(1);
    const [draft] = seasons.plans;
    expect(draft).toMatchObject({ status: SeasonPlanStatus.draft, aRaceId: 'race-a' });
    expect(reply.html).toBe(true);
    expect(reply.text).toContain('<pre>');
    expect(reply.text).toMatch(/# Type\s+Dates\s+Wk h\/wk Swim\s+Bike\s+Run/);
    for (const b of draft.blocks) expect(reply.text).toContain(b.type);
    // Dynamic text is escaped for HTML parse mode
    expect(reply.text).toContain('Prague &lt;Olympic&gt;');
    expect(reply.text).toContain('Current load: 6.5h/week');
    expect(reply.text).toContain('Brno Sprint');
    expect(buttons(reply)).toEqual([
      { text: '✅ Save season', decision: 'save', draftId: draft.id },
      { text: '✖ Cancel', decision: 'cancel', draftId: draft.id },
    ]);
    // Nothing is active until confirmed
    expect(await seasons.findActiveSeason(USER_ID)).toBeNull();
  });

  it('averages the last 4 weeks before today as current load', async () => {
    await preview();
    expect(deps.loadTrainingHours).toHaveBeenCalledWith(USER_ID, '2026-09-09', '2026-10-06');
  });

  it('assumes half the available hours when nothing was synced', async () => {
    hours = 0;
    expect(rich(await preview(['12', 'none'])).text).toContain('I assumed 6h/week');
  });

  it('replaces an earlier draft instead of piling them up', async () => {
    await preview();
    await preview(['8', 'run']);
    expect(seasons.plans).toHaveLength(1);
  });

  it('warns and offers Replace when a season is already active', async () => {
    await saveSeason();
    const reply = rich(await preview(['12', 'swim']));

    expect(reply.text).toContain('You already have an active season');
    expect(buttons(reply).map((b) => b.decision)).toEqual(['replace', 'cancel']);
  });

  it('asks for an A race first', async () => {
    races.splice(0, races.length, B_RACE);
    expect(await preview()).toBe(MSG_NO_A_RACE);
    expect(seasons.plans).toHaveLength(0);
  });

  it('explains a runway that is too short', async () => {
    races.splice(0, races.length, { ...A_RACE, date: '2026-10-25', type: RaceType.full });
    const reply = await preview();
    expect(reply).toMatch(/^❌ I can't build a season/);
    expect(seasons.plans).toHaveLength(0);
  });

  it('rejects malformed wizard answers', async () => {
    expect(await preview(['100', 'bike'])).toBe(MSG_BAD_WIZARD_INPUT);
    expect(await preview(['10', 'strength'])).toBe(MSG_BAD_WIZARD_INPUT);
    expect(await preview([])).toBe(MSG_BAD_WIZARD_INPUT);
    expect(await handleSeasonPreview({ id: USER_ID, profile: null }, ['10', 'bike'], deps)).toBe(
      MSG_NO_PROFILE
    );
  });
});

describe('handleSeasonConfirm', () => {
  it('activates the draft and queues a publish', async () => {
    const draftId = buttons(await preview())[0].draftId as string;
    const reply = await handleSeasonConfirm(USER, [draftId], deps);

    expect(reply).toMatch(/^✅ Season saved/);
    expect(seasons.plans[0].status).toBe(SeasonPlanStatus.active);
    expect(deps.publish).toHaveBeenCalledWith(USER_ID, draftId);
  });

  it('does not replace an active season without the Replace button', async () => {
    await saveSeason();
    const draftId = buttons(await preview(['12', 'swim']))[0].draftId as string;
    deps.publish.mockClear();

    const reply = await handleSeasonConfirm(USER, [draftId], deps);

    expect(buttons(reply).map((b) => [b.decision, b.draftId])).toEqual([
      ['replace', draftId],
      ['cancel', draftId],
    ]);
    expect(seasons.plans.map((p) => p.status)).toEqual([
      SeasonPlanStatus.active,
      SeasonPlanStatus.draft,
    ]);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('replaces the active season when Replace is confirmed', async () => {
    const oldId = await saveSeason();
    const draftId = buttons(await preview(['12', 'swim']))[0].draftId as string;

    const reply = await handleSeasonConfirm(USER, [draftId, 'replace'], deps);

    expect(reply).toMatch(/^♻️ Season replaced/);
    const status = Object.fromEntries(seasons.plans.map((p) => [p.id, p.status]));
    expect(status).toEqual({
      [oldId]: SeasonPlanStatus.archived,
      [draftId]: SeasonPlanStatus.active,
    });
    expect(deps.publish).toHaveBeenLastCalledWith(USER_ID, draftId);
  });

  it('answers a retried confirm without activating twice', async () => {
    const draftId = await saveSeason();
    deps.publish.mockClear();
    expect(await handleSeasonConfirm(USER, [draftId], deps)).toMatch(/^✅ Season saved/);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('refuses unknown, cancelled or foreign drafts', async () => {
    expect(await handleSeasonConfirm(USER, ['nope'], deps)).toBe(MSG_DRAFT_GONE);
    expect(await handleSeasonConfirm(USER, [], deps)).toBe(MSG_DRAFT_GONE);

    const draftId = buttons(await preview())[0].draftId as string;
    expect(await handleSeasonConfirm({ id: 'user-2', profile: PROFILE }, [draftId], deps)).toBe(
      MSG_DRAFT_GONE
    );
    await handleSeasonCancel(USER, [draftId], deps);
    expect(await handleSeasonConfirm(USER, [draftId], deps)).toBe(MSG_DRAFT_GONE);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('still reports success when queueing the publish fails', async () => {
    deps.publish.mockRejectedValueOnce(new Error('redis down'));
    const draftId = buttons(await preview())[0].draftId as string;
    expect(await handleSeasonConfirm(USER, [draftId], deps)).toMatch(/^✅ Season saved/);
    expect(seasons.plans[0].status).toBe(SeasonPlanStatus.active);
    expect(deps.onPublishError).toHaveBeenCalledWith(expect.any(Error), USER_ID);
  });

  it('points to /connect icu when intervals.icu is not linked', async () => {
    deps.hasIcuConnection = () => Promise.resolve(false);
    const draftId = buttons(await preview())[0].draftId as string;
    expect(await handleSeasonConfirm(USER, [draftId], deps)).toContain('/connect icu');
  });
});

describe('handleSeasonCancel', () => {
  it('discards the draft and leaves the active season alone', async () => {
    await saveSeason();
    const draftId = buttons(await preview(['12', 'swim']))[0].draftId as string;

    expect(await handleSeasonCancel(USER, [draftId], deps)).toBe(MSG_DRAFT_DISCARDED);
    expect(seasons.plans.map((p) => p.status)).toEqual([SeasonPlanStatus.active]);
    expect(await handleSeasonCancel(USER, [draftId], deps)).toBe(MSG_DRAFT_GONE);
  });
});

describe('/season show', () => {
  it('shows the active season table and where today is', async () => {
    await saveSeason();
    const reply = rich(await handleSeason(USER, ['show'], deps));
    expect(reply.text).toContain('Season plan: Prague &lt;Olympic&gt;');
    expect(reply.text).toContain('<pre>');
    // The plan starts on the Monday after today
    expect(reply.text).toMatch(/Starts Mon Oct 12, 2026|Now: block 1/);
  });

  it('explains how to create one when there is none', async () => {
    expect(await handleSeason(USER, ['show'], deps)).toBe(MSG_NO_ACTIVE_SEASON);
  });

  it('shows usage for anything else', async () => {
    expect(await handleSeason(USER, [], deps)).toBe(MSG_SEASON_USAGE);
    expect(await handleSeason(USER, ['new'], deps)).toBe(MSG_SEASON_USAGE);
  });
});
