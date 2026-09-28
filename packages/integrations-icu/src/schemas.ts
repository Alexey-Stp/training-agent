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
    // Optional metrics. nullish so a sparse activity doesn't fail the contract
    start_date: z.string().nullish(), // UTC ISO timestamp
    moving_time: z.number().nullish(), // seconds
    elapsed_time: z.number().nullish(), // seconds
    distance: z.number().nullish(), // meters
    icu_training_load: z.number().nullish(),
    average_heartrate: z.number().nullish(),
    icu_average_watts: z.number().nullish(),
    average_watts: z.number().nullish(),
    source: z.string().nullish(), // e.g. GARMIN_CONNECT, STRAVA, UPLOAD
  })
  .passthrough();

export type Activity = z.infer<typeof ActivitySchema>;

export const ActivityListSchema = z.array(ActivitySchema);
export type ActivityList = z.infer<typeof ActivityListSchema>;

// ── Wellness ──────────────────────────────────────────────────────────────────

export const WellnessSchema = z
  .object({
    id: z.string(), // YYYY-MM-DD date key
    // Device / ICU-derived metrics. Any of them may be missing (no strap, no scale, ...)
    ctl: z.number().nullish(),
    atl: z.number().nullish(),
    restingHR: z.number().nullish(),
    hrv: z.number().nullish(), // rMSSD, ms
    sleepSecs: z.number().nullish(),
    sleepScore: z.number().nullish(),
    weight: z.number().nullish(), // kg
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
    category: z.string().nullish(), // WORKOUT, RACE_A, NOTE, ...
    type: z.string().nullish(), // sport for workouts, e.g. Ride, Run, Swim
    description: z.string().nullish(), // for workouts: notes + structured workout text
    moving_time: z.number().nullish(), // planned seconds
    external_id: z.string().nullish(), // caller-provided id, used to find our own events
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
  category: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  moving_time: z.number().optional(),
  external_id: z.string().optional(),
});

export type CreateEventInput = z.infer<typeof CreateEventInputSchema>;

export const UpdateEventInputSchema = CreateEventInputSchema.partial();
export type UpdateEventInput = z.infer<typeof UpdateEventInputSchema>;
