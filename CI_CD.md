# CI/CD Setup

This project includes comprehensive CI/CD pipelines and VSCode integration for development.

## Table of Contents

- [VSCode Integration](#vscode-integration)
- [GitHub Actions CI/CD](#github-actions-cicd)
- [Local Development](#local-development)
- [Code Quality](#code-quality)

## VSCode Integration

### Tasks

Access tasks via `Ctrl+Shift+P` → "Tasks: Run Task" or `Terminal` → `Run Task...`

#### Development Tasks

| Task | Description | Shortcut |
|------|-------------|----------|
| **Start Bot (Dev)** | Run bot in watch mode | |
| **Start Worker (Dev)** | Run worker in watch mode | |
| **Start Dev Services** | Run both bot & worker | |

#### Testing Tasks

| Task | Description | Shortcut |
|------|-------------|----------|
| **Run Tests** | Run all tests once | `Ctrl+Shift+P` → Test |
| **Run Tests (Watch)** | Run tests in watch mode | |

#### Build Tasks

| Task | Description | Shortcut |
|------|-------------|----------|
| **Build All** | Build all packages | `Ctrl+Shift+B` |
| **Type Check** | TypeScript type checking | |
| **Lint** | ESLint code linting | |

#### Docker Tasks

| Task | Description |
|------|-------------|
| **Docker: Start All** | Start all services |
| **Docker: Build & Start** | Build and start |
| **Docker: Stop All** | Stop all services |
| **Docker: Logs (Follow)** | Follow all logs |
| **Docker: Logs Worker** | Follow worker logs |
| **Docker: Logs Bot** | Follow bot logs |

#### Database Tasks

| Task | Description |
|------|-------------|
| **Prisma: Generate Client** | Generate Prisma client |
| **Prisma: Push Schema** | Push schema to database |
| **Prisma: Studio** | Open Prisma Studio |
| **Prisma: Migrate Dev** | Create migration |

### Debug Configurations

Access via `F5` or Debug panel (`Ctrl+Shift+D`)

| Configuration | Description |
|---------------|-------------|
| **Debug Bot** | Debug bot service with breakpoints |
| **Debug Worker** | Debug worker service with breakpoints |
| **Debug Bot & Worker** | Debug both services simultaneously |
| **Debug Tests** | Debug all tests |
| **Debug Current Test File** | Debug currently open test file |

**Usage:**
1. Set breakpoints in code (`F9`)
2. Select configuration in Debug panel
3. Press `F5` to start debugging
4. Use Debug Console for REPL

### Recommended Extensions

Install recommended extensions when prompted, or manually:

- **ESLint** - Code linting
- **Prettier** - Code formatting
- **Prisma** - Prisma schema support
- **Docker** - Docker file support
- **Vitest** - Test explorer
- **DotEnv** - .env file syntax

### Settings

Project includes opinionated VSCode settings:

- ✅ Format on save (Prettier)
- ✅ Auto-fix ESLint on save
- ✅ TypeScript workspace version
- ✅ Hide node_modules and dist from explorer
- ✅ Vitest integration

## GitHub Actions CI/CD

### Workflows

#### 1. CI Pipeline (`.github/workflows/ci.yml`)

**Triggers:** Push to main/develop, Pull Requests

**Jobs:**

##### Lint & Type Check
- TypeScript type checking
- ESLint linting
- Prettier formatting check

##### Run Tests
- Unit tests (Vitest)
- Upload test results as artifacts

##### Build All Packages
- Build core, bot, worker
- Verify build artifacts exist

##### Docker Build Test
- Build bot Docker image
- Build worker Docker image
- Cache layers for speed

##### Integration Test
- Start Postgres & Redis services
- Push database schema
- Verify connections

##### CI Summary
- Aggregate all job results
- Fail if any job failed

**Status Badge:**
```markdown
![CI](https://github.com/YOUR_USERNAME/TrainingAgent/workflows/CI/badge.svg)
```

#### 2. Docker Publish (`.github/workflows/docker-publish.yml`)

**Triggers:** Git tags (v*.*.*), Manual dispatch

**Actions:**
- Build Docker images for bot & worker
- Push to GitHub Container Registry (ghcr.io)
- Multi-platform builds (amd64, arm64)
- Create build attestations

**Publishing a Release:**
```bash
git tag v1.0.0
git push origin v1.0.0
```

Images available at:
- `ghcr.io/YOUR_USERNAME/trainingagent-bot:latest`
- `ghcr.io/YOUR_USERNAME/trainingagent-worker:latest`

#### 3. CodeQL Security Scan (`.github/workflows/codeql.yml`)

**Triggers:** Push, Pull Request, Weekly schedule (Mondays)

**Actions:**
- Static analysis for security vulnerabilities
- Code quality checks
- Results in Security tab

#### 4. Dependabot (`.github/dependabot.yml`)

**Actions:**
- Weekly dependency updates
- Automatic PRs for npm, Docker, GitHub Actions
- Security vulnerability patches

**Configuration:**
- Update `.github/dependabot.yml`
- Replace `maintainer-username` with your GitHub username

## Local Development

### Quick Commands

```bash
# Install dependencies
npm install

# Run linter
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check

# Type check
npm run typecheck

# Run all CI checks locally
npm run ci

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build all packages
npm run build
```

### Pre-commit Checks

Recommended: Add pre-commit hook

```bash
# Install husky (optional)
npm install --save-dev husky lint-staged

# Add to package.json
{
  "lint-staged": {
    "*.ts": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}

# Setup husky
npx husky install
npx husky add .git/hooks/pre-commit "npx lint-staged"
```

### Running CI Locally

Before pushing:

```bash
# Run all CI checks
npm run ci
```

This runs:
1. Linting
2. Type checking
3. Tests
4. Build

## Code Quality

### Linting (ESLint)

Configuration: [.eslintrc.json](.eslintrc.json)

**Rules:**
- ✅ TypeScript recommended
- ✅ No unused variables (except `_` prefix)
- ✅ No `any` type
- ✅ No floating promises
- ✅ Console.log warnings (use logger)

**Run:**
```bash
npm run lint          # Check
npm run lint:fix      # Fix automatically
```

### Formatting (Prettier)

Configuration: [.prettierrc](.prettierrc)

**Style:**
- Single quotes
- Semicolons
- 100 characters per line
- 2 space indentation
- Trailing commas (ES5)

**Run:**
```bash
npm run format        # Format all files
npm run format:check  # Check without changing
```

### Type Checking

Configuration: [tsconfig.base.json](tsconfig.base.json)

**Settings:**
- ✅ Strict mode enabled
- ✅ No implicit any
- ✅ Strict null checks
- ✅ No unused locals/parameters
- ✅ No implicit returns

**Run:**
```bash
npm run typecheck
```

## CI Status Checks

### Required Checks (for PRs)

Configure in GitHub Settings → Branches → Branch protection rules:

- ✅ Lint & Type Check
- ✅ Run Tests
- ✅ Build All Packages
- ✅ Docker Build Test
- ✅ Integration Test

### Passing Criteria

All checks must pass:
- No linting errors
- No type errors
- All tests passing
- Successful builds
- Docker images build successfully

## Troubleshooting

### CI Fails Locally

```bash
# Clear caches
rm -rf node_modules package-lock.json
npm install

# Regenerate Prisma
npm run db:generate

# Try CI again
npm run ci
```

### Docker Build Fails

```bash
# Check Docker context
docker compose build --progress=plain

# Check disk space
docker system df
docker system prune -a
```

### Tests Fail in CI but Pass Locally

- Check Node version (should be 20)
- Check environment variables
- Check database/Redis connections
- Review CI logs for specific errors

### ESLint Errors After Update

```bash
# Fix auto-fixable issues
npm run lint:fix

# Check remaining issues
npm run lint
```

## Best Practices

### Before Committing

1. ✅ Run tests: `npm test`
2. ✅ Run linter: `npm run lint`
3. ✅ Format code: `npm run format`
4. ✅ Type check: `npm run typecheck`
5. ✅ Or run all: `npm run ci`

### Before Creating PR

1. ✅ Ensure CI passes locally
2. ✅ Update tests if needed
3. ✅ Update documentation if needed
4. ✅ Rebase on latest main/develop
5. ✅ Write clear PR description

### For Releases

1. ✅ Update CHANGELOG.md
2. ✅ Bump version in package.json
3. ✅ Create git tag: `git tag v1.0.0`
4. ✅ Push tag: `git push origin v1.0.0`
5. ✅ Docker images auto-publish via CI

## Continuous Deployment (Optional)

### Deploy to Production

After CI passes, deploy automatically:

```yaml
# Add to .github/workflows/deploy.yml
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    needs: [ci]
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to server
        run: |
          # SSH to server
          # Pull latest images
          # Restart services
```

### Deploy Environments

- **Development**: Auto-deploy on push to `develop`
- **Staging**: Auto-deploy on push to `main`
- **Production**: Manual trigger or tag-based

## Monitoring

### GitHub Actions Logs

- View in Actions tab
- Download artifacts (test results)
- Review failed job logs

### Docker Registry

- View images in Packages tab
- Check image sizes and tags
- Pull images: `docker pull ghcr.io/...`

### Security Alerts

- View in Security tab
- Dependabot alerts
- CodeQL findings

## Support

For CI/CD issues:
1. Check GitHub Actions logs
2. Run locally: `npm run ci`
3. Review [TROUBLESHOOTING](#troubleshooting)
4. Open issue if problem persists

---

**Next Steps:**
- Configure branch protection rules
- Add status badges to README
- Set up notifications (Slack, email)
- Configure deployment pipeline
