import { z } from 'zod';

// ── Athlete ──────────────────────────────────────────────────────────────────

export const AthleteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

export type Athlete = z.infer<typeof AthleteSchema>;

// ── Activities ────────────────────────────────────────────────────────────────

export const ActivitySchema = z
  .object({
    id: z.string(),
    start_date_local: z.string(),
    type: z.string(),
    name: z.string(),
  })
  .passthrough();

export type Activity = z.infer<typeof ActivitySchema>;

export const ActivityListSchema = z.array(ActivitySchema);
export type ActivityList = z.infer<typeof ActivityListSchema>;

// ── Wellness ──────────────────────────────────────────────────────────────────

export const WellnessSchema = z
  .object({
    id: z.string(), // YYYY-MM-DD date key
  })
  .passthrough();

export type Wellness = z.infer<typeof WellnessSchema>;

export const WellnessListSchema = z.array(WellnessSchema);
export type WellnessList = z.infer<typeof WellnessListSchema>;

// ── Events ────────────────────────────────────────────────────────────────────

export const EventSchema = z
  .object({
    id: z.number(),
    start_date_local: z.string(),
    name: z.string(),
  })
  .passthrough();

export type IcuEvent = z.infer<typeof EventSchema>;

export const EventListSchema = z.array(EventSchema);
export type EventList = z.infer<typeof EventListSchema>;

// ── Event inputs ──────────────────────────────────────────────────────────────

export const CreateEventInputSchema = z.object({
  start_date_local: z.string(),
  name: z.string(),
  end_date_local: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
});

export type CreateEventInput = z.infer<typeof CreateEventInputSchema>;

export const UpdateEventInputSchema = CreateEventInputSchema.partial();
export type UpdateEventInput = z.infer<typeof UpdateEventInputSchema>;
