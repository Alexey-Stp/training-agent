# Architecture Documentation

## Overview

This is a production-ready Triathlon Coach Telegram bot built with clean architecture principles, designed to scale to 1000+ users.

## High-Level Architecture

```
┌─────────────┐
│  Telegram   │
│   Updates   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                     Bot Service                          │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  grammY    │─▶│  Parser  │─▶│  Job Enqueue     │   │
│  │  Handler   │  │          │  │  (BullMQ)        │   │
│  └────────────┘  └──────────┘  └──────────────────┘   │
└─────────────────────────────┬───────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   Redis Queue    │
                    │    (BullMQ)      │
                    └────────┬─────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│                    Worker Service                         │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────────┐ │
│  │  Job         │─▶│  Command    │─▶│  Response      │ │
│  │  Consumer    │  │  Handlers   │  │  via Telegram  │ │
│  └──────────────┘  └──────┬──────┘  └────────────────┘ │
│                            │                              │
│                            ▼                              │
│                   ┌─────────────────┐                    │
│                   │  Core Package   │                    │
│                   │  ┌────────────┐ │                    │
│                   │  │ Rules      │ │                    │
│                   │  │ Engine     │ │                    │
│                   │  └────────────┘ │                    │
│                   │  ┌────────────┐ │                    │
│                   │  │ Plan       │ │                    │
│                   │  │ Generator  │ │                    │
│                   │  └────────────┘ │                    │
│                   └─────────────────┘                    │
│                            │                              │
│                            ▼                              │
│                   ┌─────────────────┐                    │
│                   │   PostgreSQL    │                    │
│                   │   (Prisma)      │                    │
│                   └─────────────────┘                    │
└──────────────────────────────────────────────────────────┘
```

## Components

### Bot Service (`apps/bot`)

**Responsibility**: Lightweight gateway that receives Telegram updates and enqueues jobs.

**Key Files**:

- `index.ts` - Main bot initialization with grammY
- `parser.ts` - Command parsing and validation
- `queue.ts` - BullMQ queue setup (`enqueueCommand`)
- `connect-dialog.ts` - `/connect icu` two-step dialog (state in Redis, key `icu-connect:<telegramUserId>`, 10 min TTL)
- `season-dialog.ts` - `/season new` wizard: weekly hours, then weak sport, as inline buttons or typed answers (state in Redis, key `season-new:<telegramUserId>`, 10 min TTL); submits a `season_preview` job
- `season-callbacks.ts` - maps the season preview buttons (`sd:save|replace|cancel:<draftId>`) to `season_confirm` / `season_cancel` jobs
- `state-store.ts` - `RedisStateStore<T>`, the per-user dialog state store both dialogs use

**Design Principles**:

- Thin layer - no business logic, with two exceptions: the `/connect icu` dialog (see [Athlete linking](#athlete-linking-connect-icu)) and the `/season new` wizard (see [Season wizard](#season-wizard-season-new))
- Fast acknowledgment to user (reaction emoji)
- Resilient error handling (never crash on bad input)
- All requests go through queue for consistency

**Why separate bot from worker?**

- Bot service can restart without losing in-flight jobs
- Worker can scale independently (multiple instances)
- Clear separation of concerns

### Worker Service (`apps/worker`)

**Responsibility**: Process jobs from queue, execute business logic, send responses.

**Key Files**:

- `index.ts` - BullMQ worker setup and job processing
- `handlers.ts` - Command handler implementations, `getRulesContext` (last 7 days of workouts plus that day's wellness)
- `session-format.ts` - Shared plan reply formatting (sport icons, day headings, session lines) for `/plan` and `/week show`
- `profile.ts` - `toUserProfile` (Prisma `Profile` → core `UserProfile`), `MSG_NO_PROFILE`
- `week-command.ts` - `/week show` handler: finds today's block week in the active season and expands it with the races around it (injected `SeasonRepo`, races, rules context and clock)
- `race-command.ts` - `/race add` (argument parsing, `parseRaceAddArgs`, optional `travel=<date>` 1–7 days before the race), `/race list` and `/race move` (shifts the travel day with the race) (injected `RaceRepo`)
- `season-races.ts` - `racesForRange`: the races that can shape a date range (loaded `RACE_REACH_DAYS` past both ends; an A-race other than the season's is treated as B)
- `season-command.ts` - `season_preview` (generate + store a draft, reply with the block table and buttons), `season_confirm` (draft → active, replacement guard), `season_cancel`, `/season show` (injected `SeasonStoreRepo`, `RaceRepo`, load query, publish queue)
- `season-publish.ts` - `season-rolling-publish` job processor: expands and pushes the active season for T+1..T+14, races included (injected deps)
- `plan-source.ts` - `planWeek`: the week `/plan` and `/plan push` store, from the active season where it covers the days, from the 7-day generator otherwise
- `reply.ts` - `Reply` (plain text, or HTML + inline keyboard) and `toTelegramMessage`
- `icu-connect.ts` - `connect_icu` / `/connect status` / `/disconnect icu` handlers (injected repo + ICU client for testing)
- `activity-sync.ts` - ICU activity sync: window, mapping, idempotent diff, `icu-activity-sync` job processor, shared `runIcuSyncJob` error mapping (injected deps)
- `wellness-sync.ts` - ICU wellness sync: mapping, device-only merge, `icu-wellness-sync` job processor (injected deps)
- `sync-command.ts` - `/sync` handler (activities, then wellness)
- `sync-scheduler.ts` - per-athlete BullMQ job schedulers (activity, wellness, plan reconcile, season publish) on the `icu-sync` queue, startup reconciliation
- `plan-store.ts` - stores the generated week as `PlannedSession` rows: `diffPlan` on (date, slot), tombstones for pushed sessions that leave the plan; `materializeRange` for any date range, `materializePlan` for today..today+6
- `plan-push.ts` - `pushPlannedSessions`: creates/updates/deletes ICU `WORKOUT` events for pending sessions, `external_id` orphan adoption, `hashIcuEvent` (injected deps)
- `plan-reconcile.ts` - `icu-plan-reconcile` job processor: flags sessions whose ICU event was moved/edited/deleted as `modified_externally` (injected deps)
- `plan-command.ts` - `/plan push` handler (store, push, reply)
- `daily-loop/` - Morning brief (`pipeline.ts`, `render.ts`, `checkin*.ts`), evening close-out (`closeout.ts`, `closeout-render.ts`, `closeout-store.ts`), shared per-athlete cron schedulers (`scheduler.ts`, also the weekly stats one) and run helpers (`run-helpers.ts`)
- `reviews/` - Weekly stats job (`weekly-stats.ts` `runWeeklyStats`, repo interface in `weekly-stats-store.ts`)
- `db.ts` - Database utilities (user creation, deduplication, `icuConnectionRepo`, `activityRepo`, `wellnessRepo`, `plannedSessionRepo`, `raceRepo`, `seasonRepo` (active season, drafts, transactional activation), `profileRepo`, `loadTrainingHours`, `dailyBriefRunRepo`, `eveningCloseoutRunRepo`, `closeoutRepo`, `weeklyStatsRepo`)

**Design Principles**:

- All business logic lives here
- Idempotent (dedupe via ProcessedMessage table)
- Retries on failure (BullMQ built-in)
- Sends Telegram responses directly

**Concurrency**: Currently 5 concurrent jobs. Can be increased for higher throughput.

### Core Package (`packages/core`)

**Responsibility**: Shared business logic, types, rules engine.

**Key Files**:

- `types.ts` - Domain models (Session, WeekPlan, UserProfile, etc.)
- `config.ts` - Environment variable validation (Zod), `getEncKeys()` keyring
- `crypto.ts` - AES-256-GCM `encryptSecret` / `decryptSecret` (rotation-ready keyring), `maskSecret`
- `logger.ts` - `createLogger()` shared pino setup with `LOG_REDACT_PATHS`
- `plan-generator.ts` - Draft plan generation from template
- `workout.ts` - `buildWorkoutSteps` (warmup / main set or N x (work, rest) / cooldown from sport, intensity and duration) and `renderIcuWorkout` (intervals.icu workout text)
- `planned-session.ts` - `toPlannedSessions`: adapter from the rules-applied `WeekPlan` to `PlannedSession` rows
- `rules-engine.ts` - `applyRules` (corrects a plan) and `checkHardRules` (reports the hard rules a plan still breaks as `RuleViolation[]`)
- `season/` - Season domain model (`Race`, `SeasonPlan`, `TrainingBlock` and their enums), `validateBlockSequence` / `validateSeasonPlan` / `assertValidSeasonPlan` (`SeasonValidationError`), the zod-checked `serializeSeasonPlan` / `parseSeasonPlan`, and `generateSeasonPlan` (`block-generator.ts`): blocks allocated backwards from the A-race with short-runway compression (`block-sequence.ts`), a ≤8% ramp with 3:1 recovery weeks from the current load (`volume.ts`), and a per-sport split with weak-sport bias (`sport-split.ts`). All constants are in `DEFAULT_BLOCK_GENERATOR_CONFIG` (`generator-config.ts`). `week-expander.ts` has `expandWeek(block, weekIndex, profile)`. It picks a session template for the block type (base, build/peak, taper/race, recovery/transition), places the sessions by the profile's day preferences, sizes them to the week's targets, applies the races (`race-week.ts` `applyRaceOverrides`: A-race race-week template per race type from T-6, B-race 3–5 day mini-taper, C-race key-session swap; the race is one `race`-tagged session), and gates the result through `applyRules` + `checkHardRules`. Taper and race weeks carry `WeekPlan.phase` and their sessions the `taper` tag. Taper volume is counted back from the race (`taperWeekFactorsFromRace` 0.6/0.75/0.85 of peak, race week `raceWeekFactor` 0.4, the race excluded); `weekVolumeFactor` reshapes a taper block's stored average into its declining weeks. Taper and race weeks are the explicit ramp-cap exception (`isRampException`). An intensity session is `isHardSession` or an `openers` session, the race excluded (`isIntensitySession`). `window.ts` has the timezone-aware date helpers (`localToday`, `rollingWindow`, `clipToSeason`) and `seasonDraftsForRange`; `table.ts` has `formatSeasonTable`
- `closeout.ts` - Close-out matching (`matchActivities`), `isKeySession`, `guessIntensity`, `hrIntensity` (average HR vs LTHR, Friel bands)
- `reviews/` - `iso-week.ts` (`isoWeekKey`, `isoWeekRange`, `previousIsoWeek`) and `weekly-stats.ts` (`computeWeeklyStats`: pure planned-vs-actual summary of one ISO week)
- `season-wizard.ts` - Contract between the bot wizard and the worker: the `season_*` command names, the preview button callback data (`seasonDecisionData` / `parseSeasonDecision`) and the shared answer validation (`parseWeeklyHours`, `WEAK_SPORT_CHOICES`)

**Design Principles**:

- Pure functions where possible
- No side effects (DB, network)
- Fully tested (see `test/rules-engine.test.ts`)
- Type-safe (strict TypeScript)

### integrations-icu Package (`packages/integrations-icu`)

**Responsibility**: Typed, rate-limited HTTP client for the [intervals.icu](https://intervals.icu) REST API.

**Key Files**:

- `src/client.ts` - `IcuClient` class exposing all methods; injectable fetch for testability
- `src/schemas.ts` - Zod v4 schemas for Athlete, Activity, Wellness, Event (`.passthrough()` to tolerate unknown fields)
- `src/errors.ts` - Typed errors: `IcuRateLimitError`, `IcuServerError`, `IcuAuthError`, `IcuHttpError`, `IcuContractError`
- `test/fixtures/` - JSON fixtures for unit tests

**Public API**:

| Method                           | HTTP                             | Description                               |
| -------------------------------- | -------------------------------- | ----------------------------------------- |
| `getAthlete()`                   | GET `/athlete/:id`               | Fetch the authenticated athlete's profile |
| `listActivities(oldest, newest)` | GET `/athlete/:id/activities`    | Activities in date range                  |
| `listWellness(oldest, newest)`   | GET `/athlete/:id/wellness`      | Wellness/HRV data in date range           |
| `listEvents(oldest?, newest?)`   | GET `/athlete/:id/events`        | Calendar events (optional date range)     |
| `createEvent(data)`              | POST `/athlete/:id/events`       | Create a new calendar event               |
| `updateEvent(id, data)`          | PUT `/athlete/:id/events/:id`    | Update an existing event                  |
| `deleteEvent(id)`                | DELETE `/athlete/:id/events/:id` | Delete a calendar event                   |

**Auth**: HTTP Basic with username `API_KEY` and password = athlete API key. Configured via `ICU_ATHLETE_ID` / `ICU_API_KEY` env vars.

**Retry strategy**: Exponential backoff (max 3 retries) on 429 and 5xx responses. 401 throws `IcuAuthError` immediately (no retry). After exhausting retries, throws `IcuRateLimitError` (429) or `IcuServerError` (5xx). Any other non-OK status throws `IcuHttpError` (status, endpoint, body) without retry. Malformed responses throw `IcuContractError` with the endpoint name.

**Design Principles**:

- All ICU access goes through one typed client (single place for auth, retry, error mapping)
- No DB persistence — pure network layer
- Fully tested (see `test/client.test.ts`)

### Database Schema (`prisma/schema.prisma`)

**Tables**:

1. **User** - Telegram user mapping
   - `telegramId` (unique, BigInt)
   - Relations: Profile, Workouts, Wellness

2. **Profile** - User training preferences
   - FTP, timezone, swim days, bike days
   - One-to-one with User

3. **Workout** - Logged training sessions
   - Sport, duration, intensity, date
   - Indexed on (userId, date) for fast queries

4. **Wellness** - Daily readiness input (replaced `Fatigue` in `3_wellness`)
   - Device/ICU columns written by the wellness sync: `hrv` (rMSSD), `restingHr`, `sleepHours`, `sleepScore`, `weightKg`, `ctl`, `atl`, `tsb` (= ctl − atl)
   - Check-in columns never written by sync: `subjectiveReadiness` (1-5), `soreness`
   - Unique on (userId, date), date is `yyyy-MM-dd` athlete-local

5. **ProcessedMessage** - Idempotency tracking
   - Prevents duplicate workout logs
   - Unique on (userId, telegramMessageId)

6. **IcuConnection** - intervals.icu account link
   - `icuAthleteId`, `icuAthleteName`, `apiKeyCiphertext` (base64 ciphertext‖GCM tag), `apiKeyIv`
   - `lastActivitySyncAt` (activity sync cursor), `lastWellnessSyncAt` (wellness sync cursor)
   - Unique on userId: one connection per user, re-linking overwrites. Re-linking a different athlete resets both sync cursors, deletes the user's activities from the old athlete and clears the Wellness device columns (check-ins are kept)

7. **Activity** - executed training pulled from intervals.icu
   - `icuId` + `userId` (unique together, so two users may link the same athlete), `icuAthleteId`, `sport` (`other` for unmapped ICU types), raw `icuType`, `name`
   - `startTime` (UTC), `startDateLocal` (`yyyy-MM-dd`), `durationSec`, `distanceM`, `load` (`icu_training_load`), `avgHr`, `avgPower`, `source`
   - Indexed on (userId, startTime)

8. **PlannedSession** - planned workout pushed to the intervals.icu calendar
   - `date`, `slot` (`<sport>-<n>`, unique with userId and date), `sport`, `title`, `description` (coach notes), `durationMin`, `intensity`, `steps` (JSON `WorkoutBlock[]`)
   - `status`: `draft` | `pushed` | `modified_externally` | `completed` | `skipped`
   - `icuEventId`, `pushedHash` (hash of the event ICU returned after our last write), `pushedAt`, `externalChange` (reason for the flag), `deletedAt` (tombstone until push deletes the ICU event)

9. **Race** - a race on the athlete's calendar
   - `date`, `name`, `priority` (`A` | `B` | `C`), `type` (`sprint` | `olympic` | `half` | `full` | `run` | `other`), optional `travelDate` (migration `9g_race_travel`; within T-3..T-1 it is a rest day in the race-week plan)
   - Indexed on (userId, date)

10. **SeasonPlan** - season periodization
    - `startDate`, `status` (`draft` | `active` | `completed` | `archived`), `aRaceId` (nullable; set to NULL if the race is deleted)
    - Indexed on (userId, status)

11. **TrainingBlock** - one phase of a SeasonPlan
    - `order` (unique with seasonPlanId), `type` (`base` | `build` | `peak` | `taper` | `race` | `recovery` | `transition`), `startDate`, `weeks` (block ends `startDate + weeks*7 - 1`), `focus`, weekly targets `targetWeeklyHours`, `targetSwimM`, `targetBikeH`, `targetRunKm`, optional `targetCtl`
    - Invariants live in core `season/validate.ts`, not in the DB: blocks are contiguous with no gap or overlap, and the block containing the A-race is a `race` block ending on race week, right after a `taper` block

**Migrations**: `prisma/migrations/` starts with `0_init` (baseline of the pre-TA-9 schema), followed by `1_icu_connection`, `2_activity`, `3_wellness` (creates `Wellness`, copies `Fatigue.readiness` → `subjectiveReadiness` and `Fatigue.sleepScore` → `sleepScore`, then drops `Fatigue`, all in one transaction), `4_planned_session` and `5_season_plan`. Apply with `npm run db:deploy`. A database created earlier with `db push` must be baselined once: `npx prisma migrate resolve --applied 0_init`, then `npm run db:deploy`.

**Indices**: Optimized for common queries (last 7 days workouts, user lookup)

## Data Flow

### Athlete linking (`/connect icu`)

```
/connect icu      → bot: state {step: athleteId} in Redis → prompt
i12345            → bot: validate, state {step: apiKey, athleteId} → prompt
<api key>         → bot: encryptSecret(key, SECRETS_ENC_KEY), delete the user's message,
                    clear state, enqueue {commandName: 'connect_icu', icuCredentials: {athleteId, ciphertext, iv}}
worker            → decryptSecret → IcuClient.getAthlete()
                    ok  → upsert IcuConnection (ciphertext as received), reply "Connected as <name>"
                    401 / 403 / 404 / 429 / 5xx → friendly reply, nothing stored, no BullMQ retry
/connect status   → worker: athlete name, masked key (last 4 chars), last sync times
/disconnect icu   → worker: delete the IcuConnection row
```

The dialog runs in the bot so the plaintext key never reaches the BullMQ payload (Redis keeps failed jobs for 24h). Dialog state holds only the athlete ID. `/cancel`, or any other command, abandons the dialog.

### Activity sync (`icu-sync` queue)

```
connect_icu ok    → scheduler.upsertJobScheduler('icu-activity-sync:<userId>', every 30 min)
                    scheduler.upsertJobScheduler('icu-wellness-sync:<userId>', every 24 h)
                    (first jobs run immediately = 90-day backfills)
/disconnect icu   → removeJobScheduler (both)
worker startup    → reconcileSchedulers: add missing/stale schedulers, remove ones without a connection
icu-activity-sync → syncActivities(userId)
icu-wellness-sync → syncWellness(userId)
/sync             → syncActivities, then syncWellness, inline in the commands worker, reply with counts
```

`syncActivities` does the following:

1. **Window.** `oldest` is `today − ICU_ACTIVITY_BACKFILL_DAYS` if there is no cursor, otherwise `date(lastActivitySyncAt) − ICU_ACTIVITY_SYNC_OVERLAP_DAYS − 1`. `newest` is tomorrow. The dates are UTC, but ICU filters by the athlete's local date, which can differ by a day, so both ends get one day of margin.
2. **Fetch.** `IcuClient.listActivities(oldest, newest)`.
3. **Map.** `mapIcuActivity` converts each ICU activity to a local row.
4. **Diff.** It loads the user's existing rows by `icuId` and compares the mapped fields. New rows go to `createMany({skipDuplicates})`, changed rows get `update`, and equal rows are skipped. A run with no new data therefore modifies zero rows.
5. **Write.** Rows and `lastActivitySyncAt = <time before fetch>` are written in one `$transaction`, so the cursor only moves when the fetch and all writes succeed.

Failures:

- 429, 5xx and network errors are rethrown. BullMQ retries 3 times with exponential backoff, and the cursor is unchanged.
- A rejected (401) or undecryptable key throws `UnrecoverableError`, so there is no retry.
- `/sync` answers ICU errors with a friendly reply instead.

`syncWellness` follows the same steps with `lastWellnessSyncAt`, `ICU_WELLNESS_BACKFILL_DAYS` and `ICU_WELLNESS_SYNC_OVERLAP_DAYS`, keyed by date instead of `icuId`. The difference is the merge: each new or changed day is a `wellness.upsert` whose `update` holds only the device columns (`WELLNESS_DEVICE_FIELDS`). ICU values overwrite, nulls included, and `subjectiveReadiness`/`soreness` are never written. Upsert (not `createMany`) keeps a check-in that created the row mid-sync.

### Planned workout push (`/plan push`, `icu-plan-reconcile`)

```
/plan, /plan push   → planWeek: active season days → seasonDraftsForRange, other days → generateDraftPlan
                      → applyRules → toPlannedSessions; then materializePlan(today..today+6)
/plan push          → pushPlannedSessions(today): tombstones → deleteEvent, drafts → createEvent / updateEvent
connect_icu ok      → scheduler.upsertJobScheduler('icu-plan-reconcile:<userId>', every 60 min)
icu-plan-reconcile  → reconcilePlannedSessions(userId)
```

`materializePlan` matches rows on (date, slot). New sessions are created as `draft`. A changed `draft`/`pushed` row gets the new content and goes back to `draft`, keeping its `icuEventId`. Rows that left the plan are tombstoned (`deletedAt`) if they have an ICU event, and deleted otherwise. `modified_externally`, `completed` and `skipped` rows are never touched, and rows before today are history.

`pushPlannedSessions` loads the pending rows (tombstoned or `draft`, dated today or later). Before creating anything, it lists the ICU events in that range and adopts events whose `external_id` (`ta-<id>`) matches a row without an `icuEventId`. This covers a crash between `createEvent` and the DB write. Each row is saved right after its ICU call: `pushedHash = hashIcuEvent(<event ICU returned>)`, so ICU normalization cannot cause false flags. `markPushed` only sets `pushed` if the row has not changed since it was read. A 404 on delete counts as deleted. A 404 on update means the athlete deleted the event, so the row is flagged.

`reconcilePlannedSessions` loads the `pushed` rows dated from UTC yesterday on, lists the ICU events in their range, and fetches each missing one with `getEvent` (moved out of range, or 404 = deleted). A hash mismatch flags the row `modified_externally` with the reason `moved to <date>`, `edited in intervals.icu` or `deleted in intervals.icu`. The flag is a conditional update on the expected `pushedHash`, so a push that rewrote the event meanwhile wins. `listModifiedExternally` is the query for the daily brief.

### Season week (`/week show`)

```
/week show → seasonRepo.findActiveSeason → block + weekIndex containing today (weekIndexForDate)
           → getRulesContext(weekStart) → expandWeek: template → placement → sizing → applyRules → checkHardRules
           → reply: targets vs planned hours, sessions by day, adjustments, remaining violations
```

Read-only: nothing is written to `PlannedSession`. The targets are the block's weekly averages, because per-week targets (`SeasonWeek`, e.g. recovery weeks) are not stored.

### Season wizard (`/season new`)

```
/race add …        → worker: parseRaceAddArgs → Race row
/season new        → bot: state {step: hours} in Redis → hours buttons
tap 10h / "10"     → bot: state {step: weakSport, hours} → weak-sport buttons (wizard message edited in place)
tap Bike / "bike"  → bot: clear state, enqueue {commandName: 'season_preview', args: ['10', 'bike']}
season_preview     → worker: next A race, current load (last 4 weeks of Activity), generateSeasonPlan(today),
                     assertValidSeasonPlan, replaceDraft (SeasonPlan status=draft)
                     → <pre> block table + [✅ Save | ✖ Cancel], or ⚠️ + [♻️ Replace | ✖ Cancel] if a season is active
tap Save/Replace   → bot: remove buttons, enqueue season_confirm [draftId, 'replace'?] (jobId per tapped message)
season_confirm     → worker: activateDraft in one transaction:
                       other season active and no 'replace' → needs_replace (ask again with Replace)
                       otherwise archive the old active season, draft → active → queue season-rolling-publish
tap Cancel         → season_cancel → delete the draft
```

Nothing becomes active until a confirm. The replacement guard is enforced in `activateDraft`, not just by which button the preview shows.

### Rolling publish (`season-rolling-publish`)

```
connect_icu ok / startup → upsertJobScheduler('season-rolling-publish:<userId>', every SEASON_PUBLISH_EVERY_MIN)
season_confirm           → queue.add('season-rolling-publish', {userId})  (one-off, right away)
season-rolling-publish   → publishSeasonWindow(userId):
                             T = localToday(now, Profile.timezone); window = T+1..T+SEASON_PUBLISH_WINDOW_DAYS
                             clip to the season → seasonDraftsForRange → materializeRange(window)
                             → pushPlannedSessions(from T+1)
```

Skipped without a connection, profile or active season. Days ≤ T are outside every read and write, so the athlete's day and history are never changed. The interval is not tied to midnight; because each run recomputes T in the athlete's timezone, the next day enters the window within one interval of local midnight. A run with nothing new writes no rows and makes no ICU calls.

### Example: `/plan` Command

1. **User sends** `/plan` in Telegram
2. **Bot receives** update via grammY
3. **Bot parses** command → `{ commandName: 'plan', args: [] }`
4. **Bot enqueues** job to Redis (BullMQ)
5. **Bot reacts** 👀 to acknowledge
6. **Worker picks up** job from queue
7. **Worker ensures user** exists (create if new)
8. **Worker checks** if message already processed (idempotency)
9. **Worker fetches** user profile from DB
10. **Worker generates** draft plan (template-based)
11. **Worker fetches** last 7 days workouts + today's Wellness row
12. **Worker applies rules** (NoHardHard, ReadinessDownshift, WeeklyLoadCap, SwimRotation)
13. **Worker formats** response message
14. **Worker sends** via Telegram API
15. **Worker marks** message as processed
16. **Job completes** successfully

### Example: `/log swim 60 z2` Command

1. User sends `/log swim 60 z2`
2. Bot enqueues job
3. Worker validates: sport in [swim, bike, run], duration 1-1440, intensity z1-z5
4. Worker creates Workout record in DB
5. Worker sends confirmation message
6. Worker marks message processed

## Rules Engine

The rules engine is the core business logic for plan generation.

### Architecture

```
Draft Plan (template) → Rules Engine → Final Plan
                            ↓
                    Rules Context
                    - Last 7d stats
                    - Today's wellness
```

### Rules Execution Order

1. **SwimRotation** (soft) - Fix swim session structure
2. **ReadinessDownshift** (hard) - Downgrade if tired
3. **NoHardHard** (hard) - Prevent consecutive hard days
4. **WeeklyLoadCap** (hard) - Limit volume growth

**Why this order?**

- SwimRotation first to ensure proper structure
- ReadinessDownshift next to handle fatigue ASAP
- NoHardHard after (some sessions may already be downgraded)
- WeeklyLoadCap last (applies to total volume)

**Races and tapers.** Race overrides run before the rules, so the rules see the race. A `race`-tagged session is never downgraded (ReadinessDownshift, NoHardHard) or scaled (WeeklyLoadCap) and is left out of the load total; NoHardHard downgrades a hard session next to a race instead. SwimRotation skips `taper` sessions. WeeklyLoadCap and its `checkHardRules` counterpart skip weeks with `WeekPlan.phase` (taper/race): the reduction is valid by design. The 30-minute floor never lengthens a shorter session.

### Adding New Rules

To add a new rule:

1. Define in `packages/core/src/rules-engine.ts`
2. Add to `applyRules()` function
3. Write tests in `packages/core/test/rules-engine.test.ts`
4. Document in README

Example:

```typescript
function applyMyCustomRule(plan: WeekPlan, context: RulesContext): WeekPlan {
  const sessions = [...plan.sessions];
  const warnings = [...plan.warnings];
  const appliedRules = [...plan.appliedRules];

  // Your logic here
  // Modify sessions, add warnings, track rule application

  return { ...plan, sessions, warnings, appliedRules };
}
```

## Scaling Strategy

### Current Capacity

With default settings:

- 5 concurrent workers
- ~2-3s per job (DB queries + plan generation)
- **~100-150 requests/minute**
- Supports **~1000 daily active users** comfortably

### Horizontal Scaling

To scale beyond 1000 users:

1. **Add more worker containers**:

   ```yaml
   # docker-compose.yml
   worker:
     deploy:
       replicas: 3
   ```

2. **Increase concurrency**:

   ```typescript
   // apps/worker/src/index.ts
   const worker = new Worker('commands', processJob, {
     concurrency: 10, // Up from 5
   });
   ```

3. **Add Redis cluster** (for high queue throughput)

4. **Add PostgreSQL read replicas** (for read-heavy workouts)

### Vertical Scaling

- Increase worker memory/CPU
- Optimize database queries (add indices)
- Cache user profiles in Redis (TTL 5min)

### Performance Optimizations

**Quick wins**:

- Cache profile in Redis after first fetch
- Batch workout queries (fetch by date range)
- Use PostgreSQL connection pooling
- Add CDN for static assets (if adding web UI)

## LLM/RAG Integration Path

The architecture is designed for future LLM integration without rewrites.

### Option A: LLM-Enhanced Rules

Keep deterministic rules, add LLM for explanations/coaching:

```typescript
// In worker handlers
const plan = applyRules(draftPlan, context);

// Add LLM-generated insights
const insights = await llm.generateInsights(plan, userHistory);
plan.aiCoachingNotes = insights;
```

### Option B: LLM-Generated Plans

Use LLM to generate plans, rules engine validates:

```typescript
// Generate via LLM
const llmPlan = await llm.generatePlan(profile, context);

// Validate with rules (safety check)
const validatedPlan = applyRules(llmPlan, context);
```

### Option C: Hybrid

- Use rules for structured plan generation
- Use LLM for natural language interaction, motivation, Q&A
- Store conversation history in new `Conversation` table

**Recommended**: Start with Option A (minimal changes, adds value)

### Daily coaching context (implemented)

The first building block is `buildDailyContext` in `packages/ai/src/context/`:

1. `collect.ts` reads all sources in parallel through injected repositories (`DailyContextDeps`), filters them to their windows and re-sorts them, so repository order can't change the prompt.
2. `trends.ts` holds the pure calculations: HRV 30-day baseline (population SD, at least 7 readings), wellness trend, CTL/ATL/TSB with a staleness fallback, compliance per sport, missed key sessions and power zones. `season.ts` finds the block week.
3. `render.ts` formats each section with fixed numeric precision and states missing data explicitly. `template.ts` fills `{{placeholder}}`s in `src/prompts/daily-v1.md` (copied to `dist/prompts` at build) and fails on unknown or unused placeholders.
4. `budget.ts` truncates to the token budget: oldest history, then decisions, then trend days.

The template name doubles as the `promptVersion` logged with each LLM call. To change the prompt, add `daily-v2.md` rather than editing v1.

### Coach suggestions and guardrails (implemented)

`runCoachSuggestion` in `packages/ai/src/suggestion/` turns the daily context into a safe recommendation:

```
daily prompt + suggestion-v1.md (answer format, limits, sessions by id)
        │
        ▼
LLM (structured output: CoachSuggestion) ── invalid JSON/schema ──► one repair call (prompt + bad reply + error)
        │                                                                 │ still invalid
        │ timeout / 5xx / auth / refusal                                  ▼
        ├────────────────────────────────────────────────────────► rules-engine fallback
        ▼                                                                 ▲
guardrails: integrity ─ reject ───────────────────────────────────────────┤
            clamps (≤50% cut, no moves onto rest days,                    │
                    no intensity increases at readiness ≤2)               │
            checkHardRules on the patched plan ─ new violation ───────────┘
        │ accept / clamp
        ▼
CoachDecision row (always exactly one per run)
```

- `schema.ts`: zod `CoachSuggestion` (`assessment`, `action` keep|reduce|swap|move|rest, `changes: SessionDiff[]`, `confidence` 0..1, `athleteMessage`). A `SessionDiff` is one field (`durationMin`, `intensity`, `date` or `sport`) of one session, with `before`/`after`. `sessionId` is the natural key `<date>/<slot>`. `coachSuggestionJsonSchema()` strips keywords structured outputs rejects (`minimum`, `pattern`, ...); zod still enforces them.
- `parse.ts`: `requestSuggestion` makes at most two calls. A reply that fails JSON or schema validation (or a provider `LlmContractError`) gets exactly one repair call. Any other provider error means the LLM is unavailable, and no repair call is made.
- `guardrails.ts`: `runGuardrails` is pure and works on a clone. Integrity problems (unknown session, stale `before`, past or locked session, duplicate field) reject. Per-change limits clamp. Hard-rule violations the change introduced (`checkHardRules`: NoHardHard, ReadinessDownshift, WeeklyLoadCap) reject; violations the plan already had are not blamed on the LLM. Limits live in `DEFAULT_GUARDRAIL_CONFIG`. `deterministicRecommendation` is the rules-engine-only fallback: `applyRules` on the window, keeping only downgrades and reductions.
- `run.ts`: an accepted suggestion keeps the LLM's message. Clamped and fallback outcomes get a deterministic message that lists the final changes and why. Every run writes one `CoachDecision` (context hash, raw replies, parsed suggestion, verdict, reasons, final action and changes); only a failing write throws, so BullMQ retries. The worker's `coachDecisionRepo` also serves `DailyContextDeps.decisions`.

### Coach chat (implemented)

```
Telegram text (no /) ─► bot: coach_chat job (text in rawText, "typing…")
        │
        ▼
worker handleCoachChat
  stored coach reply for this message? ─ yes ─► resend it (retry)
  Redis SADD coach-chat:<user>:<local day> messageId, SCARD > COACH_CHAT_DAILY_LIMIT ─► limit notice, no LLM call
  save user CoachChatMessage
  daily prompt + plan today..+6 + last 10 messages + RulesContext (in parallel)
        │
        ▼
runCoachChat: chat-system-v1 (system) + daily prompt + chat-v1.md
  LLM structured output { reply, suggestion | null } (one repair call at most)
  suggestion with changes ─► runGuardrails ─► CoachDecision (origin chat)
        │
        ▼
save coach CoachChatMessage (+ coachDecisionId when applicable)
reply: text, or text + [✅ Apply | ↩️ Keep my plan] (callback cc:a|k:<decisionId>)
        │ tap
        ▼
coach_apply / coach_keep / coach_discuss job (jobId per tapped message)
  answered already ─► "already answered"; older than COACH_DECISION_TTL_HOURS ─► expired, /plan today
  apply:   re-run runGuardrails on today's plan ─ not accept ─► "plan changed", accepted=false
           buildCoachPatches, snapshot the rows they touch
           tx 1: accepted=true, userAction=apply (only if unanswered) + PlannedSession writes
           pushPlannedSessions scoped to coachDecisionId (ICU event updated/moved/deleted)
             └ throws ─► buildRollbackPatches ─► tx 2: rows restored, decision unanswered again
  keep:    accepted=false, userAction=keep
  discuss: userAction=discuss (still unanswered), seed coach CoachChatMessage with the suggestion,
           reply asks what to change + [✅ Apply | ➡️ Keep plan]
```

- `packages/ai/src/chat/`: `runCoachChat` reuses the suggestion pipeline's `requestStructured` (the generic one-repair call), `CoachSuggestionSchema`, `runGuardrails` and messages. A plain answer writes nothing; a suggestion writes one `CoachDecision` with `origin: 'chat'`. A rejected or fully clamped suggestion is still stored for audit but offers no buttons.
- `apps/worker/src/coach-plan.ts`: `buildCoachPatches` turns the decision's `SessionDiff`s into row writes. Duration, intensity and sport changes regenerate `steps` (core `buildWorkoutSteps`). A move takes the first free `<sport>-<n>` slot on the new day (tombstones count as taken), keeps the row's `icuEventId` so push moves the event, and leaves a tombstone at the old `(date, slot)`.
- `PlannedSession.coachDecisionId` protects applied changes: `diffPlan` treats such rows like `modified_externally`, so `/plan` and the season publisher neither overwrite nor recreate them. Push deletes a coach tombstone's ICU event but keeps the row, and skips coach tombstones that have no event.
- Rate limit: a Redis set per user and local day holds message ids, so a retried job counts once. `COACH_CHAT_DAILY_LIMIT` (core config, default 30).
- **Answers** (`apps/worker/src/coach-apply.ts`, `handleCoachAnswer`). `CoachDecision.userAction` (`apply | keep | discuss`, migration `9a_coach_user_action`, which backfills it from `accepted`) records the tapped button; `accepted IS NULL` stays the guard against double taps. Discuss doesn't answer the decision, so Apply still works after it.
- **Rollback.** The push after Apply covers only the decision's rows (`pushPlannedSessions(..., { coachDecisionId })`), so an unrelated draft can't fail it. When it throws, `buildRollbackPatches` (`coach-plan.ts`) compares the pre-apply snapshot with the rows now: tombstones the apply created are deleted, changed rows get their old content back, and a gone row is recreated. Whether the failed push already reached ICU for a row is unknown (an ICU call can succeed and the DB write after it fail), so every restored row with an ICU event goes back to `draft`, and a cancelled one forgets its event id (push adopts the event by `external_id`, or recreates it). `revertDecision` writes all of it in one transaction and resets `accepted`, `answeredAt` and `userAction`. No DB transaction is held across ICU calls. If the revert fails too, the change stays and the athlete is told to `/plan push`.
- **Expiry.** The bot compares the tapped message's `date` with `COACH_DECISION_TTL_HOURS` before enqueueing (`apps/bot/src/callbacks.ts`, tested through grammY `handleUpdate`); the worker checks `CoachDecision.createdAt` again for jobs already queued.

### Morning brief (implemented)

```
daily-brief queue: one cron scheduler per linked athlete
  key daily-brief:<userId>, pattern from Profile.briefTime (?? DAILY_BRIEF_DEFAULT_TIME), tz Profile.timezone
        │ fires at the local time (BullMQ cron-parser handles DST)
        ▼
runDailyBrief (apps/worker/src/daily-loop/pipeline.ts)
  date = localToday(now, timezone)   (continuation: the job's checkInDate)
  claim DailyBriefRun (userId, date) ─ sent ─► skip ─ running within lease ─► BriefInProgressError (retry)
                                     ─ awaiting_checkin ─► skip (only the continuation claims it)
  brief already stored (retry after a failed send)? ─ yes ─► send it
  check-in already sent (continuation)? ─ yes ─► skip sync and check-in, reuse the stored stale/dataAsOf
  wellness sync ─┐ throws ─► stale, data as of the failed sync's cursor
  activity sync ─┘
  checkin: no device wellness today, or |HRV − mean| > 1 SD (30-day baseline), and not answered yet?
     ─ yes ─► queue continuation (delayed DAILY_CHECKIN_TIMEOUT_MINUTES, jobId checkin-<userId>-<date>)
              ─► send check-in [1..5] [None | Mild | Severe] ─► run awaiting_checkin, stop
  context: buildDailyContext ‖ plan today..+6 ‖ RulesContext   (context throws ─► rules only)
  suggest: runCoachSuggestion (LLM + guardrails, fallback inside) or runRulesFallback ─► one CoachDecision
  render: readiness verdict (+ "No check-in today" when unanswered) + today + coach message
          + proposed changes, [Apply | Keep plan] [Discuss]
  save brief text + buttons + decision id on the run
  send ─ fails ─► run failed, rethrow (job attempts: 3; 403/400 ─► UnrecoverableError)
  run sent
```

| Stage failure                               | Result                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| wellness or activity sync                   | brief sent with `⚠️ intervals.icu unavailable: data as of <cursor>` (`never synced` without one)            |
| context build                               | `runRulesFallback`: rules engine only, `CoachDecision.source = fallback`, `fallbackReason = internal_error` |
| LLM (down, invalid twice, guardrail reject) | rules-engine fallback inside `runCoachSuggestion`, `source = fallback`                                      |
| plan or RulesContext read                   | run marked failed, job retried                                                                              |
| Telegram send                               | run marked failed, job retried (3 attempts); the retry resends the stored brief                             |
| check-in send                               | run marked failed, job retried; the queued continuation (same job id) is reused                             |

- **Scheduling** (`daily-loop/scheduler.ts`). `createDailyBriefScheduler` is combined with the ICU sync scheduler (`combineSchedulers`), so connect/disconnect add and remove it. `reconcileDailyBriefSchedulers` runs at startup and reschedules athletes whose `pattern` or `tz` changed. A cron scheduler doesn't fire on creation.
- **Idempotency** (`DailyBriefRun`, unique `(userId, date)`, migration `9_daily_brief`). `claim` inserts the row (`skipDuplicates`) and takes it over with one conditional `updateMany`: pending or failed, or running with `startedAt` older than the 5-minute lease. The job backoff (2 and 4 minutes) outlasts the lease, so a retry after a crash takes the run over. Saving the brief and its decision id before sending means a retry never writes a second `CoachDecision`.
- **Timings.** Every stage logs `{ userId, date, stage, ms, outcome }` (`daily brief stage`), and the run ends with one `daily brief finished` log. The timings of the latest attempt are stored in `DailyBriefRun.stageTimings`.
- The pipeline takes its stages as injected deps (`syncWellness`, `syncActivities`, `sendMessage`, repos, `now`), so the tests need no Redis, Prisma, ICU or Telegram.
- **Brief message** (`daily-loop/render.ts`, snapshot-tested). The readiness line (`daily-loop/readiness.ts`) is deterministic: worst of check-in readiness (≤ 2/5 red, like `ReadinessDownshift`), HRV vs the 30-day baseline and TSB (below −20), ⚪ without data. Proposed changes are one line per session (ai `describeSessionChanges`, e.g. `Bike VO2 5x4 70′→50′, Z5→Z3`). Apply / Keep plan only when there are changes; Discuss always.
- **Check-in** (`daily-loop/checkin.ts`, `checkin-answer.ts`, migration `9b_daily_checkin`). `checkInReason` is pure: no row or no device data → `no_data`, HRV more than 1 SD off the 30-day mean in either direction → `hrv_deviation` (too few readings for a baseline never triggers), a day with both answers → none. The buttons carry `ci:r:<1-5>` / `ci:s:<0-2>` (core `checkin.ts`; soreness none=0, mild=1, severe=2, rendered as the label in the prompt). The bot enqueues `checkin_answer` with a per-button job id and leaves the buttons; the worker finds the run by `DailyBriefRun.checkInMessageId`, writes only the subjective column (`checkInRepo.recordCheckIn`: first answer wins) and edits the message to the remaining question. These taps skip the `ProcessedMessage` check, because both answers share one message id. With both answers in while the run is `awaiting_checkin`, it promotes the delayed continuation job; otherwise that job fires at the timeout. Late answers are still stored. Wellness sync never touches these columns (`WELLNESS_DEVICE_FIELDS`).
- **Answering a brief.** The buttons use the coach-chat answer flow above. For a daily decision the result replaces the tapped brief: the worker edits the message (`RichReply.editTapped`, `CommandJob.messageId` is the tapped message) to the stored `DailyBriefRun.briefText` plus the result, without buttons. Discuss sends a new message instead.

### Evening close-out (implemented)

```
evening-closeout queue: one cron scheduler per linked athlete
  key evening-closeout:<userId>, pattern from Profile.closeoutTime (?? EVENING_CLOSEOUT_DEFAULT_TIME), tz Profile.timezone
        │
        ▼
runEveningCloseout (apps/worker/src/daily-loop/closeout.ts)
  date = localToday(now, timezone)
  claim EveningCloseoutRun (userId, date) ─ quiet/sent ─► skip ─ running within lease ─► CloseoutInProgressError (retry)
  message already stored (retry after a failed send)? ─ yes ─► send it
  activity sync ─ throws ─► run failed, rethrow (nothing written)
  match: closeoutRepo.listDay ─► core matchActivities ─► closeDay ─► closeoutRepo.apply (one transaction)
  notices: missed key session ‖ |deviation| > CLOSEOUT_DEVIATION_THRESHOLD_PCT ‖ unplanned activity
     ─ none ─► run quiet (no message)
     ─ some ─► render, save message on the run, send ─ fails ─► run failed, rethrow (3 attempts)
  run sent
```

- **Matching** (core `closeout.ts`, pure). `matchActivities` drops tombstoned and rest sessions, builds every same-sport (session, activity) pair, sorts by `|actual min − planned min|` (ties: slot, start time, ICU id) and takes pairs greedily while both are free. The result is one-to-one and independent of input order. Leftover sessions are skipped and leftover activities unmatched. `deviationPct` is `(actual − planned) / planned × 100` with one decimal. `guessIntensity` uses bike power vs FTP (`powerZones`, moved here from ai), otherwise average HR vs `Profile.lthr` (Friel bands: < 85% z1, < 90% z2, < 95% z3, < 100% z4, else z5). `isKeySession` (Z4/Z5 or ≥ 90 min) also moved to core, and ai's `missedKeySessions` uses it.
- **Writes** (`closeoutRepo.apply`, one array transaction). Matched sessions are set `completed` with `deviationPct`/`actualIntensity`, and unmatched ones `skipped`. Each of the day's activities gets `closedOutAt` and its `plannedSessionId` (unique, `ON DELETE SET NULL`), cleared first so a link can move between activities. Only rows of that date are touched: sessions without `deletedAt` and activities by `startDateLocal`. `modified_externally` sessions that nothing matched keep their status. Activity sync updates only the ICU fields, so it never resets the link. `completed`/`skipped` rows are already protected from `/plan`, the season publisher and the coach (`PROTECTED_STATUSES`, guardrail `lockedStatuses`).
- **Weekly review data.** `PlannedSession.status`/`deviationPct`/`actualIntensity` per session, plus unplanned activities (`closedOutAt IS NOT NULL AND plannedSessionId IS NULL`). Migration `9c_evening_closeout` also adds `Profile.lthr`/`closeoutTime` and `@@index([userId, startDateLocal])` on `Activity`.
- **Scheduling.** The brief and close-out schedulers come from one cron-scheduler factory and reconcile in `scheduler.ts`, parametrized by job name and `repeat(profile)`. Both are combined into the connect/disconnect scheduler and reconciled at startup. A disabled feature reconciles against no athletes, so its schedulers are removed.

### Weekly stats (implemented)

```
weekly-stats queue: one cron scheduler per linked athlete (same factory and reconcile as the close-out)
  key weekly-stats:<userId>, pattern '<m> <h> * * 1' from WEEKLY_STATS_TIME, tz Profile.timezone
        │
        ▼
runWeeklyStats (apps/worker/src/reviews/weekly-stats.ts)
  isoWeek = job.isoWeek ?? previousIsoWeek(localToday(now, timezone))
  weeklyStatsRepo.loadRange(week.from − 7 .. week.to): sessions (with tombstones), activities, wellness, Profile.lthr
  core computeWeeklyStats ─► weeklyStatsRepo.upsert (userId, isoWeek)
```

- **Computation** (core `reviews/weekly-stats.ts`, pure, deterministic: sorted lists, one decimal). Planned = live non-rest sessions of the week. Actual = all of the week's activities, unplanned included. Per sport: planned/actual minutes, `compliancePct` (null when nothing was planned, never 0), actual distance (km) and TSS (`Activity.load`); planned distance/TSS are null because `PlannedSession` has neither. `unplannedWeek` when no session was planned. Key sessions (`isKeySession`) split by status: `completed` → hit, `skipped` → missed, anything else → pending. Intensity: each activity's minutes go to Z1-2 or Z3+ by `hrIntensity(avgHr, lthr)`, or unknown. Load: the latest CTL row in the 7 days before the week → the latest in the week, with deltas. Wellness: week averages and HRV change vs the 7 days before.
- **Storage.** `WeeklyStats` (migration `9d_weekly_stats`): unique `(userId, isoWeek)`, `weekStart`/`weekEnd`, `unplannedWeek`, and the full result as versioned JSON in `stats` (`WEEKLY_STATS_VERSION`). The upsert is idempotent, so the job needs no run row or lease; a retry recomputes the same week.

### Weekly review (implemented)

```
weekly-review queue: one cron scheduler per linked athlete (same factory and reconcile as weekly stats)
  key weekly-review:<userId>, pattern '<m> <h> * * 0' from WEEKLY_REVIEW_TIME, tz Profile.timezone
        │
        ▼
runWeeklyReviewJob (apps/worker/src/reviews/weekly-review.ts)
  claim WeeklyReviewRun (userId, isoWeek of local today)   ─ already sent → skip; lease held → retry later
  stored reportText? ─► resend it (no LLM call, no second CoachDecision)
  activity sync (failure → stale note) → runWeeklyStats(current week)
  season position (this week, next week) + next week's PlannedSession rows + getRulesContext(next Monday)
  ai runWeeklyReview: prompts/weekly-v1.md → requestStructured (one repair)
        → runWeeklyGuardrails → CoachDecision (origin 'weekly')
  renderWeeklyReport (≤ 15 lines) → saveReport → send → markSent
```

- **Output** (ai `weekly/schema.ts`). `{ summary, wins, concerns, nextWeekChanges: SessionDiff[], blockAdjustment: { kind: 'scale_volume', factor 0.6–1.08, reason } | null }`. Wins and concerns are cut to two each.
- **Guardrails** (ai `weekly/guardrails.ts`, pure). Changes and a block adjustment together are rejected. A block adjustment expands into one `durationMin` change per active, unlocked session, rounded to 5 min towards the original so the week never moves further than the factor. Then `runGuardrails` runs unchanged (integrity, clamps with action `reduce` so nothing is cancelled, new `checkHardRules` violations), and finally the ramp cap: the patched week's minutes may exceed the original by at most `maxRamp` (`WEEKLY_REVIEW_MAX_RAMP_PCT`, default 8%, the block generator's `maxWeeklyRamp`). Any reject falls back to `deterministicRecommendation` on next week; the LLM's summary/wins/concerns are kept with a note. LLM down or invalid twice falls back to `fallbackReview(stats)`. Every run writes exactly one decision. Its `finalAction` is derived (`keep`/`reduce`/`move`/`swap`, or `adjust` when a change adds minutes or intensity; `adjust` exists only for stored decisions).
- **Prompt** (`weekly-v1.md`, `renderWeeklySections`). Volume per sport with the gap in minutes and the actual km, key sessions, intensity, load, wellness, season block for this and next week, and next week's sessions with ids. Pure and byte-deterministic; snapshots in `packages/ai/test/weekly/__snapshots__`.
- **Apply** reuses `coach-apply.ts`. `decisionWindow` gives a weekly decision the ISO week after `CoachDecision.date` (Monday..Sunday) instead of today..+6, so a Sunday tap reaches next Sunday. `stillValid` re-runs `runWeeklyGuardrails` (ramp cap included) on the current rows, with tap-time today as the past cut-off. `findAnswerText` returns the `WeeklyReviewRun.reportText` so the answer edits the report. Push, rollback and Discuss are unchanged.
- **Storage.** Migration `9e_weekly_review`: `CoachDecisionOrigin` += `weekly`, `CoachAction` += `adjust`, and `WeeklyReviewRun` (unique `(userId, isoWeek)`, lease via `startedAt`, `coachDecisionId`, `reportText`/`reportKeyboard`, `stale`, `stageTimings`).

### Block review and season re-projection (implemented)

```
block-review queue: one Sunday cron scheduler per linked athlete (same factory and reconcile as the weekly review)
  key block-review:<userId>, pattern '<m> <h> * * 0' from BLOCK_REVIEW_TIME, tz Profile.timezone
/race move <date> <new date> on the active A-race → one-off job {trigger: 'race_move', raceId, previousDate, newDate}
        │
        ▼
runBlockReviewJob (apps/worker/src/reviews/block-review.ts)
  active season (seasonReprojectRepo.findActiveRecord: id, updatedAt, weeklyHoursAvailable, weakSport)
  block_end: today must be the last day of a block (not taper/race) → key block:<order>, freeze = today
  race_move: the A-race must still be that race at the new date → key race:<raceId>:<date>,
             freeze = this Sunday, reviewed block = the current block cut to its elapsed weeks
  claim BlockReviewRun (userId, seasonPlanId, key)   ─ already sent → skip; lease held → retry later
  stored reportText? ─► resend it (no LLM call, no second CoachDecision)
  activity sync (failure → stale note) → runWeeklyStats(this week) → weeklyStatsRepo.listRange(block weeks)
  core computeBlockVerdict → seed (reprojectionSeed, or the last 4 weeks' hours on a race move)
  core reprojectSeason(season, aRace, freeze, seed) → candidate (SeasonGenerationError → no candidate)
  ai runBlockReview: prompts/block-v1.md → requestStructured (one repair) → keep | reproject
        → CoachDecision (origin 'block', finalAction adjust | keep, no session changes)
  renderBlockReport (verdict, old-vs-new tables, Confirm/Decline) → saveReport (proposal, seasonUpdatedAt) → send
        │
        ▼
block_confirm / block_decline (br:c|d:<runId>) → handleBlockReviewAnswer (apps/worker/src/block-review-apply.ts)
  decline → CoachDecision accepted=false, userAction keep; the season is untouched
  confirm → seasonReprojectRepo.applyReprojection in one transaction:
              decision accepted (only while unanswered) + SeasonPlan updateMany WHERE updatedAt = seasonUpdatedAt AND aRace.date = proposal.raceDate
              (else rolled back → 'stale', recorded as a declined apply)
              → truncate the cut block, delete blocks after the frozen ones, insert the new ones
          → queue season-rolling-publish (writes T+1 onward only) → edit the report with the result
```

- **Verdict** (core `reviews/block-verdict.ts`, pure). `volumeAchievedPct` = actual minutes / (`targetWeeklyHours` × 60 × weeks with stats); weeks without a `WeeklyStats` row count neither way and are listed. CTL from the first week's `load.start` to the last week's `load.end`, `ctlGap` against `targetCtl` (null today: the generator doesn't set it). `complianceTrend` is the least-squares change over the weekly compliance values, flat within ±5 points.
- **Seed** (`reprojectionSeed`). The next block's planned `targetWeeklyHours` times the share achieved, capped at one ramp step above plan. 70% achieved → the next block's first load week is 70% of its planned level (then clamped by `startingLoad` to ≥ 50% of the available hours).
- **Re-projection** (core `season/reproject.ts`, pure). Blocks that end by the freeze date are copied byte for byte; a block spanning it is cut to its elapsed weeks. If the race week is unchanged and the freeze sits on a block boundary, the remaining blocks keep their types and lengths; otherwise the remaining whole weeks are allocated like a new season (`allocateBlockLengths`, or peak + taper + race on a runway shorter than the generator's minimum), and phases the season is already past become the current phase (never past `peak`, so a later race after the taper started gets a peak, not a longer taper). Volumes come from `buildWeeklyVolumes` with `firstIndex` = the season week after the freeze, so the 3:1 recovery cadence continues; targets use the shared `season-weeks.ts` helpers. The result passes `validateSeasonPlan`. The fast-check property test asserts the ramp cap, validity and the unchanged frozen prefix.
- **Keep or re-project** (ai `block/run.ts`). The LLM recommends; a race move or volume outside 100 ± `BLOCK_REVIEW_REPROJECT_THRESHOLD_PCT` forces the proposal (`verdict: 'clamp'` when it overrides a `keep`). LLM down or invalid twice → `fallbackBlockReview(verdict)` and the threshold rule. No candidate → keep with a note. Prompt snapshots in `packages/ai/test/block/__snapshots__`.
- **Answers.** Block decisions are not answerable through `cc:` (coach-apply returns not found); `findAnswerText` reads `BlockReviewRun.reportText` for them. The bot routes `br:` taps like the season buttons (no client-side TTL); the worker enforces `BLOCK_REVIEW_TTL_HOURS`.
- **Storage.** Migration `9f_block_review`: `CoachDecisionOrigin` += `block`, `SeasonPlan.weeklyHoursAvailable`/`weakSport` (the wizard's answers; legacy seasons fall back to the busiest block's hours), and `BlockReviewRun` (unique `(userId, seasonPlanId, key)`, `trigger`, lease via `startedAt`, `verdict`, `proposedBlocks` = `{raceDate, startDate, frozenCount, truncated, blocks}`, `freezeThrough`, `seasonUpdatedAt`, report fields, cascade with the season and the user).

### Race briefs (implemented)

```
race-brief queue: one daily cron scheduler per linked athlete (same factory and reconcile as the morning brief)
  key race-brief:<userId>, pattern '<m> <h> * * *' from RACE_BRIEF_TIME, tz Profile.timezone
        │
        ▼
runRaceBriefJob (apps/worker/src/races/race-brief.ts)
  today = local date; races dated today+7 and today+1 (raceRepo.findByDate) → core raceBriefKind:
    t1 for any priority, t7 only for an A-race; nothing due → no-op
  per (race, kind): claim RaceBriefRun (userId, raceId, kind, raceDate)  ─ already sent → skip; lease held → retry later
  stored briefText? ─► resend it (no LLM call)
  t7: planned sessions today..+6 + core raceChecklist
  t1: activity sync (failure → stale note) → core buildPacingPlan(FTP, run efforts) → bike band, run band | null, fueling
  ai runRaceBrief (prompts/race-brief-v1.md): intro + outro only; digits in the reply → fixed fallback text
  renderRaceBrief (HTML, everything escaped) → saveBrief → send → markSent
```

- **Pacing** (core `race/pacing.ts`, pure). `bikeTarget` = FTP × the race type's % band, rounded to watts. `estimateRunThreshold` takes the fastest run of 20–60 min within 90 days (`Activity.distanceM` and `durationSec`; whole-run averages, so it is a proxy) and `runTarget` applies a per-type factor with a ±2% band; no qualifying run gives `null` and the brief says so. `fuelingPlan` and `swimNote` are per type. Everything is in `DEFAULT_RACE_PACING_CONFIG`.
- **Checklist** (core `race/checklist.ts`) per race type; `raceBriefKind` (core `race/brief.ts`) is the A vs B/C matrix.
- **Storage.** Migration `9h_race_brief`: `RaceBriefRun` (unique `(userId, raceId, kind, raceDate)`, cascade on user and race), enums `RaceBriefKind`, `RaceBriefStatus`.

## Security Considerations

### Current Protections

✅ **Input Validation**

- All commands validated before processing
- Zod schema for env vars
- Prisma ORM prevents SQL injection

✅ **Idempotency**

- ProcessedMessage table prevents duplicate logs
- Important for `/log` command

✅ **Error Handling**

- Never crash on bad input
- Graceful error messages to users
- Full error logging with Pino

✅ **No Secrets in Code**

- All config via env vars
- .env.example for documentation only

✅ **Encrypted Credentials**

- intervals.icu API keys are stored with AES-256-GCM (`packages/core/src/crypto.ts`), with the key from `SECRETS_ENC_KEY`
- Rotation: set the new key as `SECRETS_ENC_KEY` and the old one as `SECRETS_ENC_KEY_PREVIOUS`. Decryption tries both keys; new writes use the current key
- The key is encrypted in the bot before enqueueing, and the user's Telegram message containing it is deleted
- Keys are never echoed back; `/connect status` shows only the last 4 characters

✅ **Log Redaction**

- All loggers come from `createLogger()` in core, with pino `redact` on `LOG_REDACT_PATHS` (`apiKey`, `icuCredentials`, `rawText`, `args`, `message.text`, `authorization` headers, …)
- The bot logs update metadata only (ids, text length), never message text
- Covered by `packages/core/test/logger.test.ts`

### Recommended Additions

⚠️ **Rate Limiting**

```typescript
// Add to worker
const limiter = new RateLimiter(redis);
await limiter.checkLimit(userId, '10/minute');
```

⚠️ **User Authentication**

- Current: Trust Telegram user ID
- Better: Verify user via Telegram authentication

⚠️ **Data Encryption**

- Extend `encryptSecret` to other sensitive profile data (if adding HR zones, health data)

## Monitoring & Observability

### Logging

**Current**: Pino JSON logs to stdout

**Production**: Ship to aggregation service

```bash
# Example: Send to Datadog
docker compose logs -f worker | datadog-agent
```

### Metrics to Track

1. **Queue Metrics**
   - Jobs waiting
   - Jobs processing
   - Jobs failed
   - Average processing time

2. **Business Metrics**
   - New users per day
   - Plans generated per day
   - Workouts logged per day
   - Active users (7d, 30d)

3. **System Metrics**
   - Worker CPU/memory
   - Database connection pool
   - Redis memory usage

### Alerts

**Critical**:

- Queue depth > 100 (workers overwhelmed)
- Failed job rate > 5% (something broken)
- Database connection failures

**Warning**:

- Average job time > 10s (slow queries?)
- Redis memory > 80% (needs scaling)

## Testing Strategy

### Current Tests

✅ **Unit Tests** (`packages/core/test/`)

- Rules engine (5+ test cases)
- Edge cases and interactions
- Run with `npm test`

### Recommended Additions

📋 **Integration Tests**

```typescript
// Test full command flow
it('should process /plan command end-to-end', async () => {
  const job = await queue.add('command', { ... });
  await job.waitUntilFinished();
  // Assert database state, Telegram API calls
});
```

📋 **Load Tests**

```bash
# Simulate 100 concurrent users
k6 run load-test.js
```

📋 **E2E Tests**

```typescript
// Test against real Telegram (staging bot)
await bot.sendMessage('/plan');
const response = await waitForResponse();
expect(response).toContain('7-Day Training Plan');
```

## Deployment

### Local Development

```bash
docker compose up -d postgres redis
npm run dev:bot
npm run dev:worker
```

### Production (Docker)

```bash
docker compose up -d --build
```

### Production (Kubernetes)

Example manifests:

```yaml
# bot-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: triathlon-bot
spec:
  replicas: 1 # Single bot instance
  selector:
    matchLabels:
      app: bot
  template:
    spec:
      containers:
        - name: bot
          image: triathlon-bot:latest
          env:
            - name: TELEGRAM_BOT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: telegram-secret
                  key: token
```

```yaml
# worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: triathlon-worker
spec:
  replicas: 3 # Scale horizontally
  selector:
    matchLabels:
      app: worker
  template:
    spec:
      containers:
        - name: worker
          image: triathlon-worker:latest
```

## Future Architecture Improvements

1. **Event Sourcing**
   - Store all events (WorkoutLogged, PlanGenerated)
   - Rebuild state from events
   - Better audit trail

2. **CQRS**
   - Separate read/write models
   - Read replicas for queries
   - Write primary for commands

3. **GraphQL API**
   - Add HTTP API alongside Telegram
   - Web dashboard for coaches
   - Mobile app integration

4. **Microservices**
   - Plan Service (plan generation)
   - Analytics Service (stats, insights)
   - Notification Service (reminders)

5. **Real-Time Features**
   - WebSocket for live updates
   - Training partner matching
   - Group workouts

## Conclusion

This architecture balances:

- **Simplicity** (easy to understand and maintain)
- **Scalability** (queue-based, horizontal scaling)
- **Reliability** (idempotency, retries, error handling)
- **Testability** (pure functions, dependency injection)
- **Extensibility** (LLM-ready, modular design)

It's production-ready for MVP while providing a solid foundation for future growth.
