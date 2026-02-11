# Quick Start Guide

Get the Triathlon Coach bot running in under 5 minutes.

## Prerequisites

- Docker Desktop installed and running
- Telegram account
- 5 minutes of your time

## Steps

### 1. Get Bot Token (2 minutes)

1. Open Telegram, search for `@BotFather`
2. Send: `/newbot`
3. Choose a name: `My Triathlon Coach`
4. Choose a username: `my_triathlon_coach_bot` (must be unique)
5. Copy the token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Configure (1 minute)

```bash
# Copy environment template
cp .env.example .env

# Edit .env and paste your token
# Windows: notepad .env
# Mac/Linux: nano .env
```

Change this line:
```
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

To:
```
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

### 3. Start Everything (2 minutes)

```bash
# Start all services (first time will take ~2-3 min to build)
docker compose up -d --build

# Wait for services to be healthy
docker compose ps

# Initialize database
docker compose exec bot npx prisma db push
```

### 4. Test Your Bot

1. Open Telegram
2. Search for your bot username (e.g., `@my_triathlon_coach_bot`)
3. Send: `/start`
4. You should see a welcome message!

Try these commands:
```
/profile
/plan
/log bike 90 z2
/plan
```

## Troubleshooting

### "Bot not found in Telegram"

Wait 30 seconds and search again. New bots take a moment to propagate.

### "Services not starting"

```bash
# Check logs
docker compose logs

# Verify token
grep TELEGRAM_BOT_TOKEN .env
```

### "Database connection failed"

```bash
# Restart services
docker compose restart

# Check postgres is running
docker compose ps postgres
```

## Next Steps

- Read [README.md](README.md) for full documentation
- Check [ARCHITECTURE.md](ARCHITECTURE.md) to understand the system
- Run tests: `npm install && npm test`
- View logs: `docker compose logs -f worker`

## Stopping

```bash
# Stop services (keeps data)
docker compose down

# Stop and remove data
docker compose down -v
```

## Development Mode

Want to develop locally?

```bash
# Install dependencies
npm install

# Start database only
docker compose up -d postgres redis

# Push database schema
npm run db:push

# Run bot (terminal 1)
npm run dev:bot

# Run worker (terminal 2)
npm run dev:worker
```

Now you can edit code and see changes instantly!
