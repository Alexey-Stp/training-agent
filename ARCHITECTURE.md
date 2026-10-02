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

**Design Principles**:

- Thin layer - no business logic, with one exception: the `/connect icu` dialog (see [Athlete linking](#athlete-linking-connect-icu))
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
- `week-command.ts` - `/week show` handler: finds today's block week in the active season and expands it (injected `SeasonRepo`, rules context and clock)
- `icu-connect.ts` - `connect_icu` / `/connect status` / `/disconnect icu` handlers (injected repo + ICU client for testing)
- `activity-sync.ts` - ICU activity sync: window, mapping, idempotent diff, `icu-activity-sync` job processor, shared `runIcuSyncJob` error mapping (injected deps)
- `wellness-sync.ts` - ICU wellness sync: mapping, device-only merge, `icu-wellness-sync` job processor (injected deps)
- `sync-command.ts` - `/sync` handler (activities, then wellness)
- `sync-scheduler.ts` - per-athlete BullMQ job schedulers (activity, wellness, plan reconcile) on the `icu-sync` queue, startup reconciliation
- `plan-store.ts` - stores the generated week as `PlannedSession` rows: `diffPlan` on (date, slot), tombstones for pushed sessions that leave the plan
- `plan-push.ts` - `IcuEventPusher`: creates/updates/deletes ICU `WORKOUT` events for pending sessions, `external_id` orphan adoption, `hashIcuEvent` (injected deps)
- `plan-reconcile.ts` - `icu-plan-reconcile` job processor: flags sessions whose ICU event was moved/edited/deleted as `modified_externally` (injected deps)
- `plan-command.ts` - `/plan push` handler (store, push, reply)
- `db.ts` - Database utilities (user creation, deduplication, `icuConnectionRepo`, `activityRepo`, `wellnessRepo`, `plannedSessionRepo`, `seasonRepo`)

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
- `season/` - Season domain model (`Race`, `SeasonPlan`, `TrainingBlock` and their enums), `validateBlockSequence` / `validateSeasonPlan` / `assertValidSeasonPlan` (`SeasonValidationError`), the zod-checked `serializeSeasonPlan` / `parseSeasonPlan`, and `generateSeasonPlan` (`block-generator.ts`): blocks allocated backwards from the A-race with short-runway compression (`block-sequence.ts`), a ≤8% ramp with 3:1 recovery weeks from the current load (`volume.ts`), and a per-sport split with weak-sport bias (`sport-split.ts`). All constants are in `DEFAULT_BLOCK_GENERATOR_CONFIG` (`generator-config.ts`). `week-expander.ts` has `expandWeek(block, weekIndex, profile)`. It picks a session template for the block type (base, build/peak, taper/race, recovery/transition), places the sessions by the profile's day preferences, sizes them to the week's targets, and gates the result through `applyRules` + `checkHardRules`

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
   - `date`, `name`, `priority` (`A` | `B` | `C`), `type` (`sprint` | `olympic` | `half` | `full` | `run` | `other`)
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
/plan, /plan push   → generateDraftPlan → applyRules → toPlannedSessions → materializePlan(today..today+6)
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
