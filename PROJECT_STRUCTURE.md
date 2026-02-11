# Project Structure

```
TrainingAgent/
├── apps/                           # Application services
│   ├── bot/                        # Telegram bot gateway
│   │   ├── src/
│   │   │   ├── index.ts           # Main bot entry (grammY setup)
│   │   │   ├── logger.ts          # Pino logger configuration
│   │   │   ├── parser.ts          # Command parsing & validation
│   │   │   └── queue.ts           # BullMQ queue setup
│   │   ├── Dockerfile             # Multi-stage Docker build
│   │   ├── package.json           # Bot dependencies
│   │   └── tsconfig.json          # TypeScript config
│   │
│   └── worker/                     # Background job processor
│       ├── src/
│       │   ├── index.ts           # Worker entry (BullMQ consumer)
│       │   ├── handlers.ts        # Command handlers (/plan, /log, etc)
│       │   ├── db.ts              # Database utilities
│       │   └── logger.ts          # Pino logger configuration
│       ├── Dockerfile             # Multi-stage Docker build
│       ├── package.json           # Worker dependencies
│       └── tsconfig.json          # TypeScript config
│
├── packages/                       # Shared packages
│   └── core/                      # Core business logic
│       ├── src/
│       │   ├── index.ts           # Package exports
│       │   ├── types.ts           # Domain types (Session, WeekPlan, etc)
│       │   ├── config.ts          # Environment config (Zod validation)
│       │   ├── plan-generator.ts  # Draft plan generation
│       │   └── rules-engine.ts    # Plan validation rules
│       ├── test/
│       │   └── rules-engine.test.ts  # Comprehensive unit tests
│       ├── package.json           # Core dependencies
│       ├── tsconfig.json          # TypeScript config
│       └── vitest.config.ts       # Test configuration
│
├── prisma/
│   └── schema.prisma              # Database schema (User, Profile, Workout, etc)
│
├── scripts/
│   ├── init-db.sh                 # Database initialization helper
│   └── test.sh                    # Test runner helper
│
├── docker-compose.yml             # Full stack orchestration
├── .dockerignore                  # Docker build exclusions
├── .gitignore                     # Git exclusions
├── .env.example                   # Environment template (Docker)
├── .env.local.example             # Environment template (local dev)
├── package.json                   # Root workspace config
├── package-lock.json              # Dependency lock file
├── tsconfig.base.json             # Shared TypeScript config
├── README.md                      # Main documentation
├── QUICKSTART.md                  # 5-minute setup guide
├── ARCHITECTURE.md                # Deep dive architecture docs
└── PROJECT_STRUCTURE.md           # This file
```

## Key Directories

### `/apps`

Contains deployable applications (bot, worker). Each has its own Dockerfile and can be deployed independently.

### `/packages`

Shared libraries used by multiple apps. The `core` package contains all business logic and is thoroughly tested.

### `/prisma`

Database schema and migrations. Single source of truth for the data model.

### `/scripts`

Helper scripts for common tasks (testing, DB initialization).

## File Naming Conventions

- **index.ts** - Main entry point for a package/app
- **\*.test.ts** - Test files (co-located with source or in `/test`)
- **Dockerfile** - Multi-stage builds for production
- **docker-compose.yml** - Local development stack

## Import Patterns

### Apps import from core:
```typescript
// apps/bot/src/index.ts
import { CommandJob, getConfig } from '@triathlon/core';
```

### Core is self-contained:
```typescript
// packages/core/src/rules-engine.ts
import { WeekPlan, Session } from './types';
```

### Database access only in worker:
```typescript
// apps/worker/src/db.ts
import { PrismaClient } from '@prisma/client';
```

## Build Output

When built, each package/app generates a `/dist` folder:

```
apps/bot/dist/
apps/worker/dist/
packages/core/dist/
```

These are excluded from git via `.gitignore`.

## Configuration Hierarchy

1. **tsconfig.base.json** - Base TypeScript settings
2. **apps/*/tsconfig.json** - Extends base, specific to each app
3. **packages/*/tsconfig.json** - Extends base, specific to each package

## Docker Build Context

The Dockerfiles use the **root directory** as build context to access all workspaces:

```dockerfile
# apps/bot/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY packages/core ./packages/core
COPY apps/bot ./apps/bot
```

## Adding New Components

### New Command Handler

1. Add to `apps/worker/src/handlers.ts`
2. Wire up in `apps/worker/src/index.ts`
3. Add tests if complex logic

### New Business Logic

1. Add to `packages/core/src/`
2. Export from `packages/core/src/index.ts`
3. Add tests in `packages/core/test/`

### New Database Table

1. Update `prisma/schema.prisma`
2. Run `npx prisma db push` or `npx prisma migrate dev`
3. Update types in `packages/core/src/types.ts`

### New Service

1. Create `apps/new-service/`
2. Add to `package.json` workspaces
3. Create Dockerfile
4. Add to `docker-compose.yml`

## Development Workflow

```bash
# Install all dependencies (from root)
npm install

# Generate Prisma client
npm run db:generate

# Run tests
npm test

# Build all packages
npm run build

# Run specific app
npm run dev:bot
npm run dev:worker
```

## Production Build

```bash
# Build Docker images
docker compose build

# Start services
docker compose up -d

# Initialize database
docker compose exec bot npx prisma db push
```

## Key Files Explained

### Root Files

- **package.json** - Workspace configuration, shared scripts
- **tsconfig.base.json** - Shared TypeScript strict settings
- **docker-compose.yml** - Postgres, Redis, Bot, Worker orchestration
- **.env.example** - Required environment variables

### Core Package

- **types.ts** - Domain models (immutable, well-typed)
- **rules-engine.ts** - Pure functions for plan validation
- **plan-generator.ts** - Deterministic plan generation
- **config.ts** - Centralized config with validation

### Bot Service

- **index.ts** - grammY bot setup, lightweight gateway
- **parser.ts** - Command parsing, no business logic
- **queue.ts** - BullMQ queue for async processing

### Worker Service

- **index.ts** - BullMQ worker, job processing loop
- **handlers.ts** - Command implementations (fat logic)
- **db.ts** - Prisma client, user management

## File Size Guidelines

- **Handlers** - Keep under 500 lines, split if larger
- **Types** - One file for domain types
- **Tests** - One test file per source file
- **Config** - Single source of truth

## Dependencies

### Production

- **grammY** - Telegram bot framework
- **BullMQ** - Redis-based job queue
- **Prisma** - Type-safe ORM
- **Pino** - Fast JSON logger
- **Zod** - Runtime type validation
- **date-fns** - Date manipulation

### Development

- **TypeScript** - Strict type checking
- **Vitest** - Fast unit test runner
- **tsx** - TypeScript execution (dev)

## Next Steps

- Read [README.md](README.md) for setup instructions
- Read [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions
- Check [QUICKSTART.md](QUICKSTART.md) for fast setup
