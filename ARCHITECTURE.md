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
- `queue.ts` - BullMQ queue setup

**Design Principles**:
- Thin layer - no business logic
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
- `handlers.ts` - Command handler implementations
- `db.ts` - Database utilities (user creation, deduplication)

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
- `config.ts` - Environment variable validation (Zod)
- `plan-generator.ts` - Draft plan generation from template
- `rules-engine.ts` - Plan validation and adjustments

**Design Principles**:
- Pure functions where possible
- No side effects (DB, network)
- Fully tested (see `test/rules-engine.test.ts`)
- Type-safe (strict TypeScript)

### Database Schema (`prisma/schema.prisma`)

**Tables**:

1. **User** - Telegram user mapping
   - `telegramId` (unique, BigInt)
   - Relations: Profile, Workouts, Fatigue

2. **Profile** - User training preferences
   - FTP, timezone, swim days, bike days
   - One-to-one with User

3. **Workout** - Logged training sessions
   - Sport, duration, intensity, date
   - Indexed on (userId, date) for fast queries

4. **Fatigue** - Daily readiness/sleep data
   - Readiness (1-5), sleep score
   - Unique on (userId, date)

5. **ProcessedMessage** - Idempotency tracking
   - Prevents duplicate workout logs
   - Unique on (userId, telegramMessageId)

**Indices**: Optimized for common queries (last 7 days workouts, user lookup)

## Data Flow

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
11. **Worker fetches** last 7 days workouts + today's fatigue
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
                    - Today's fatigue
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
- Encrypt sensitive profile data (if adding HR zones, health data)
- Use PostgreSQL pgcrypto or application-level encryption

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
  replicas: 1  # Single bot instance
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
  replicas: 3  # Scale horizontally
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
