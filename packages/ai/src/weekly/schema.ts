import { z } from 'zod';
import { SessionDiffSchema, structuredOutputSchema } from '../suggestion/schema';

/** Smallest and largest factor a `scale_volume` block adjustment may apply to next week */
export const MIN_VOLUME_FACTOR = 0.6;
export const MAX_VOLUME_FACTOR = 1.08;

/** Scales every changeable session of next week by `factor` instead of naming single sessions. */
export const BlockAdjustmentSchema = z
  .object({
    kind: z.literal('scale_volume'),
    factor: z.number().min(MIN_VOLUME_FACTOR).max(MAX_VOLUME_FACTOR),
    reason: z.string().min(1),
  })
  .strict();
export type BlockAdjustment = z.infer<typeof BlockAdjustmentSchema>;

export const WeeklyReviewSchema = z
  .object({
    summary: z.string().min(1),
    wins: z.array(z.string().min(1)),
    concerns: z.array(z.string().min(1)),
    nextWeekChanges: z.array(SessionDiffSchema),
    blockAdjustment: BlockAdjustmentSchema.nullable(),
  })
  .strict();
export type WeeklyReview = z.infer<typeof WeeklyReviewSchema>;

/** JSON schema for `CompleteOptions.jsonSchema` of a weekly review. */
export function weeklyReviewJsonSchema(): Record<string, unknown> {
  return structuredOutputSchema(WeeklyReviewSchema);
}
