# First Git Commit Guide

## Initialize Git Repository

```bash
# Initialize git (if not already done)
git init

# Configure commit message template (optional)
git config commit.template .gitmessage
```

## Before First Commit

### 1. Verify Everything Works

```bash
# Install dependencies
npm install

# Run all checks
npm run ci
```

Expected output: ✅ All checks pass

### 2. Create .env File

```bash
# Copy template
cp .env.example .env

# Add your bot token
# Edit .env and add TELEGRAM_BOT_TOKEN
```

**Note:** `.env` is gitignored (won't be committed)

### 3. Test Locally (Optional)

```bash
# Start services
docker compose up -d postgres redis

# Push database schema
npm run db:push

# Test bot
npm run dev:bot

# Test worker (in another terminal)
npm run dev:worker
```

## First Commit

### Option A: Interactive (Recommended)

```bash
# Stage all files
git add .

# Commit with editor
git commit
```

In the editor, write:
```
feat: initial commit - Triathlon Coach Bot MVP

- Complete monorepo structure (apps/bot, apps/worker, packages/core)
- Telegram bot with grammY (queue-based architecture)
- BullMQ worker with business logic
- Prisma database schema (5 tables)
- Rules engine (4 rules: NoHardHard, ReadinessDownshift, WeeklyLoadCap, SwimRotation)
- Docker Compose setup (Postgres, Redis, Bot, Worker)
- VSCode integration (20+ tasks, debug configs)
- GitHub Actions CI/CD (lint, test, build, Docker, security)
- Comprehensive documentation (6 docs, 30+ pages)
- Unit tests for rules engine (12 tests)

Tech stack: Node.js 20, TypeScript, grammY, Prisma, BullMQ, Redis, Postgres
Scales to 1000+ users, production-ready, LLM-ready architecture
```

### Option B: One-liner

```bash
git add .
git commit -m "feat: initial commit - Triathlon Coach Bot MVP"
```

## Push to GitHub

### 1. Create GitHub Repository

Go to github.com and create a new repository:
- Name: `TrainingAgent` (or your choice)
- Description: "Triathlon Coach Telegram Bot - MVP"
- Public or Private
- **DO NOT** initialize with README (we already have one)

### 2. Add Remote and Push

```bash
# Add remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/TrainingAgent.git

# Verify remote
git remote -v

# Push to main
git branch -M main
git push -u origin main
```

### 3. Verify CI/CD

1. Go to GitHub repository
2. Click "Actions" tab
3. You should see CI pipeline running
4. Wait for all checks to pass (green ✓)

### 4. Add Branch Protection (Recommended)

1. Settings → Branches → Add rule
2. Branch name pattern: `main`
3. Check:
   - ✅ Require status checks to pass before merging
   - ✅ Require branches to be up to date before merging
4. Select status checks:
   - ✅ Lint & Type Check
   - ✅ Run Tests
   - ✅ Build All Packages
   - ✅ Docker Build Test
   - ✅ Integration Test
5. Save

## Next Steps

### 1. Add Status Badges to README

Edit README.md, add at top:

```markdown
![CI](https://github.com/YOUR_USERNAME/TrainingAgent/workflows/CI/badge.svg)
![Tests](https://github.com/YOUR_USERNAME/TrainingAgent/workflows/CI/badge.svg?branch=main)
```

Commit and push:
```bash
git add README.md
git commit -m "docs: add CI status badges"
git push
```

### 2. Update Dependabot Config

Edit `.github/dependabot.yml`:

Replace `maintainer-username` with your GitHub username.

```bash
git add .github/dependabot.yml
git commit -m "ci: configure dependabot reviewer"
git push
```

### 3. Add Secrets (if needed)

Settings → Secrets and variables → Actions → New repository secret

Add:
- `TELEGRAM_BOT_TOKEN` (for E2E tests in future)

### 4. Enable Discussions (Optional)

Settings → Features → Check "Discussions"

### 5. Add Topics (Optional)

Repository main page → ⚙️ → Add topics:
- `telegram-bot`
- `triathlon`
- `typescript`
- `nodejs`
- `prisma`
- `docker`
- `bullmq`

## Commit Conventions

Use conventional commits format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation changes
- `style` - Code style changes (formatting)
- `refactor` - Code refactoring
- `test` - Adding or updating tests
- `chore` - Maintenance tasks
- `perf` - Performance improvements
- `ci` - CI/CD changes

### Examples

```bash
# Feature
git commit -m "feat(worker): add readiness downshift rule"

# Bug fix
git commit -m "fix(bot): handle missing user profile gracefully"

# Documentation
git commit -m "docs: add API documentation"

# Chore
git commit -m "chore: update dependencies"

# CI
git commit -m "ci: add Docker build caching"
```

## Branch Strategy

### Main Branch

- Protected
- Requires PR reviews
- All CI checks must pass
- Auto-deploy to staging (optional)

### Develop Branch (Optional)

```bash
# Create develop branch
git checkout -b develop
git push -u origin develop
```

Use for active development, merge to main for releases.

### Feature Branches

```bash
# Create feature branch
git checkout -b feature/plan-generation
git push -u origin feature/plan-generation

# Make changes, commit, push
git add .
git commit -m "feat: implement plan generation"
git push

# Create PR on GitHub
# After approval and CI passes, merge to main
```

## Git Aliases (Optional)

```bash
# Add useful aliases
git config --global alias.co checkout
git config --global alias.br branch
git config --global alias.ci commit
git config --global alias.st status
git config --global alias.last 'log -1 HEAD'
git config --global alias.ls 'log --oneline --graph --decorate'
```

## Pre-commit Hooks (Optional)

Install husky for git hooks:

```bash
# Install
npm install --save-dev husky lint-staged

# Initialize
npx husky install

# Add pre-commit hook
npx husky add .git/hooks/pre-commit "npx lint-staged"
```

Add to package.json:
```json
{
  "lint-staged": {
    "*.ts": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}
```

This runs linting and formatting before each commit.

## Verification Checklist

Before pushing:

- [ ] All files created (37+ files)
- [ ] Dependencies installed (`npm install`)
- [ ] CI checks pass locally (`npm run ci`)
- [ ] `.env` file created (not committed)
- [ ] Docker services start (`docker compose up`)
- [ ] Database schema pushed (`npm run db:push`)
- [ ] Tests pass (`npm test`)

## Troubleshooting

### Large Files Error

If git complains about large files:

```bash
# Check .gitignore includes
node_modules/
dist/
coverage/
*.log
```

### CI Fails After Push

1. Check Actions tab for error details
2. Run locally: `npm run ci`
3. Fix issues, commit, push again

### Dependabot PRs

Dependabot will create PRs for dependency updates:
1. Review changes
2. CI runs automatically
3. Merge if tests pass

## Support

- Git issues: Check [.gitignore](.gitignore)
- CI issues: Check [CI_CD.md](CI_CD.md)
- Setup issues: Check [QUICKSTART.md](QUICKSTART.md)

---

**Ready to commit?** ✅

Run: `git add . && git commit && git push -u origin main`
