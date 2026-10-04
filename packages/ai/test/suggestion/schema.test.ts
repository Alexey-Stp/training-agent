import { describe, expect, it } from 'vitest';
import { CoachSuggestionSchema, coachSuggestionJsonSchema, sessionKey } from '../../src';
import { REDUCE_SAT, suggestion } from './fixtures';

const UNSUPPORTED = ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'oneOf', '$schema'];

function keysOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(keysOf);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => [key, ...keysOf(value)]);
}

describe('CoachSuggestionSchema', () => {
  it('parses valid AI JSON into a typed suggestion', () => {
    const raw: unknown = JSON.parse(JSON.stringify(suggestion([REDUCE_SAT])));
    const parsed = CoachSuggestionSchema.parse(raw);
    expect(parsed.action).toBe('reduce');
    expect(parsed.changes[0]).toEqual(REDUCE_SAT);
  });

  it.each([
    ['confidence above 1', { confidence: 1.2 }],
    ['an unknown action', { action: 'sprint' }],
    ['an empty athlete message', { athleteMessage: '' }],
    ['an extra key', { mood: 'great' }],
  ])('rejects %s', (_label, overrides) => {
    expect(CoachSuggestionSchema.safeParse({ ...suggestion([]), ...overrides }).success).toBe(
      false
    );
  });

  it.each([
    ['an unknown field', { sessionId: 'x', field: 'title', before: 'a', after: 'b' }],
    ['a negative duration', { sessionId: 'x', field: 'durationMin', before: 60, after: -5 }],
    ['an unknown zone', { sessionId: 'x', field: 'intensity', before: 'z2', after: 'z6' }],
    ['a malformed date', { sessionId: 'x', field: 'date', before: '2026-10-05', after: '5.10.' }],
  ])('rejects a change with %s', (_label, change) => {
    const raw = { ...suggestion([]), changes: [change] };
    expect(CoachSuggestionSchema.safeParse(raw).success).toBe(false);
  });
});

describe('coachSuggestionJsonSchema', () => {
  it('only uses keywords structured outputs accepts', () => {
    const schema = coachSuggestionJsonSchema();
    const keys = new Set(keysOf(schema));
    expect(UNSUPPORTED.filter((k) => keys.has(k))).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('sessionKey', () => {
  it('joins date and slot', () => {
    expect(sessionKey({ date: '2026-10-05', slot: 'bike-1' })).toBe('2026-10-05/bike-1');
  });
});
