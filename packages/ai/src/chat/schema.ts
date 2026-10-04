import { z } from 'zod';
import { CoachSuggestionSchema, structuredOutputSchema } from '../suggestion/schema';

/** A coach-chat reply: the answer, plus a suggestion only when the answer changes the plan. */
export const ChatReplySchema = z
  .object({
    reply: z.string().min(1),
    suggestion: CoachSuggestionSchema.nullable(),
  })
  .strict();
export type ChatReply = z.infer<typeof ChatReplySchema>;

/** JSON schema for `CompleteOptions.jsonSchema` of a chat reply. */
export function chatReplyJsonSchema(): Record<string, unknown> {
  return structuredOutputSchema(ChatReplySchema);
}
