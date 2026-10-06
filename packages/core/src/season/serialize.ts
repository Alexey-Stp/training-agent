import { z } from 'zod';
import {
  RacePriority,
  RaceType,
  SeasonPlan,
  SeasonPlanStatus,
  TrainingBlock,
  TrainingBlockType,
  Race,
} from './types';
import { isIsoDate } from './validate';

const isoDate = z.string().refine(isIsoDate, { message: 'expected a yyyy-MM-dd date' });

export const raceSchema = z.object({
  date: isoDate,
  name: z.string().min(1),
  priority: z.enum(RacePriority),
  type: z.enum(RaceType),
  travelDate: isoDate.nullable().optional(),
}) satisfies z.ZodType<Race>;

export const trainingBlockSchema = z.object({
  order: z.number().int(),
  type: z.enum(TrainingBlockType),
  startDate: isoDate,
  weeks: z.number().int().min(1),
  focus: z.string(),
  targetWeeklyHours: z.number().nonnegative(),
  targetSwimM: z.number().int().nonnegative(),
  targetBikeH: z.number().nonnegative(),
  targetRunKm: z.number().nonnegative(),
  targetCtl: z.number().nonnegative().nullable(),
}) satisfies z.ZodType<TrainingBlock>;

export const seasonPlanSchema = z.object({
  startDate: isoDate,
  status: z.enum(SeasonPlanStatus),
  aRace: raceSchema.nullable(),
  blocks: z.array(trainingBlockSchema),
}) satisfies z.ZodType<SeasonPlan>;

export function serializeSeasonPlan(plan: SeasonPlan): string {
  return JSON.stringify(plan);
}

/** Parses JSON from `serializeSeasonPlan`. Throws a ZodError (or SyntaxError) on bad input. Checks shape only; run `validateSeasonPlan` for the block invariants. */
export function parseSeasonPlan(json: string): SeasonPlan {
  return seasonPlanSchema.parse(JSON.parse(json));
}
