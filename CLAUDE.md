# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Triathlon coach Telegram bot. It is an npm-workspaces monorepo (Node 20+, TypeScript strict, CommonJS). The data flow is:

```
Telegram → apps/bot (grammY) → BullMQ "commands" queue (Redis) → apps/worker → Postgres (Prisma) → Telegram reply
```

## Commands

```bash
npm install
npm run db:generate          # Prisma client generation. Needed before typecheck/build/test (CI does this first)
npm run build                # builds @triathlon/core first, then all workspaces (apps import core from dist/)
npm run typecheck
npm run lint                 # ESLint on all .ts (tests and test/ dirs are ignored by lint)
npm run format:check
npm test                     # vitest run in every workspace that has tests (core, integrations-icu, bot, worker)
npm run ci                   # lint + typecheck + test + build

# Single package / single test
npm -w @triathlon/core run test
npm -w @triathlon/integrations-icu run test -- test/client.test.ts
npm -w @triathlon/core run test -- -t "NoHardHard"   # filter by test name
npm run test:watch                                    # core in watch mode

# Local dev
docker compose up postgres redis
npm run db:push              # sync schema (use db:migrate for a migration)
npm run dev:bot              # tsx watch
npm run dev:worker
docker compose up --build    # full stack
```

The Prisma config is in `prisma.config.ts` (Prisma 7) and loads `DATABASE_URL` from `.env` through dotenv. Copy `.env.example` to `.env`. Its default hostnames (`postgres`, `redis`) are Docker service names, so change them to `localhost` when you run the apps outside Docker.

## Architecture

- **apps/bot**: A thin gateway. `parser.ts` parses text into `{commandName, args}`. `index.ts` enqueues a `CommandJob` via `queue.ts` `enqueueCommand` (3 attempts, exponential backoff) and reacts 👀. It has no DB access. The only logic it holds is the `/connect icu` dialog (`connect-dialog.ts`, state in Redis). That dialog encrypts the ICU API key before enqueueing a `connect_icu` job, so the plaintext never lands in the queue. Never log message text in the bot.
- **apps/worker**: Consumes the `commands` queue (concurrency 5, rate limit 10/s). It dispatches on `commandName` in `index.ts` and validates arguments inline there. Note that `validateSetFtpArgs`/`validateLogArgs` in `bot/parser.ts` are currently unused. `handlers.ts` holds the command handlers, which return reply strings. The worker sends replies itself through a grammY `Bot.api` instance.
  - **Idempotency**: `db.ts` calls `ensureUser()`, which auto-creates the user and a default profile. `checkMessageProcessed`/`markMessageProcessed` use the `ProcessedMessage` table, so retried jobs don't double-reply. Keep this pattern when you add commands.
  - When a job fails, the worker sends a generic error message and rethrows so that BullMQ retries.
  - **Activity sync**: A second queue, `icu-sync`, holds one repeatable `icu-activity-sync` job scheduler per `IcuConnection` (`sync-scheduler.ts`). Schedulers are registered on connect, removed on disconnect, and reconciled at startup. `activity-sync.ts` (injected deps, like `icu-connect.ts`) backfills 90 days, then fetches from `lastActivitySyncAt` minus an overlap. It diffs rows by `icuId` so repeat runs write nothing, and advances the cursor in the same transaction as the rows. `/sync` runs it inline.
- **packages/core** (`@triathlon/core`): Shared types (`CommandJob`, `Session`, `WeekPlan`, `RulesContext`, the `Sport`/`Intensity` enums), zod env config (`getConfig()`, cached), and the plan pipeline:
  1. `generateDraftPlan(profile, startDate)` → `addOptionalSundaySwim` → `applyRules(plan, context)`.
  2. `applyRules` runs its rules in a fixed order: SwimRotation → ReadinessDownshift → NoHardHard → WeeklyLoadCap. Each rule is a pure `WeekPlan → WeekPlan` function that appends to `warnings`/`appliedRules`. A hard session is Z4/Z5 or is tagged `vo2`/`threshold` (`isHardSession`). Downgrades go through `downgradeToEasy`.
  - Apps consume core from `dist/` (`main: ./dist/index.js`, TS project references). **Rebuild core after you change it** or the apps will see stale types.
- **packages/integrations-icu** (`@triathlon/integrations-icu`): A typed intervals.icu REST client (`IcuClient`). It uses Basic auth `API_KEY:<key>`, retries with backoff on 429/5xx, throws `IcuAuthError` on 401 without retrying, and throws `IcuContractError` when zod validation fails. Tests inject `fetch` plus `baseDelayMs: 0` and use JSON fixtures in `test/fixtures/`. The worker uses it in `icu-connect.ts`: those handlers take injected deps (repo, keys, `createClient`) so tests don't need Prisma or the network.
- **prisma/schema.prisma**: `User`, `Profile` (FTP, timezone, swim/bike/run day preferences), `Workout`, `Fatigue` (readiness input for the rules engine), `ProcessedMessage`, `IcuConnection` (one per user, API key AES-256-GCM encrypted), and `Activity` (synced from ICU, unique `icuId`). Prisma's `Sport`/`Intensity` enums mirror the ones in core. Migrations live in `prisma/migrations` (`0_init` is the baseline). Generate new ones with `npm run db:migrate`; dev and CI still use `db:push`.
- **Secrets and logging**: `@triathlon/core` provides `encryptSecret`/`decryptSecret` (the keyring comes from `getEncKeys()`: `SECRETS_ENC_KEY`, plus optional `SECRETS_ENC_KEY_PREVIOUS` for rotation) and `createLogger()` with pino redaction (`LOG_REDACT_PATHS`). Add new sensitive field names to that list.

## Conventions

- ESLint enforces `no-explicit-any`, `no-floating-promises`, and `no-misused-promises`. Use `void` for fire-and-forget promises. Unused variables must start with `_`. Use the pino `logger` instead of `console.log`.
- Prettier config is in `.prettierrc`. The commit message template is `.gitmessage` (`<type>: <subject>`, types like feat/fix/refactor; history also uses scopes, e.g. `feat(integrations-icu): ...`).
- Dates are handled as `yyyy-MM-dd` strings in the user's profile timezone (`date-fns-tz` `toZonedTime`).
