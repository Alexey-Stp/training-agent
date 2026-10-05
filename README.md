# Triathlon Coach Telegram Bot MVP

A production-ready Telegram bot for personal triathlon coaching with clean architecture, queue-based processing, and intelligent rules engine.

## Architecture

```
Telegram → Bot Gateway (grammY) → Queue (BullMQ/Redis) → Worker → Postgres → Telegram response
```

### Key Design Principles

- **Bot Service**: Thin gateway that validates and enqueues jobs only
- **Worker Service**: Handles all business logic, database operations, and responses
- **Core Package**: Shared types, rules engine, and business logic
- **Queue-Based**: Scales to 1000+ users with BullMQ/Redis
- **Rules Engine**: Deterministic plan generation with intelligent adjustments
- **LLM-Ready**: Architecture supports future LLM/RAG integration without rewrites

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript (strict mode)
- **Telegram**: grammY
- **Database**: PostgreSQL + Prisma ORM
- **Queue**: BullMQ (Redis-backed)
- **Cache**: Redis
- **Testing**: Vitest
- **Deployment**: Docker Compose
- **CI/CD**: GitHub Actions
- **Code Quality**: ESLint + Prettier

## Developer Experience

### VSCode Integration

Full VSCode integration with tasks, debugging, and recommended extensions:

- **20+ Tasks** - Build, test, run, Docker operations (`Ctrl+Shift+P` → "Tasks")
- **Debug Configurations** - Debug bot, worker, or tests with breakpoints (`F5`)
- **Format on Save** - Auto-format with Prettier
- **Lint on Save** - Auto-fix with ESLint
- **Test Explorer** - Run/debug individual tests

See [CI_CD.md](CI_CD.md) for complete VSCode setup.

### CI/CD Pipeline

Automated checks on every push and PR:

- ✅ **Linting** - ESLint code quality checks
- ✅ **Type Checking** - Strict TypeScript validation
- ✅ **Tests** - All unit tests with coverage
- ✅ **Build** - Verify all packages build successfully
- ✅ **Docker** - Build and test Docker images
- ✅ **Integration** - Test with real Postgres & Redis
- ✅ **Security** - CodeQL vulnerability scanning
- ✅ **Dependencies** - Automated Dependabot updates

**Quick Commands:**

```bash
npm run lint          # Lint code
npm run format        # Format code
npm run typecheck     # Type check
npm run ci            # Run all checks locally
```

See [CI_CD.md](CI_CD.md) for complete CI/CD documentation.

## Project Structure

```
.
├── apps/
│   ├── bot/              # Telegram bot gateway service
│   │   ├── src/
│   │   │   ├── index.ts      # Main bot entry point
│   │   │   ├── parser.ts     # Command parsing
│   │   │   ├── queue.ts      # BullMQ queue setup
│   │   │   └── logger.ts     # Pino logger
│   │   ├── Dockerfile
│   │   └── package.json
│   └── worker/           # Background job processor
│       ├── src/
│       │   ├── index.ts      # Worker entry point
│       │   ├── handlers.ts   # Command handlers
│       │   ├── db.ts         # Database utilities
│       │   └── logger.ts     # Pino logger
│       ├── Dockerfile
│       └── package.json
├── packages/
│   └── core/             # Shared business logic
│       ├── src/
│       │   ├── types.ts          # Core domain types
│       │   ├── config.ts         # Environment config
│       │   ├── plan-generator.ts # Draft plan generation
│       │   ├── rules-engine.ts   # Plan validation rules
│       │   └── index.ts
│       ├── test/
│       │   └── rules-engine.test.ts  # Comprehensive tests
│       └── package.json
├── prisma/
│   └── schema.prisma     # Database schema
├── docker-compose.yml    # Full stack orchestration
├── .env.example          # Environment template
├── package.json          # Root workspace config
└── README.md
```

## Features

### MVP Commands

- `/start` - Welcome message and help
- `/profile` - View current training profile
- `/set ftp <number>` - Update FTP (e.g., `/set ftp 280`)
- `/plan` - Generate 7-day training plan with rules applied (saved, shows each session's intervals.icu status). With an active season, days the season covers show the season's sessions
- `/plan push` - Put the 7-day plan on your intervals.icu calendar as structured workouts (they sync to Garmin)
- `/week show` - Show this week of your active season plan: the block's targets, the sessions that hit them, and any rules-engine adjustments
- `/race add <yyyy-MM-dd> <type> <A|B|C> <name>` - Add a race (type: `sprint|olympic|half|full|run|other`), e.g. `/race add 2027-06-12 olympic A Prague Triathlon`
- `/race list` - Show your upcoming races
- `/season new` - Season wizard: pick weekly hours and your weak sport (inline buttons), review the block table, then save. Replacing an active season needs its own **Replace** button
- `/season show` - Show the active season's block table and where today is
- `/log <sport> <minutes> [intensity]` - Log completed workout
- `/connect icu` - Link your intervals.icu account (asks for athlete ID, then API key)
- `/connect status` - Show the linked athlete, masked API key and last sync times
- `/disconnect icu` - Remove the link and the stored API key
- `/sync` - Pull your latest intervals.icu activities and wellness now

### Default Profile

New users automatically get:

- **FTP**: 355W
- **Timezone**: Europe/Prague
- **Swim Days**: Wed (technique), Fri (intervals), Sun (optional)
- **Bike VO2 Day**: Thursday
- **Long Bike Day**: Sunday
- **No Long Run Day**: Sunday

### Rules Engine

The plan generator applies these rules automatically:

#### Hard Rules (Enforce Safety)

1. **NoHardHard**: No consecutive hard days (Z4/Z5 or tagged vo2/threshold). Second day downgraded to Z2. Two hard sessions on the same day are allowed, and an easy session after a hard one on the same day doesn't let a hard session through the next day.
2. **ReadinessDownshift**: If today's check-in readiness (`Wellness.subjectiveReadiness`) is ≤ 2, downgrade today's hard sessions to Z2.
3. **WeeklyLoadCap**: Limit weekly volume to 110% of previous week (10% progressive overload). Scales durations proportionally, min 30min per session.

`applyRules` corrects a plan. `checkHardRules(plan, context)` only checks one and returns the hard rules it still breaks (`RuleViolation[]`, empty when it passes). For example, the 30-minute floor can keep a week over the load cap.

#### Soft Rules (Optimize Structure)

4. **SwimRotation**: Enforce Wed = technique, Fri = intervals.

### Season Planning

A season is stored as a `SeasonPlan` (start date, status, optional A-race) with ordered `TrainingBlock` rows (`base`, `build`, `peak`, `taper`, `race`, `recovery`, `transition`, each with a start date, a length in weeks and weekly swim/bike/run targets). Races are stored as `Race` rows with priority A, B or C. `@triathlon/core` `validateSeasonPlan` checks that:

- blocks are contiguous: each block starts the day after the previous one ends, with no gaps or overlaps;
- the block containing the A-race is a `race` block that ends on race week and comes right after a `taper` block.

Every issue names the blocks involved, e.g. `block 2 (build) ends 2026-04-26 but block 3 (peak) starts 2026-05-04: 7-day gap`. `/season new` creates a season (see [Season wizard](#season-wizard)), `/season show` and `/week show` read the active one.

`generateSeasonPlan({ aRace, weeklyHoursAvailable, currentWeeklyLoad, weakSport?, startDate })` builds the block sequence backwards from the A-race. It is a pure function in `@triathlon/core`, and every constant comes from `DEFAULT_BLOCK_GENERATOR_CONFIG`, which can be overridden:

- **Blocks**: race week (1w) ← taper (half 2w, full 3w, others 1w) ← peak (3w) ← two build blocks (4w each) ← base for the remaining weeks (split base1/base2 from 6 weeks). A half-distance race 24 weeks out gives `base 5 · base 5 · build 4 · build 4 · peak 3 · taper 2 · race 1`.
- **Short runways**: the generator shortens peak, then the build blocks, then drops the second build, until base has at least 3 weeks. Taper and one build block are always kept. Each step, and any base under 8 weeks, is reported in `warnings`, e.g. 10 weeks gives `base 3 · build 3 · peak 1 · taper 2 · race 1`.
- **Volume**: week 1 starts from the athlete's current weekly load, clamped to 50–100% of available hours. Load weeks grow at most 8% over the previous load week, capped at 85% (base), 95% (build) or 100% (peak) of available hours. Every 4th plan week in base/build/peak is a recovery week at 60% of the last load week. Taper weeks drop to 75/60/50% and race week to 45%.
- **Sport split** by race type (half: swim 15% / bike 55% / run 30%). In base weeks the weak sport gets +10 percentage points, taken from the other sports in proportion to their shares.

It returns the `TrainingBlock[]` (weekly targets are the mean of the block's weeks), a per-week `weeks[]` breakdown, the aligned plan `startDate` (a Monday) and `warnings[]`. The output passes `validateSeasonPlan`.

#### Week expander

`expandWeek(block, weekIndex, profile, { context?, targets?, config? })` turns one week of a block into concrete sessions:

- **Targets**: the block's weekly averages by default. Swim metres are converted at 2500 m/h and run km at 10 km/h, then the sport hours are scaled to add up to `targetWeeklyHours`. Pass `targets` (e.g. a `SeasonWeek` from `generateSeasonPlan`) to size a recovery week inside a block.
- **Templates by block type**:
  - **base**: endurance and technique, no Z4/Z5. Wed technique swim, Fri aerobic intervals swim, easy bike, tempo bike, long bike, easy run with strides, easy run, long run.
  - **build/peak**: the same frame with key sessions: bike VO2 Z5, run threshold Z4, swim threshold Z4.
  - **taper/race**: short openers. At most 2 intensity touches (bike and run openers), every session ≤ 75 min. Volume over the cap is reported in `warnings`.
  - **recovery/transition**: the base frame with every session easy.
- **Placement from the Profile**:
  - swims go on `swimDays` (the `_optional` day gets the optional swim);
  - the long bike goes on `longBikeDay` and the key bike on `bikeVo2Day`;
  - the long run goes on the first of Sat, Sun, Tue, … that is neither the long-bike day nor `noLongRunDay`;
  - the key run never goes next to the key bike day.
- **Sizing**: each sport's minutes are split across its sessions by template weight, in 5-minute steps. Sessions under 20 min are dropped (the optional swim first) and their minutes go to the sport's other sessions. The draft hits the total within ±5% and each sport within ±10%.
- **Rules gate**: the draft goes through `applyRules`, then `checkHardRules`. The result has the rules-applied `plan`, `PlannedSessionDraft[]` `sessions` and `violations`, which is empty unless a rule can't fully correct the week. Example: in a default-profile build week the Fri threshold swim follows Thu VO2, so NoHardHard downgrades it.

`draftBlockWeek` returns the draft before the rules run. `blockWeekTargets`, `blockWeekStart`, `weekIndexForDate` and `weekVolume` are the helpers around it. `/week show` expands the week of the active season that contains today and shows it. It doesn't store anything.

`seasonDraftsForRange(season, profile, { from, to }, getContext)` (core `season/window.ts`) expands every block week touching a date range and cuts it to the range, clipped to the season. Both `/plan` and the rolling publisher use it, so they store the same sessions for the same days.

#### Season wizard

1. `/race add` stores the races. A season is built towards the next upcoming **A** race; B and C races inside it are listed in the preview with the block they fall in.
2. `/season new` (bot, `season-dialog.ts`, state in Redis for 10 minutes) asks for the maximum weekly hours (6–18h buttons, or type 3–30) and the weak sport (swim/bike/run/none). `/cancel` or any other command ends it.
3. The bot enqueues `season_preview`. The worker averages the last 4 weeks of synced activities as the current load (or assumes half the available hours when there are none), runs `generateSeasonPlan` from today, stores the result as a **draft** `SeasonPlan` (replacing any earlier draft) and replies with the block table:

For an olympic A race on 2027-06-13, 10h/week, weak sport bike, run on 2026-10-07:

```
# Type  Dates       Wk h/wk Swim Bike  Run
1 base  12.10-27.12 11  7.4 3.0k 4.1h 21km
2 base  28.12-14.03 11  7.6 3.1k 4.2h 22km
3 build 15.03-11.04  4  8.4 4.2k 3.8h 29km
4 build 12.04-09.05  4  8.6 4.3k 3.9h 30km
5 peak  10.05-30.05  3  8.7 4.3k 3.9h 30km
6 taper 31.05-06.06  1  7.5 3.8k 3.4h 26km
7 race  07.06-13.06  1  4.5 2.3k 2.0h 16km
```

4. **✅ Save season** activates the draft. If a season is already active, the preview warns and shows **♻️ Replace current season** instead; only that button archives the old season. A confirm without it is refused on the server (in one transaction), so a season activated after the preview was sent can't be replaced by accident. **✖ Cancel** deletes the draft.

Buttons are removed after a tap, and callback jobs use a BullMQ `jobId` per tapped message, so a double tap enqueues one job.

#### Rolling publisher

Each linked athlete has a fourth repeatable job on the `icu-sync` queue, `season-rolling-publish` (every `SEASON_PUBLISH_EVERY_MIN`, default 360). Saving a season also queues one run straight away. Each run:

- computes today (T) in `Profile.timezone`, so the window moves at the athlete's local midnight;
- expands the active season for **T+1..T+`SEASON_PUBLISH_WINDOW_DAYS`** (default 14), clipped to the season;
- stores the sessions with `materializeRange` and pushes them with `pushPlannedSessions` from T+1.

Days ≤ T are never read, diffed or pushed. The usual `PlannedSession` rules apply: unchanged sessions are not written (a repeat run makes no ICU calls), and sessions the athlete moved, edited or deleted in intervals.icu (`modified_externally`) or completed/skipped are left alone.

Known limitation: per-week `SeasonWeek` targets aren't stored, so published weeks use the block's weekly averages and in-block recovery weeks are not reduced.

## LLM Coaching Context

`packages/ai` (`@triathlon/ai`) holds the LLM provider adapter (Anthropic or mock, every call logged to `LlmCallLog`) and the daily context builder. `buildDailyContext(deps, userId, date)` reads the athlete's profile, active season, wellness, activities, planned sessions, coach decisions and races through injected repositories and renders the versioned template `packages/ai/src/prompts/daily-v1.md`. It covers:

- profile, FTP and power zones;
- season position (block, week X of Y, days to the A-race);
- wellness today plus a 7-day trend, HRV against its 30-day baseline (flagged below mean − 1 SD) and CTL/ATL/TSB;
- compliance per sport over the last 7 days and missed key sessions (Z4/Z5 or ≥90 min) over the last 14;
- today and the next 3 days, sessions changed in intervals.icu, the last 5 coach decisions, and upcoming races.

The prompt is deterministic: the same data gives a byte-identical prompt. Missing data is stated ("no device data") rather than left out. If the prompt exceeds `AI_CONTEXT_TOKEN_BUDGET` (default 6000, estimated at 4 characters per token), the oldest training history days are dropped first, then the oldest coach decisions, then wellness trend days. Races, key sessions and upcoming sessions are always kept. Snapshot tests of three fixture athletes live in `packages/ai/test/context/__snapshots__/`.

### Coach suggestions

`runCoachSuggestion` sends the daily context to the LLM and asks for a structured `CoachSuggestion`: an assessment, an action (`keep`, `reduce`, `swap`, `move` or `rest`), field-level session changes, a confidence and a message for the athlete. An invalid reply gets one repair attempt. Every suggestion then passes deterministic guardrails:

- no session loses more than 50% in one change (cancelling needs action `rest`);
- no sessions moved onto rest days, and no intensity increases when readiness is 2/5 or lower;
- no new hard-hard days, low-readiness hard sessions or weekly load cap breaches (the core rules engine checks the patched plan).

A suggestion that breaks a hard rule, or an LLM that is down or answers invalid JSON twice, falls back to the rules engine's own recommendation. Every run, whatever its outcome, is stored as a `CoachDecision` row for audit. No new env vars; the limits are in `DEFAULT_GUARDRAIL_CONFIG`.

### Coach chat

Any message that isn't a `/command` goes to the coach. The worker answers it with the daily context, the plan for today and the next 6 days, and the last 10 chat messages (`CoachChatMessage`, both directions). Answers name the athlete's actual sessions and numbers.

- **Plain answers.** A question like "why Z2?" gets a text answer and nothing else.
- **Plan changes.** "Can I move the long ride to Saturday?" gets an answer plus a `CoachSuggestion` that goes through the same guardrails as above, then **✅ Apply** / **↩️ Keep my plan** buttons. Apply re-checks the change against the current plan, writes it (a move gets a free slot on the new day and keeps its intervals.icu event; a cancel tombstones the session), and pushes it to intervals.icu. Sessions changed this way are marked with the decision, so `/plan` and the season publisher don't undo them. A rejected suggestion is answered with the reasons and no buttons; there is no rules-engine fallback in chat.
- **Medical boundary.** The system prompt (`prompts/chat-system-v1.md`) makes the coach say "I'm not a doctor" for pain, injury, illness or medication questions, keep to general guidance and recommend a professional.
- **Limit.** `COACH_CHAT_DAILY_LIMIT` messages (default 30) per athlete per local day, counted in Redis. Over it, the athlete gets a polite notice and no LLM call is made.

### Morning brief

Every linked athlete gets one brief a day at `Profile.briefTime` in their own timezone (default `DAILY_BRIEF_DEFAULT_TIME`, 06:30). The worker syncs wellness and activities from intervals.icu, builds the daily context, asks the coach for a suggestion (guardrails as above) and sends the brief:

```
☀️ Morning brief: Mon 5 Oct

🟡 HRV is below your 30-day baseline: listen to your body today.

Today
🚴 VO2 5x4 (70min • Z5)

Coach
HRV is low and sleep was short. Take the VO2 set down a notch.

Proposed
• Bike VO2 5x4 70′→50′, Z5→Z3

[✅ Apply] [➡️ Keep plan]
[💬 Discuss]
```

- **Check-in first.** When today has no device wellness from intervals.icu, or HRV is more than 1 SD from its 30-day mean (either way), the brief starts with a one-message check-in: readiness 1–5 and soreness none / mild / severe as buttons. Each answer is saved to today's wellness and its row disappears. The brief follows as soon as both are answered, built with the answers, or after `DAILY_CHECKIN_TIMEOUT_MINUTES` (15) with whatever was answered; with no answer at all it says "No check-in today". Complete, normal data skips the check-in.
- **Readiness line.** Worst signal wins: check-in readiness ≤ 2/5 (or low HRV plus TSB below −20) is 🔴, low HRV vs the 30-day baseline, TSB below −20 or a 3/5 check-in is 🟡, otherwise 🟢; ⚪ when there is no data.
- **✅ Apply** writes the changes in one transaction and pushes only those sessions to intervals.icu. The brief is then edited to list the exact changes. If the push fails, the changes are undone (sessions already sent to intervals.icu are marked for the next `/plan push`), the decision stays open and the brief says so.
- **➡️ Keep plan** records the answer (`CoachDecision.userAction = keep`) and changes nothing.
- **💬 Discuss** puts the suggestion into the coach chat history and asks what to change; the reply carries Apply / Keep plan again. Just answer in the chat.
- **Expiry.** The buttons work for `COACH_DECISION_TTL_HOURS` (24). A later tap gets "This brief has expired" and a pointer to `/plan today`, which lists today's stored sessions.
- Briefs without a proposed change only offer Discuss.

- **One per day.** Each run is keyed on the athlete and local date (`DailyBriefRun`), so a second trigger the same day sends nothing. DST changes move the UTC time, not the local one.
- **intervals.icu down.** The brief still goes out with `⚠️ intervals.icu unavailable: data as of <last sync>`.
- **LLM down.** The brief carries the rules engine's recommendation, and the `CoachDecision` is stored with `source = fallback`.
- **Telegram down.** The job retries the send up to 3 times without syncing or asking the coach again. A bot the athlete blocked is not retried.

Set `DAILY_BRIEF_ENABLED=false` to turn it off; the worker then removes the schedulers on startup.

## intervals.icu Integration

`packages/integrations-icu` (`@triathlon/integrations-icu`) is a typed REST client for [intervals.icu](https://intervals.icu). The worker uses it to validate credentials in `/connect icu` and to sync activities and wellness.

### Linking an account

1. `/connect icu`. The bot asks for your athlete ID (intervals.icu → Settings → Developer Settings, e.g. `i12345`).
2. Send the athlete ID, then your API key. The bot deletes the key message immediately and encrypts the key before it is queued.
3. The worker calls `getAthlete`. On success the connection is stored in `IcuConnection` with the key encrypted (AES-256-GCM). On failure you get an error message and nothing is stored.

### Activity sync

Once an athlete is linked, the worker pulls their activities from intervals.icu into the `Activity` table:

- The first run (right after `/connect icu`) backfills the last 90 days (`ICU_ACTIVITY_BACKFILL_DAYS`).
- After that it runs every 30 minutes (`ICU_ACTIVITY_SYNC_EVERY_MIN`). It re-reads from the last sync minus 2 days (`ICU_ACTIVITY_SYNC_OVERLAP_DAYS`), plus one day for timezones, to catch late uploads.
- Re-linking a different athlete removes the previous athlete's activities and starts a fresh 90-day backfill.
- `/sync` runs it immediately and replies with the number of new and updated activities.
- Activities are keyed by their ICU id. A run with no new data writes nothing. If intervals.icu is down, the job is retried and the sync cursor stays where it was.
- ICU types map to the local sport: Ride/VirtualRide/... → `bike`, Run/TrailRun/... → `run`, Swim/OpenWaterSwim → `swim`, WeightTraining → `strength`, anything else → `other`.

### Wellness sync

The worker also pulls daily wellness into the `Wellness` table, one row per athlete-local day: HRV (rMSSD), resting HR, sleep hours and score, weight, and ICU's CTL/ATL, with TSB computed as CTL − ATL.

- The first run (right after `/connect icu`) backfills the last 90 days (`ICU_WELLNESS_BACKFILL_DAYS`). After that it runs daily (`ICU_WELLNESS_SYNC_EVERY_MIN=1440`) and re-reads the last 3 days (`ICU_WELLNESS_SYNC_OVERLAP_DAYS`), because ICU recomputes CTL/ATL when late activities arrive.
- `/sync` pulls activities first, then wellness.
- Merge rule: sync overwrites the device/ICU columns, nulls included (a night without the HRV strap stores `hrv = null`). It never writes the athlete's check-in columns (`subjectiveReadiness`, `soreness`), and it ignores ICU's own subjective fields.
- Re-linking a different athlete clears the synced device columns and keeps the check-ins.

### Planned workout push

`/plan` and `/plan push` store the generated week as `PlannedSession` rows (today to today + 6, rest days skipped). `/plan push` then writes them to the intervals.icu calendar as `WORKOUT` events:

- **Create / update / delete.** A new session creates an event and stores its `icuEventId`. A session that changes locally (for example a readiness downgrade) updates the same event. A session that drops out of the plan has its event deleted. Pushing twice changes nothing.
- **No duplicates.** Each event carries `external_id = ta-<sessionId>`. If the worker crashes after creating an event but before saving its id, the next push finds the event by `external_id` and updates it.
- **Workout text.** The description holds the coach notes and the steps in intervals.icu workout syntax, which ICU turns into a structured workout for the watch. Bike steps use power zones, run steps use HR zones (`Z4 HR`), and swim steps use pace zones (`Z4 Pace`):

  ```
  Warmup
  - 15m Z2 HR

  Main set 5x
  - 3m Z4 HR
  - 2m Z1 HR

  Cooldown
  - 15m Z1 HR
  ```

- **External edits.** A repeatable `icu-plan-reconcile` job per linked athlete (every 60 minutes, `ICU_PLAN_RECONCILE_EVERY_MIN`) compares a content hash (date, name, sport, description) of each upcoming pushed event with the hash stored at push time. If the athlete moved, edited or deleted the event in intervals.icu, the session is flagged `modified_externally` with the reason (for example "moved to 2026-10-02"). Flagged sessions are never overwritten by `/plan` or `/plan push`. They are shown in `/plan` and in the `/plan push` reply.
- **Statuses.** `draft` (local changes not pushed yet), `pushed`, `modified_externally`, and `completed` / `skipped`, which are reserved for activity matching.

Set `SECRETS_ENC_KEY` in `.env` (base64 of 32 bytes: `openssl rand -base64 32`). Both bot and worker need it. To rotate, move the old key to `SECRETS_ENC_KEY_PREVIOUS` and set a new `SECRETS_ENC_KEY`.

### Client

- **Auth**: HTTP Basic, username `API_KEY`, password = athlete API key. Per-athlete credentials come from `/connect icu`. `ICU_ATHLETE_ID` / `ICU_API_KEY` in `.env` are only for local experiments.
- **Methods**: `getAthlete`, `listActivities(oldest, newest)`, `listWellness(oldest, newest)`, `listEvents(oldest?, newest?)`, `getEvent(id)`, `createEvent`, `updateEvent`, `deleteEvent`.
- **Resilience**: exponential backoff, up to 3 retries on 429/5xx. Responses are validated with Zod, and unknown fields are allowed.
- **Errors**: `IcuAuthError` (401, no retry), `IcuRateLimitError` (429 after retries), `IcuServerError` (5xx after retries), `IcuHttpError` (other 4xx), `IcuContractError` (response failed schema validation, includes the endpoint name).

```ts
import { IcuClient } from '@triathlon/integrations-icu';

const icu = new IcuClient({
  athleteId: process.env.ICU_ATHLETE_ID!,
  apiKey: process.env.ICU_API_KEY!,
});
const activities = await icu.listActivities('2026-09-01', '2026-09-26');
```

See [ARCHITECTURE.md](ARCHITECTURE.md#integrations-icu-package-packagesintegrations-icu) for details.

## Setup Instructions

### Prerequisites

- Node.js 20+
- npm 10+ (or pnpm for faster installs)
- Docker & Docker Compose
- Telegram account

### 1. Create Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow prompts
3. Copy the bot token (format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### 2. Clone and Configure

```bash
# Clone repository
cd TrainingAgent

# Copy environment template
cp .env.example .env

# Edit .env and add your bot token
# TELEGRAM_BOT_TOKEN=your_token_here
```

### 3. Install Dependencies

```bash
# Using npm (included with Node.js)
npm install

# OR using pnpm (faster, recommended)
npm install -g pnpm
pnpm install
```

### 4. Run with Docker Compose

```bash
# Start all services (postgres, redis, bot, worker)
docker compose up --build

# First time: Apply database migrations in another terminal
docker compose exec bot npx prisma migrate deploy

# Existing database created with `db push`? Baseline it once first:
# docker compose exec bot npx prisma migrate resolve --applied 0_init

# Or push schema without migration (faster for dev)
docker compose exec bot npx prisma db push
```

The services will start:

- **PostgreSQL**: localhost:5432
- **Redis**: localhost:6379
- **Bot**: Polling Telegram updates
- **Worker**: Processing jobs from queue

### 5. Test Commands

Open Telegram and message your bot:

```
/start
/profile
/set ftp 280
/plan
/log bike 90 z2
/log run 45 z4
/log swim 60
```

## Development Workflow

### Run Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test -w @triathlon/core -- --watch

# Run tests in specific package
npm -w @triathlon/core run test
```

### Local Development (without Docker)

```bash
# Terminal 1: Start Postgres & Redis
docker compose up postgres redis

# Terminal 2: Run migrations
npm run db:push

# Terminal 3: Start bot
npm run dev:bot

# Terminal 4: Start worker
npm run dev:worker
```

### Database Management

```bash
# Generate Prisma client
npm run db:generate

# Push schema changes (dev)
npm run db:push

# Create migration
npm run db:migrate

# Open Prisma Studio
npm run db:studio
```

### View Logs

```bash
# Follow all logs
docker compose logs -f

# Follow specific service
docker compose logs -f worker
docker compose logs -f bot

# View queue status (Redis CLI)
docker compose exec redis redis-cli
> KEYS *
> LLEN bull:commands:waiting
```

## Sample Outputs

### `/start`

```
👋 Welcome to Triathlon Coach!

I'll help you plan and track your triathlon training.

Available commands:
/start - Show this help
/profile - View your current profile
/set ftp <number> - Set your FTP (e.g., /set ftp 280)
/plan - Generate a 7-day training plan
/plan push - Put the plan on your intervals.icu calendar (syncs to your watch)
/week show - Show this week of your season plan
/race add <yyyy-MM-dd> <type> <A|B|C> <name> - Add a race
  Example: /race add 2027-06-12 olympic A Prague Triathlon
/race list - Show your upcoming races
/season new - Build a season plan towards your next A race
/season show - Show your active season's blocks
/log <sport> <minutes> [intensity] - Log a workout
  Examples:
  • /log swim 45 z2
  • /log bike 90 z4
  • /log run 60
/connect icu - Link your intervals.icu account
/connect status - Show your intervals.icu link
/disconnect icu - Remove your intervals.icu link
/sync - Pull your latest intervals.icu activities and wellness now

📊 Your current profile:
• FTP: 355W
• Timezone: Europe/Prague
```

### `/profile`

```
📊 Your Training Profile

🚴 FTP: 355W
🕐 Timezone: Europe/Prague
🏊 Swim Days: Wed, Fri, Sun_optional
🚴 Bike VO2 Day: Thu
🚴 Long Bike Day: Sun
🏃 No Long Run Day: Sun

Last updated: February 11, 2026
```

### `/plan`

```
📅 7-Day Training Plan (starting February 11, 2026)

Tue Feb 11:
  🏃 Run Intervals
     55min • Z4
     💡 Warm up 15min, 5x3min Z4 (2min rest), cool down

Wed Feb 12:
  🏊 Swim Technique
     50min • Z2
     💡 Drills and technique work

Thu Feb 13:
  🚴 Bike VO2 Max
     70min • Z5
     💡 Warm up 20min, 5x5min Z5 (3min rest), cool down

Fri Feb 14:
  🏊 Swim Intervals
     50min • Z4
     💡 10x100m at threshold pace

Sat Feb 15:
  🏃 Run Tempo
     50min • Z3
     💡 Warm up 15min, 20min Z3, cool down

Sun Feb 16:
  🚴 Long Bike
     180min • Z2
     💡 Steady endurance ride, nutrition practice
  🏊 Optional Easy Swim (optional)
     35min • Z1
     💡 Recovery swim after long bike

Mon Feb 17:
  🚴 Bike Endurance
     60min • Z2
     💡 Easy spin, focus on cadence

📋 Applied rules: 2
```

### `/plan` with Adjustments

```
📅 7-Day Training Plan (starting February 11, 2026)

[... sessions ...]

⚠️ Adjustments:
⚠️ Adjusted plan to avoid back-to-back hard sessions
⚠️ Weekly load capped at 110% of last week (450min → 495min max)

📋 Applied rules: 3
```

### `/week show`

```
📆 Week 1/3 · Build block (Oct 26 – Nov 1)
🎯 Race-specific intensity
⏱ 10.0h planned of 10.0h target
🏊 1.5h/1.5h · 🚴 5.5h/5.5h · 🏃 3.0h/3.0h

Mon Oct 26:
  🚴 Bike Endurance
     85min • Z2
     💡 Easy spin, focus on cadence

Tue Oct 27:
  🏃 Run Threshold
     55min • Z4
     💡 Threshold intervals, easy jog between

Wed Oct 28:
  🏊 Swim Technique
     45min • Z2
     💡 Drills and technique work
  🏃 Run Easy
     45min • Z2
     💡 Conversational pace

Thu Oct 29:
  🚴 Bike VO2 Max
     80min • Z5
     💡 VO2 max intervals, easy spin between

Fri Oct 30:
  🏊 Swim Threshold Intervals (downgraded to Z2)
     45min • Z2
     💡 100s at threshold pace
Downgraded: No back-to-back hard sessions allowed

Sat Oct 31:
  🏃 Long Run
     80min • Z2
     💡 Steady aerobic run

Sun Nov 1:
  🚴 Long Bike
     165min • Z2
     💡 Steady endurance ride, nutrition practice

⚠️ Adjustments:
⚠️ Adjusted plan to avoid back-to-back hard sessions
```

### `/log bike 90 z2`

```
✅ Logged 🚴 bike workout: 90min at Z2 on February 11, 2026
```

## Testing

The project includes comprehensive unit tests for the rules engine:

```bash
npm run test -w @triathlon/core
```

**Test Coverage**:

- ✅ SwimRotation rule (Wed=technique, Fri=intervals)
- ✅ ReadinessDownshift rule (fatigue-based adjustments)
- ✅ NoHardHard rule (no consecutive hard sessions)
- ✅ WeeklyLoadCap rule (progressive overload limits)
- ✅ Combined rules interactions
- ✅ Edge cases and boundary conditions

## Production Considerations

### Scaling

- **Horizontal**: Run multiple worker containers
- **Vertical**: Increase worker concurrency in [apps/worker/src/index.ts](apps/worker/src/index.ts:147)
- **Queue**: BullMQ supports job prioritization, rate limiting, and retries
- **Database**: Add read replicas for profile/workout queries

### Monitoring

- **Logs**: Pino JSON logs ready for aggregation (ELK, Datadog)
- **Metrics**: Add Prometheus metrics via `prom-client`
- **Alerts**: Monitor queue depth, job failure rates, latency
- **Health Checks**: Already configured in docker-compose.yml

### Security

- ✅ No secrets in repo
- ✅ Environment variable validation (Zod)
- ✅ SQL injection protection (Prisma ORM)
- ✅ Input validation on all commands
- ✅ Idempotency via ProcessedMessage table
- ⚠️ Add rate limiting per user (Redis)
- ⚠️ Add authentication if exposing API

### Future Enhancements (Post-MVP)

1. **LLM Integration**
   - Add RAG system for personalized coaching advice
   - Keep rules engine as fallback/validation layer
   - Store conversation history in DB

2. **Advanced Features**
   - Race goal setting and periodization
   - HR/power zone calculator from FTP
   - Training load metrics (TSS, CTL, ATL)
   - Garmin/Strava integration
   - Multi-week planning

3. **UI Improvements**
   - Inline keyboards for common actions
   - Calendar view of plan
   - Progress charts and analytics

## Troubleshooting

### Bot not responding

```bash
# Check bot logs
docker compose logs -f bot

# Verify token in .env
grep TELEGRAM_BOT_TOKEN .env

# Test bot token
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe
```

### Worker not processing jobs

```bash
# Check worker logs
docker compose logs -f worker

# Check Redis queue
docker compose exec redis redis-cli
> LLEN bull:commands:waiting
> LLEN bull:commands:failed

# Check database connection
docker compose exec worker npx prisma db push
```

### Database migrations

```bash
# Reset database (WARNING: deletes all data)
docker compose down -v
docker compose up -d postgres redis
docker compose exec bot npx prisma migrate reset

# Or just push schema
docker compose exec bot npx prisma db push
```

## License

MIT

## Contributing

This is an MVP. Contributions welcome for post-MVP features.

## Support

For issues or questions, open a GitHub issue or contact the maintainer.
