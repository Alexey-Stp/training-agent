import { Intensity, Sport } from '@triathlon/core';
import { z } from 'zod';

export const COACH_ACTIONS = ['keep', 'reduce', 'swap', 'move', 'rest'] as const;
export type CoachAction = (typeof COACH_ACTIONS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const sessionId = z.string().min(1);
const isoDate = z.string().regex(ISO_DATE, 'expected YYYY-MM-DD');

/** One field of one planned session, before and after the change. */
export const SessionDiffSchema = z.discriminatedUnion('field', [
  z
    .object({
      sessionId,
      field: z.literal('durationMin'),
      before: z.number().int().min(0),
      // 0 cancels the session
      after: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      sessionId,
      field: z.literal('intensity'),
      before: z.enum(Intensity),
      after: z.enum(Intensity),
    })
    .strict(),
  z.object({ sessionId, field: z.literal('date'), before: isoDate, after: isoDate }).strict(),
  z
    .object({ sessionId, field: z.literal('sport'), before: z.enum(Sport), after: z.enum(Sport) })
    .strict(),
]);
export type SessionDiff = z.infer<typeof SessionDiffSchema>;
export type SessionDiffField = SessionDiff['field'];

export const CoachSuggestionSchema = z
  .object({
    assessment: z.string().min(1),
    action: z.enum(COACH_ACTIONS),
    changes: z.array(SessionDiffSchema),
    confidence: z.number().min(0).max(1),
    athleteMessage: z.string().min(1),
  })
  .strict();
export type CoachSuggestion = z.infer<typeof CoachSuggestionSchema>;

/** `sessionId` the LLM sees: the row's natural key, unique per user like `(date, slot)`. */
export function sessionKey(session: { date: string; slot: string }): string {
  return session.date + '/' + session.slot;
}

// Keywords structured outputs rejects. Zod still enforces them when the reply is parsed.
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key === 'oneOf' ? 'anyOf' : key] = stripUnsupported(value);
  }
  return out;
}

/** JSON schema of `schema` for `CompleteOptions.jsonSchema`, limited to what structured outputs accepts. */
export function structuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
  return stripUnsupported(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** JSON schema for `CompleteOptions.jsonSchema` of a daily suggestion. */
export function coachSuggestionJsonSchema(): Record<string, unknown> {
  return structuredOutputSchema(CoachSuggestionSchema);
}
