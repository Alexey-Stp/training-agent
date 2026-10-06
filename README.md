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
│   ├── worker/           # Background job processor
│   │   ├── src/
│   │   │   ├── index.ts      # Worker entry point
│   │   │   ├── handlers.ts   # Command handlers
│   │   │   ├── db.ts         # Database utilities
│   │   │   └── logger.ts     # Pino logger
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/              # Athlete web dashboard (Express, server-rendered)
│       ├── src/
│       │   ├── index.ts      # HTTP server entry point
│       │   ├── app.ts        # createApp(deps): routes and middleware
│       │   ├── auth/         # Magic-link sign-in, sessions, guard
│       │   └── views/        # HTML templates and the stylesheet
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
- `/set lthr <bpm>` - Set your lactate threshold heart rate (e.g., `/set lthr 168`), used by the evening close-out to guess the intensity of runs, swims and rides without power
- `/plan` - Generate 7-day training plan with rules applied (saved, shows each session's intervals.icu status). With an active season, days the season covers show the season's sessions
- `/plan push` - Put the 7-day plan on your intervals.icu calendar as structured workouts (they sync to Garmin)
- `/week show` - Show this week of your active season plan: the block's targets, the sessions that hit them, and any rules-engine adjustments
- `/race add <yyyy-MM-dd> <type> <A|B|C> <name> [travel=<yyyy-MM-dd>]` - Add a race (type: `sprint|olympic|half|full|run|other`), e.g. `/race add 2027-06-12 olympic A Prague Triathlon travel=2027-06-11`. The optional travel day (1–7 days before the race) becomes a rest day when it falls in T-3..T-1; `/race move` keeps it the same number of days before the race.
- `/race list` - Show your upcoming races
- `/race move <yyyy-MM-dd> <yyyy-MM-dd>` - Change a race's date, e.g. `/race move 2027-06-12 2027-06-26`. Moving the A-race of your active season offers a re-projection of the season (see [Block review](#block-review))
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

1. **NoHardHard**: No consecutive hard days (Z4/Z5 or tagged vo2/threshold). Second day downgraded to Z2. Two hard sessions on the same day are allowed, and an easy session after a hard one on the same day doesn't let a hard session through the next day. A race (tag `race`) can't move, so a hard session the day before or after a race is the one downgraded.
2. **ReadinessDownshift**: If today's check-in readiness (`Wellness.subjectiveReadiness`) is ≤ 2, downgrade today's hard sessions to Z2. Races are never downgraded.
3. **WeeklyLoadCap**: Limit weekly volume to 110% of previous week (10% progressive overload). Scales durations proportionally, min 30min per session (a shorter session is never lengthened). Race sessions are left out of the total and never scaled. Taper and race weeks (`WeekPlan.phase`) cut volume on purpose, so the cap treats the reduction as valid and doesn't apply.

`applyRules` corrects a plan. `checkHardRules(plan, context)` only checks one and returns the hard rules it still breaks (`RuleViolation[]`, empty when it passes). For example, the 30-minute floor can keep a week over the load cap.

#### Soft Rules (Optimize Structure)

4. **SwimRotation**: Enforce Wed = technique, Fri = intervals. Taper sessions (tag `taper`) are left alone, so a pre-race Friday swim stays easy.

### Season Planning

A season is stored as a `SeasonPlan` (start date, status, optional A-race) with ordered `TrainingBlock` rows (`base`, `build`, `peak`, `taper`, `race`, `recovery`, `transition`, each with a start date, a length in weeks and weekly swim/bike/run targets). Races are stored as `Race` rows with priority A, B or C. `@triathlon/core` `validateSeasonPlan` checks that:

- blocks are contiguous: each block starts the day after the previous one ends, with no gaps or overlaps;
- the block containing the A-race is a `race` block that ends on race week and comes right after a `taper` block.

Every issue names the blocks involved, e.g. `block 2 (build) ends 2026-04-26 but block 3 (peak) starts 2026-05-04: 7-day gap`. `/season new` creates a season (see [Season wizard](#season-wizard)), `/season show` and `/week show` read the active one.

`generateSeasonPlan({ aRace, weeklyHoursAvailable, currentWeeklyLoad, weakSport?, startDate })` builds the block sequence backwards from the A-race. It is a pure function in `@triathlon/core`, and every constant comes from `DEFAULT_BLOCK_GENERATOR_CONFIG`, which can be overridden:

- **Blocks**: race week (1w) ← taper (half 2w, full 3w, others 1w) ← peak (3w) ← two build blocks (4w each) ← base for the remaining weeks (split base1/base2 from 6 weeks). A half-distance race 24 weeks out gives `base 5 · base 5 · build 4 · build 4 · peak 3 · taper 2 · race 1`.
- **Short runways**: the generator shortens peak, then the build blocks, then drops the second build, until base has at least 3 weeks. Taper and one build block are always kept. Each step, and any base under 8 weeks, is reported in `warnings`, e.g. 10 weeks gives `base 3 · build 3 · peak 1 · taper 2 · race 1`.
- **Volume**: week 1 starts from the athlete's current weekly load, clamped to 50–100% of available hours. Load weeks grow at most 8% over the previous load week, capped at 85% (base), 95% (build) or 100% (peak) of available hours. Every 4th plan week in base/build/peak is a recovery week at 60% of the last load week. Taper weeks are sized from the last load week (peak), counted back from the race: the last taper week is 60%, the one before 75%, the one before that 85%. Race week training volume (the race itself excluded) is 40%. A half-distance taper is therefore 75% → 60% → race week 40%. Taper and race weeks are the explicit exception to the 8% ramp cap (`isRampException`).
- **Sport split** by race type (half: swim 15% / bike 55% / run 30%). In base weeks the weak sport gets +10 percentage points, taken from the other sports in proportion to their shares.

It returns the `TrainingBlock[]` (weekly targets are the mean of the block's weeks), a per-week `weeks[]` breakdown, the aligned plan `startDate` (a Monday) and `warnings[]`. The output passes `validateSeasonPlan`.

#### Week expander

`expandWeek(block, weekIndex, profile, { context?, targets?, config? })` turns one week of a block into concrete sessions:

- **Targets**: the block's weekly averages by default. Swim metres are converted at 2500 m/h and run km at 10 km/h, then the sport hours are scaled to add up to `targetWeeklyHours`. Pass `targets` (e.g. a `SeasonWeek` from `generateSeasonPlan`) to size a recovery week inside a block.
- **Templates by block type**:
  - **base**: endurance and technique, no Z4/Z5. Wed technique swim, Fri aerobic intervals swim, easy bike, tempo bike, long bike, easy run with strides, easy run, long run.
  - **build/peak**: the same frame with key sessions: bike VO2 Z5, run threshold Z4, swim threshold Z4.
  - **taper**: short sessions, every one ≤ 75 min. The weekly intensity frequency is kept with 2 sharpening sessions (bike and run, Z4, reps halved). Volume over the cap is reported in `warnings`. A taper block's weeks decline (`weekVolumeFactor`): the block stores its average, and the publisher reshapes each week with the taper factors.
  - **race** (with the A-race passed in `races`): the race-week template of the race type, see [Races in the plan](#races-in-the-plan). Without races it falls back to the taper template.
  - **recovery/transition**: the base frame with every session easy.
- **Placement from the Profile**:
  - swims go on `swimDays` (the `_optional` day gets the optional swim);
  - the long bike goes on `longBikeDay` and the key bike on `bikeVo2Day`;
  - the long run goes on the first of Sat, Sun, Tue, … that is neither the long-bike day nor `noLongRunDay`;
  - the key run never goes next to the key bike day.
- **Sizing**: each sport's minutes are split across its sessions by template weight, in 5-minute steps. Sessions under 20 min are dropped (the optional swim first) and their minutes go to the sport's other sessions. The draft hits the total within ±5% and each sport within ±10%.
- **Rules gate**: the draft goes through `applyRules`, then `checkHardRules`. The result has the rules-applied `plan`, `PlannedSessionDraft[]` `sessions` and `violations`, which is empty unless a rule can't fully correct the week. Example: in a default-profile build week the Fri threshold swim follows Thu VO2, so NoHardHard downgrades it.

`draftBlockWeek` returns the draft before the rules run. `blockWeekTargets`, `blockWeekStart`, `weekIndexForDate` and `weekVolume` are the helpers around it. `/week show` expands the week of the active season that contains today and shows it. It doesn't store anything.

`seasonDraftsForRange(season, profile, { from, to }, getContext, races)` (core `season/window.ts`) expands every block week touching a date range and cuts it to the range, clipped to the season. Both `/plan` and the rolling publisher use it, so they store the same sessions for the same days. The worker loads the races a week past both ends of the range (`racesForRange`), since a race reaches up to 6 days before it.

#### Races in the plan

`expandWeek` applies the athlete's races to the draft before the rules engine runs (core `season/race-week.ts`, `applyRaceOverrides`). The race itself is one session `🏁 <name>` (Sport `other`, `run` for run races; duration estimate per race type: sprint 75, olympic 150, half 330, full 780, run 90, other 120 min). It is tagged `race`, it is not counted as week volume, and the rules never scale or downgrade it.

- **A-race** (the season's): T-6..T-1 follow the race-week template of the race type, sized to the race week's training hours (40% of peak). Sprint/olympic/other: easy swim and run, bike sharpening at T-5, a 20′ easy spin at T-3, easy swim and run at T-2, a 30′ bike opener at T-1. Half/full: one moderate ride, run sharpening at T-5, full rest at T-3, easy swim and run at T-2, the T-1 opener. Run: run-only, with a 20′ jog at T-3. The opener is Z3 with 3 × 1′ race-pace touches, so no hard session sits after T-3. After the race, the recovery block (see Post-race recovery and debrief). A travel day in T-3..T-1 is a rest day; travelling at T-1 moves the opener to T-2. The window is date-based, so a taper week that holds T-6..T-1 of a Monday race gets them too. Race week keeps the taper's intensity count: sharpening + opener = 2.
- **B-race**: a mini-taper inside the current block over the 3 (sprint/olympic/run/other), 4 (half) or 5 (full) days before the race. Sessions are cut to 60%; hard sessions stay as shortened sharpening until T-4 and go easy after that. T-3 becomes the shakeout or rest of the race type, T-1 the opener, and the days after the race are the recovery block (see Post-race recovery and debrief). A B-race inside the A taper is swapped in like a C-race.
- **C-race**: train through. The race replaces the day's sessions, and when none of them was a key session (hard or long), the key session nearest the race is dropped instead. The other days keep their normal volume.

Another A-race than the season's (e.g. one for next season) is treated as a B-race.

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

### Evening close-out

Every linked athlete also gets a close-out at `Profile.closeoutTime` (default `EVENING_CLOSEOUT_DEFAULT_TIME`, 20:30) in their own timezone. The worker runs a final activity sync and matches the day's intervals.icu activities to the day's planned sessions:

- **Matching.** Same sport only, one activity per session, closest duration first. Two runs on a day pair up with the two planned runs by the smallest duration gap.
- **Matched** sessions become `completed`, with `deviationPct` (actual vs planned duration) and `actualIntensity`: a zone guessed from average power vs FTP for rides, otherwise from average heart rate vs `/set lthr` (empty without it).
- **Unmatched** sessions become `skipped`. A session you changed in intervals.icu (`modified_externally`) keeps its status.
- **Unplanned** activities stay unlinked and are flagged for the weekly review (`Activity.closedOutAt` set, `plannedSessionId` empty).

It is quiet by default. A short message goes out only when something is worth mentioning:

```
🌙 Today's close-out

• Long ride (3h) didn't happen today. No problem, I'll factor it into the weekly review.
• Tempo run was 40% shorter than planned (30 of 50 min). Noted for the weekly review.
• Unplanned swim (45 min) logged. Flagged for the weekly review.
```

- **Missed key session**: a skipped Z4/Z5 session or one of 90 minutes or more. A skipped easy session is recorded silently.
- **Deviation**: a matched session whose duration is off by more than `CLOSEOUT_DEVIATION_THRESHOLD_PCT` (25%).
- **Unplanned workout**: any activity with no planned session.
- **One per day** (`EveningCloseoutRun`). If intervals.icu is down, nothing is written and the job retries, so a session is never marked skipped on stale data. A failed send is retried with the stored message.

Set `EVENING_CLOSEOUT_ENABLED=false` to turn it off.

### Weekly stats

Every Monday at `WEEKLY_STATS_TIME` (06:00) in the athlete's timezone, the worker sums up the ISO week that just ended and stores it as one `WeeklyStats` row per athlete and week (for example `2026-W40`). Later prompts and the weekly review read these numbers.

- **Volume per sport.** Planned vs actual minutes, with compliance as actual / planned in percent. Actual distance and TSS come from intervals.icu activities. Planned sessions have no distance or TSS, so those stay empty.
- **Planned** means the week's live, non-rest sessions. **Actual** means every activity of the week, including unplanned ones.
- **Off week.** A week with no planned sessions is marked `unplannedWeek`, and its compliance is empty (`null`), not 0%. The same applies to a sport that was trained but not planned.
- **Key sessions** (Z4/Z5 or 90 minutes or more): hit (`completed`), missed (`skipped`, listed by title), or pending when the close-out never ran.
- **Intensity distribution.** Each activity's minutes count as Z1-2 or Z3+ by its average heart rate against `/set lthr`. Without an LTHR or a heart rate, the minutes are counted as unknown.
- **Load.** CTL/ATL/TSB from the last value before the week to the last value in it.
- **Wellness.** Week averages of HRV, resting HR, sleep, readiness and soreness, plus the HRV change against the week before.

A rerun replaces the week's row. Set `WEEKLY_STATS_ENABLED=false` to turn it off.

### Weekly review

Every Sunday at `WEEKLY_REVIEW_TIME` (19:00) in the athlete's timezone, the coach reviews the week that ends that day and proposes changes to next week:

```
📊 Week 40 review · Build 1/4
Strong run week, but the 180-min long ride was missed: 420 of 600 min.
🏊 Swim 120/120 min ✓ · 5.0 km
🚴 Bike 75/255 min (−180) · 37.5 km
🏃 Run 225/225 min ✓ · 37.5 km
🔑 Key 3/4 · missed Long ride
✅ All three runs done, 37.5 km
⚠️ Bike 180 min short of plan
Next week
• Bike Long ride 210′→255′
[✅ Apply next week] [➡️ Keep plan]
[💬 Discuss]
```

- **Data.** The worker syncs activities, recomputes this week's stats (Monday's weekly stats run later replaces them with the final numbers) and reads next week's planned sessions and the season position. Today's sessions may still be open, so they count as pending.
- **Next-week changes.** The coach may change single sessions (duration, intensity, date, sport) or scale the whole week (`scale_volume`, factor 0.6–1.08). Missed training is never crammed in: all changes together may add at most `WEEKLY_REVIEW_MAX_RAMP_PCT` (8%) to next week's planned minutes. The usual guardrails also apply: at most 50% off a session, no moves onto rest days, no hard sessions back to back, the weekly load cap, and no changes to sessions you edited in intervals.icu.
- **Rejected changes.** If the coach's changes break a limit, the report keeps the coach's words, says so, and falls back to the standard safety rules. Without the LLM, the report is built from the stats alone.
- **Apply next week** updates next week's sessions and pushes them to intervals.icu, the same way the morning brief's Apply does, and edits the report with the result. The button expires after `COACH_DECISION_TTL_HOURS` (24 h).
- **One per week** (`WeeklyReviewRun`). If intervals.icu is down, the report goes out with a note that activities may be missing. A failed send is retried with the stored report.

Set `WEEKLY_REVIEW_ENABLED=false` to turn it off.

### Block review

On the last day of each training block (always a Sunday) at `BLOCK_REVIEW_TIME` (19:30) in the athlete's timezone, the coach reviews the block against its targets and, when needed, proposes a re-projection of the rest of the season:

```
🧱 Block 2 (build) review · 14.09 → 04.10
📦 Volume 70% of target (7.0/10.0 h/wk)
📈 CTL 50.0 → 53.0 (+3.0)
📊 Compliance declining: 80% · 70% · 60%

You managed 70% of the build volume (7.0 of 10.0 h/week).
✅ CTL up 3.0
⚠️ Compliance fell to 60% in the last week

Re-projection · Next block: 10.8 → 8.2 h/wk · remaining 49.8 → 40.4 h
Before:  3 peak 05.10-25.10 3 10.8 … / 4 taper … / 5 race …
After:   3 peak 05.10-25.10 3  8.2 … / 4 taper … / 5 race …
[✅ Confirm re-projection] [✖ Decline]
```

- **Verdict.** Volume achieved against the block's weekly target, from the stored weekly stats of the block's weeks; CTL from before the block to its end (and against `targetCtl` when a block has one); weekly compliance and its trend.
- **Re-projection.** The remaining blocks are regenerated with the season generator's rules (≤8% ramp between load weeks, every 4th season week a recovery week, taper and race week), but the volume restarts from what you actually achieved: a block at 70% starts the next one at 70% of its planned level. Everything up to the review day stays as it was.
- **Keep or re-project.** The coach recommends one. Volume more than `BLOCK_REVIEW_REPROJECT_THRESHOLD_PCT` (15%) off target always proposes the re-projection. Without the LLM, that threshold decides alone.
- **Nothing changes without Confirm.** Confirm replaces the future blocks and republishes the next days to intervals.icu; Decline keeps the season and records the answer. If the season changed in between, nothing is applied. The buttons expire after `BLOCK_REVIEW_TTL_HOURS` (72 h).
- **Race moved.** `/race move` on the active season's A-race runs the same review right away: the current week is kept, the rest is re-allocated for the new date (phases you are already past are not repeated), and you confirm or decline the old-vs-new table.
- **One per block** (`BlockReviewRun`). Taper and race blocks are not reviewed.

Set `BLOCK_REVIEW_ENABLED=false` to turn it off.

## Race briefs

On race week the bot sends one or two messages per race at `RACE_BRIEF_TIME` (09:00, your timezone):

- **A-race, T-7.** The week's sessions, then a checklist: gear for the race type (swim, bike and run kit; a full distance adds special-needs bags), a nutrition-plan reminder and a registration/briefing reminder.
- **T-1 (A, B and C races).** Pacing targets and fueling:
  - **Bike:** a % of your FTP by race type (sprint 88–92%, olympic 83–87%, half 78–82%, full 68–72%), shown with its source, e.g. `78–82% of FTP = 234–246 W (from FTP 300)`.
  - **Run:** a pace band from your fastest 20–60 min run of the last 90 days (a rough threshold proxy: it uses whole-run averages). With no such run it says `no recent data — race by feel/HR` instead of inventing a number.
  - **Swim:** a pacing note without numbers. **Fueling:** a carbs g/h range per race type. **Weather:** a reminder to check the forecast.
  - B and C races get the shorter version: bike, run and fueling only.
- **Numbers never come from the LLM.** Core `race/pacing.ts` computes them; the model only writes the intro and closing line, and a reply containing any digit is replaced by a fixed text.
- **Once per race and date** (`RaceBriefRun`): a retry resends the stored brief, and a race moved with `/race move` is briefed again for its new date. A failed activity sync only adds a stale note.

All bands and ranges are in `DEFAULT_RACE_PACING_CONFIG`. Set `RACE_BRIEF_ENABLED=false` to turn it off.

## Post-race recovery and debrief

From the day after a race the bot runs one daily job at `POST_RACE_TIME` (09:30, your timezone):

- **Recovery block.** Planned sessions in the block are replaced with rest or short Z1 sessions and pushed to intervals.icu. Length by priority and race type: **A** 7 days (sprint, olympic, other), 10 (half, run), 14 (full); **B** 2–4; **C** 0–2 (none after a sprint). The first days are full rest, then one easy session every other day. Sessions you moved, edited or completed yourself are kept, and a second run changes nothing. The season planner uses the same block, so the rolling publisher and `/plan` agree with it.
- **Debrief.** When the race activity has synced (the longest activity of race day), the bot compares it with the T-1 targets. With power it reports normalized power against the bike band, the power of each half, the fade and the **positive or negative split**; with heart rate and speed only it reports pace by half and heart rate drift; with neither it compares the stored averages. A multisport activity gets no single target. The three takeaways and a short narrative come from the LLM, but **every number is computed in code**: a reply containing a figure that is not in the computed facts is replaced by a fixed text.
- **No activity.** If nothing syncs within `RACE_DEBRIEF_TIMEOUT_HOURS` (48) after the end of race day, the debrief is skipped (logged) and the bot asks whether you raced. A failed intervals.icu sync never triggers that question.
- **Once per race and date** (`RaceDebrief`): a retry resends the stored debrief.

Streams (power, heart rate, speed) are fetched from intervals.icu when the debrief runs and are not stored. Set `POST_RACE_ENABLED=false` to turn the job off.

## Observability

The worker exposes job metrics and can alert an admin when a morning brief keeps failing.

- **Metrics.** `GET http://localhost:9100/metrics` (`METRICS_PORT`, off with `METRICS_ENABLED=false`) serves the default Node process metrics plus `job_duration_seconds{job,queue,status}` (histogram), `job_completed_total{job,queue}` and `job_failures_total{job,queue}`. A failure is counted per attempt, so retries count. `GET /healthz` returns 200. docker-compose publishes the port.
- **Job registry.** `apps/worker/src/jobs/registry.ts` lists every job the worker may schedule. At boot, any repeatable scheduler in those queues whose job is not in the registry is deleted from Redis. When you add a job, add it to the registry too.
- **Failure alert.** After `BRIEF_FAILURE_ALERT_THRESHOLD` (3) final daily-brief failures in a row for one athlete (retries do not count), the chat `ADMIN_TELEGRAM_ID` gets one message. It is sent once per incident; a successful brief ends the incident. Leave `ADMIN_TELEGRAM_ID` empty to turn the alert off.
- **Bull Board.** `BULL_BOARD_ENABLED=true` serves a queue inspector at `http://127.0.0.1:9101/admin/queues` (`BULL_BOARD_PORT`). It can retry and delete jobs, so it binds to loopback only and docker-compose does not publish it. Use it for local development.

## Web dashboard

`apps/web` is a mobile-first web page for athletes. It is rendered on the server and has no client JavaScript.

- **Sign-in.** Send `/dashboard` to the bot. The reply has an "Open dashboard" button with a one-time link to `DASHBOARD_BASE_URL/auth?t=…`. The link is signed with `DASHBOARD_LINK_SECRET` and expires after `DASHBOARD_LINK_TTL_MINUTES` (15). Opening it starts a session that lasts `DASHBOARD_SESSION_TTL_HOURS` (168) and is kept in Redis behind an HttpOnly cookie. There are no passwords.
- **Expired or tampered links.** A missing, tampered, expired or already used link, or a missing session, gets a 401 "Link expired" page and a `dashboard auth rejected` warning with the token id and the reason. No athlete data is rendered.
- **Today.** `/` (or `/today?date=yyyy-MM-dd`) shows the stored plan for one local day, read from the same `PlannedSession` rows the bot and the intervals.icu push use, so it never regenerates the plan. Each session shows its title, "Any time today" (sessions have no planned start time), the total duration and the interval steps (warmup, main set as `5 × 3′ Z5 / 3′ Z1 easy`, cooldown). A session you changed in intervals.icu gets an "edited in intervals.icu" badge. Once the evening close-out has matched an activity, the session is marked completed and shows planned vs actual side by side: duration (with the deviation), zone (guessed from power or HR) and start time, plus distance, average power and HR when available. A missed session gets a "Missed" badge. Today also shows the morning brief's readiness line (check-in, HRV against the 30-day baseline, form). With nothing planned that day it shows a "Rest day" card. With no active season and no stored sessions within a week either side, it shows "No plan yet" with a `t.me/<TELEGRAM_BOT_USERNAME>?start=season_new` link that opens the season wizard.
- **Week.** `/week` shows the local Monday–Sunday week as 7 cells: sport icons and total planned time per day (or "Rest"), a ✓ when every session of the day is completed, and today highlighted. Tap a cell to open that day in Today. `/week?week=2026-W42` and the pager move between ISO weeks.
- **Settings.** `/settings` edits FTP, threshold HR, timezone, brief and close-out times, swim/bike/run day preferences, and the Telegram chat for briefs and reviews. Every field is validated on the server: an invalid form is shown again with a message per field, and nothing is saved. Saving queues a `profile-reschedule` job, so the worker re-registers the brief, close-out and review schedulers with the new time and timezone. Commands read the profile directly, so `/plan` uses a new FTP right away.
- **Notification chat.** Empty means your private chat with the bot. For a group or channel, add the bot there first (as an admin in a channel) and enter the chat id, e.g. `-1001234567890`. The bot posts a test message before the id is saved. Scheduled messages (brief, close-out, reviews, race briefs) go there; replies to commands still go to the chat you typed them in.
- **Off by default.** Leave `DASHBOARD_BASE_URL` empty and `/dashboard` answers that the dashboard is not set up.
- **Deploying it.** Serve it over HTTPS (a reverse proxy in front of `WEB_PORT`): outside `NODE_ENV=development` the session cookie is `Secure`, so it is not sent over plain http. Pages carry a strict CSP (no scripts), `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- **Guarantees, covered by tests.** Every query is scoped to the signed-in athlete, and a forged identifier never shows another athlete's data. Today and Week only read: row counts and `updatedAt` stay unchanged across repeated loads (checked against Postgres in CI), and only the Settings POST writes. Pages are under 30 KB with no JavaScript; a Lighthouse mobile run scored 100 for performance, accessibility and best practices.
- **Running it.** `npm run dev:web` serves it on `WEB_PORT` (3000), and docker-compose runs it as the `web` service. `GET /healthz` returns 200.

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
- **Statuses.** `draft` (local changes not pushed yet), `pushed`, `modified_externally`, and `completed` / `skipped`, set by the evening close-out when it matches the day's activities.

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
# Start all services (postgres, redis, bot, worker, web)
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

# Terminal 5: Start the web dashboard (http://localhost:3000, sign in with /dashboard)
npm run dev:web
```

### Database Management

```bash
# Generate Prisma client
npm run db:generate

# Push schema changes (dev)
npm run db:push

# Create migration
npm run db:migrate

# Apply all migrations to an empty database, like CI does
npm run db:deploy

# Demo athlete with 30 days of wellness, activities and plan (safe to repeat)
npm run db:seed
npm run db:verify   # checks migrations, indexes and seed counts

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
/set lthr <bpm> - Set your threshold heart rate (e.g., /set lthr 168)
/plan - Generate a 7-day training plan
/plan push - Put the plan on your intervals.icu calendar (syncs to your watch)
/week show - Show this week of your season plan
/race add <yyyy-MM-dd> <type> <A|B|C> <name> [travel=<yyyy-MM-dd>] - Add a race
  Example: /race add 2027-06-12 olympic A Prague Triathlon travel=2027-06-11
/race list - Show your upcoming races
/race move <yyyy-MM-dd> <yyyy-MM-dd> - Change a race's date
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
- **Metrics**: Prometheus metrics on the worker, see [Observability](#observability)
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
