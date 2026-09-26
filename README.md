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
- `/plan` - Generate 7-day training plan with rules applied
- `/log <sport> <minutes> [intensity]` - Log completed workout

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

1. **NoHardHard**: No consecutive hard days (Z4/Z5 or tagged vo2/threshold). Second day downgraded to Z2.
2. **ReadinessDownshift**: If fatigue/readiness ≤ 2, downgrade today's hard sessions to Z2.
3. **WeeklyLoadCap**: Limit weekly volume to 110% of previous week (10% progressive overload). Scales durations proportionally, min 30min per session.

#### Soft Rules (Optimize Structure)

4. **SwimRotation**: Enforce Wed = technique, Fri = intervals.

## intervals.icu Integration

`packages/integrations-icu` (`@triathlon/integrations-icu`) is a typed REST client for [intervals.icu](https://intervals.icu). The bot and worker do not use it yet. Sync jobs and persistence come in E1-T3/T4.

- **Auth**: HTTP Basic, username `API_KEY`, password = athlete API key. Set `ICU_ATHLETE_ID` and `ICU_API_KEY` in `.env` (see `.env.example`).
- **Methods**: `getAthlete`, `listActivities(oldest, newest)`, `listWellness(oldest, newest)`, `listEvents(oldest?, newest?)`, `createEvent`, `updateEvent`, `deleteEvent`.
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

# First time: Run database migrations in another terminal
docker compose exec bot npx prisma migrate dev --name init

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
/log <sport> <minutes> [intensity] - Log a workout
  Examples:
  • /log swim 45 z2
  • /log bike 90 z4
  • /log run 60

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
