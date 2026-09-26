import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { decryptSecret } from '@triathlon/core';
import {
  CANCELLED,
  INVALID_API_KEY,
  INVALID_ATHLETE_ID,
  PROMPT_API_KEY,
  PROMPT_ATHLETE_ID,
  handleConnectDialog,
  type DialogState,
  type DialogStore,
} from '../src/connect-dialog';

class MemoryStore implements DialogStore {
  readonly states = new Map<number, DialogState>();
  get(id: number) {
    return Promise.resolve(this.states.get(id) ?? null);
  }
  set(id: number, state: DialogState) {
    this.states.set(id, state);
    return Promise.resolve();
  }
  delete(id: number) {
    this.states.delete(id);
    return Promise.resolve();
  }
}

const USER = 42;
const KEY = randomBytes(32);
const API_KEY = 'abcdef1234567890abcdef';

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

describe('handleConnectDialog', () => {
  it('passes through plain text and commands when no dialog is active', async () => {
    expect(await handleConnectDialog(USER, 'hello', store, KEY)).toEqual({ kind: 'pass' });
    expect(await handleConnectDialog(USER, '/plan', store, KEY)).toEqual({ kind: 'pass' });
    expect(await handleConnectDialog(USER, '/connect status', store, KEY)).toEqual({
      kind: 'pass',
    });
  });

  it('/connect icu starts the dialog and asks for the athlete ID', async () => {
    const out = await handleConnectDialog(USER, '/connect icu', store, KEY);
    expect(out).toEqual({ kind: 'reply', text: PROMPT_ATHLETE_ID });
    expect(store.states.get(USER)).toEqual({ step: 'athleteId' });
  });

  it('rejects an invalid athlete ID and stays on the same step', async () => {
    await handleConnectDialog(USER, '/connect icu', store, KEY);
    const out = await handleConnectDialog(USER, 'not an id', store, KEY);
    expect(out).toEqual({ kind: 'reply', text: INVALID_ATHLETE_ID });
    expect(store.states.get(USER)).toEqual({ step: 'athleteId' });
  });

  it('normalises the athlete ID to the i-prefixed form', async () => {
    await handleConnectDialog(USER, '/connect icu', store, KEY);
    const out = await handleConnectDialog(USER, ' 12345 ', store, KEY);
    expect(out).toEqual({ kind: 'reply', text: PROMPT_API_KEY });
    expect(store.states.get(USER)).toEqual({ step: 'apiKey', athleteId: 'i12345' });
  });

  it('API key step returns encrypted credentials and clears the state', async () => {
    await handleConnectDialog(USER, '/connect icu', store, KEY);
    await handleConnectDialog(USER, 'i12345', store, KEY);
    const out = await handleConnectDialog(USER, API_KEY, store, KEY);

    expect(out.kind).toBe('submit');
    if (out.kind !== 'submit') return;
    expect(out.credentials.athleteId).toBe('i12345');
    expect(out.credentials.apiKeyCiphertext).not.toContain(API_KEY);
    expect(JSON.stringify(out)).not.toContain(API_KEY);
    expect(
      decryptSecret(
        { ciphertext: out.credentials.apiKeyCiphertext, iv: out.credentials.apiKeyIv },
        KEY
      )
    ).toBe(API_KEY);
    expect(store.states.has(USER)).toBe(false);
  });

  it('rejects an API key with whitespace without echoing it back', async () => {
    await handleConnectDialog(USER, '/connect icu', store, KEY);
    await handleConnectDialog(USER, 'i12345', store, KEY);
    const out = await handleConnectDialog(USER, 'two words', store, KEY);
    expect(out).toEqual({ kind: 'reply', text: INVALID_API_KEY });
    expect(store.states.get(USER)).toEqual({ step: 'apiKey', athleteId: 'i12345' });
  });

  it('/cancel clears an active dialog', async () => {
    await handleConnectDialog(USER, '/connect icu', store, KEY);
    const out = await handleConnectDialog(USER, '/cancel', store, KEY);
    expect(out).toEqual({ kind: 'reply', text: CANCELLED });
    expect(store.states.has(USER)).toBe(false);
  });

  it('another command abandons the dialog and passes through', async () => {
    await handleConnectDialog(USER, '/connect icu', store, KEY);
    const out = await handleConnectDialog(USER, '/plan', store, KEY);
    expect(out).toEqual({ kind: 'pass' });
    expect(store.states.has(USER)).toBe(false);
  });
});
