import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleSeasonDialog,
  HOUR_OPTIONS,
  INVALID_HOURS,
  INVALID_WEAK_SPORT,
  parseWizardCallback,
  PROMPT_HOURS,
  promptWeakSport,
  SEASON_CANCELLED,
  SUBMITTED,
  WIZARD_EXPIRED,
  type SeasonDialogOutcome,
  type SeasonDialogState,
  type SeasonDialogStore,
} from '../src/season-dialog';

class MemoryStore implements SeasonDialogStore {
  readonly states = new Map<number, SeasonDialogState>();
  get(id: number) {
    return Promise.resolve(this.states.get(id) ?? null);
  }
  set(id: number, state: SeasonDialogState) {
    this.states.set(id, state);
    return Promise.resolve();
  }
  delete(id: number) {
    this.states.delete(id);
    return Promise.resolve();
  }
}

const USER = 42;
let store: MemoryStore;

const text = (t: string) => handleSeasonDialog(USER, { kind: 'text', text: t }, store);
const tap = (data: string) => handleSeasonDialog(USER, { kind: 'callback', data }, store);

function buttons(outcome: SeasonDialogOutcome): string[] {
  return outcome.kind === 'reply' ? (outcome.keyboard ?? []).flat().map((b) => b.data) : [];
}

beforeEach(() => {
  store = new MemoryStore();
});

describe('season wizard', () => {
  it('passes through when no wizard is active', async () => {
    expect(await text('hello')).toEqual({ kind: 'pass' });
    expect(await text('/season show')).toEqual({ kind: 'pass' });
    expect(await text('/cancel')).toEqual({ kind: 'pass' });
    expect(store.states.size).toBe(0);
  });

  it('starts with the hours keyboard', async () => {
    const out = await text('/season new');
    expect(out).toMatchObject({ kind: 'reply', text: PROMPT_HOURS });
    expect(buttons(out)).toEqual(HOUR_OPTIONS.map((h) => `sn:h:${h.toString()}`));
    expect(store.states.get(USER)).toEqual({ step: 'hours' });
  });

  it('starts from the dashboard deep link (/start season_new)', async () => {
    const out = await text('/start season_new');
    expect(out).toMatchObject({ kind: 'reply', text: PROMPT_HOURS });
    expect(store.states.get(USER)).toEqual({ step: 'hours' });
  });

  it('leaves a plain /start to the worker', async () => {
    expect(await text('/start')).toEqual({ kind: 'pass' });
    expect(await text('/start something_else')).toEqual({ kind: 'pass' });
  });

  it('happy path with buttons: hours → weak sport → submit', async () => {
    await text('/season new');

    const second = await tap('sn:h:10');
    expect(second).toMatchObject({ kind: 'reply', text: promptWeakSport(10) });
    expect(buttons(second)).toEqual(['sn:w:swim', 'sn:w:bike', 'sn:w:run', 'sn:w:none']);
    expect(store.states.get(USER)).toEqual({ step: 'weakSport', hours: 10 });

    expect(await tap('sn:w:bike')).toEqual({
      kind: 'submit',
      text: SUBMITTED,
      args: ['10', 'bike'],
    });
    expect(store.states.size).toBe(0);
  });

  it('accepts typed answers', async () => {
    await text('/season new');
    expect(await text('7.5h')).toMatchObject({ kind: 'reply', text: promptWeakSport(7.5) });
    expect(await text('None')).toEqual({ kind: 'submit', text: SUBMITTED, args: ['7.5', 'none'] });
  });

  it('re-asks on invalid answers and keeps the step', async () => {
    await text('/season new');
    const badHours = await text('100');
    expect(badHours).toMatchObject({ kind: 'reply', text: INVALID_HOURS });
    expect(buttons(badHours)).toHaveLength(HOUR_OPTIONS.length);
    expect(store.states.get(USER)).toEqual({ step: 'hours' });

    await text('12');
    expect(await text('strength')).toMatchObject({ kind: 'reply', text: INVALID_WEAK_SPORT });
    expect(store.states.get(USER)).toEqual({ step: 'weakSport', hours: 12 });
  });

  it('rejects out-of-range hours from a forged button', async () => {
    await text('/season new');
    expect(await tap('sn:h:99')).toMatchObject({ kind: 'reply', text: INVALID_HOURS });
  });

  it('/cancel ends the wizard', async () => {
    await text('/season new');
    expect(await text('/cancel')).toEqual({ kind: 'reply', text: SEASON_CANCELLED });
    expect(store.states.size).toBe(0);
  });

  it('another command abandons the wizard and passes through', async () => {
    await text('/season new');
    await tap('sn:h:8');
    expect(await text('/plan')).toEqual({ kind: 'pass' });
    expect(store.states.size).toBe(0);
  });

  it('/season new restarts a wizard in progress', async () => {
    await text('/season new');
    await tap('sn:h:8');
    await text('/season new');
    expect(store.states.get(USER)).toEqual({ step: 'hours' });
  });

  it('answers a tap without an active wizard with "expired"', async () => {
    expect(await tap('sn:h:10')).toEqual({ kind: 'reply', text: WIZARD_EXPIRED });
    expect(await tap('sn:w:run')).toEqual({ kind: 'reply', text: WIZARD_EXPIRED });
  });

  it('answers a tap for the wrong step with "expired" and keeps the state', async () => {
    await text('/season new');
    expect(await tap('sn:w:run')).toEqual({ kind: 'reply', text: WIZARD_EXPIRED });
    expect(store.states.get(USER)).toEqual({ step: 'hours' });

    await tap('sn:h:10');
    // An hours button on the old message after moving on
    expect(await tap('sn:h:12')).toEqual({ kind: 'reply', text: WIZARD_EXPIRED });
    expect(store.states.get(USER)).toEqual({ step: 'weakSport', hours: 10 });
  });

  it('ignores callbacks that are not wizard buttons', async () => {
    await text('/season new');
    expect(await tap('sd:save:abc')).toEqual({ kind: 'pass' });
    expect(store.states.get(USER)).toEqual({ step: 'hours' });
  });
});

describe('parseWizardCallback', () => {
  it('parses wizard buttons only', () => {
    expect(parseWizardCallback('sn:h:10')).toEqual({ step: 'hours', value: '10' });
    expect(parseWizardCallback('sn:w:none')).toEqual({ step: 'weakSport', value: 'none' });
    expect(parseWizardCallback('sn:x:10')).toBeNull();
    expect(parseWizardCallback('sn:h:')).toBeNull();
    expect(parseWizardCallback('sn:h:10:extra')).toBeNull();
  });

  it('keeps every button within Telegram callback data limits', async () => {
    store = new MemoryStore();
    const all = [...buttons(await text('/season new')), ...buttons(await tap('sn:h:10'))];
    for (const data of all) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseWizardCallback(data)).not.toBeNull();
    }
  });
});
