import { z } from 'zod';
import { structuredOutputSchema } from '../suggestion/schema';

export const BlockReviewSchema = z
  .object({
    summary: z.string().min(1),
    wins: z.array(z.string().min(1)),
    concerns: z.array(z.string().min(1)),
    /** `reproject` applies the proposed re-projection of the remaining blocks */
    recommendation: z.enum(['keep', 'reproject']),
    reason: z.string().min(1),
  })
  .strict();
export type BlockReview = z.infer<typeof BlockReviewSchema>;

/** JSON schema for `CompleteOptions.jsonSchema` of a block review. */
export function blockReviewJsonSchema(): Record<string, unknown> {
  return structuredOutputSchema(BlockReviewSchema);
}
