# Combined PRs Branch

This branch combines all open Dependabot PRs into a single branch.

## What was merged

This branch includes the following dependency updates from open PRs:

### Docker Dependencies
- ✅ PR #2: Node.js from 20-alpine to 25-alpine (bot)
- ✅ PR #3: Node.js from 20-alpine to 25-alpine (worker)

### GitHub Actions
- ✅ PR #1: docker/build-push-action from 5 to 6
- ✅ PR #4: actions/checkout from 4 to 6
- ✅ PR #5: actions/attest-build-provenance from 1 to 3
- ✅ PR #6: actions/upload-artifact from 4 to 6
- ✅ PR #7: actions/setup-node from 4 to 6

### NPM Dependencies
- ✅ PR #8: zod from 3.25.76 to 4.3.6
- ✅ PR #9: @types/node from 20.19.33 to 25.2.3
- ✅ PR #10: date-fns from 3.6.0 to 4.1.0
- ✅ PR #13: dotenv from 16.6.1 to 17.2.4
- ✅ PR #14: prisma from 5.22.0 to 7.4.0
- ✅ PR #15: pino-pretty from 10.3.1 to 13.1.3
- ✅ PR #16: vitest from 1.6.1 to 4.0.18
- ✅ PR #17: @prisma/client from 5.22.0 to 7.4.0

## Known Issues

### ✅ Prisma 7 Breaking Changes - FIXED

The upgrade to Prisma 7 introduced breaking changes that have been resolved:

**Changes Made:**

1. ✅ Created `prisma.config.ts` at the project root
2. ✅ Updated `prisma/schema.prisma` to remove the `url` property from the datasource
3. ✅ Build and tests now pass successfully

**What was done:**

The Prisma 7 migration required moving the database connection configuration from `schema.prisma` to a new `prisma.config.ts` file. This follows the new Prisma 7 configuration pattern where:

- Database connection URLs are configured in `prisma.config.ts`
- The schema file only contains the provider information
- Environment variables are explicitly loaded using `dotenv/config`

See the [Prisma 7 migration guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7) for more details.

### Current Build Status

✅ **The project builds successfully!**
✅ **All tests pass!**

## How to Update PR Base Branches

Since I cannot programmatically update PR base branches, here's how to do it manually:

### Option 1: Using GitHub Web UI

For each PR (#1-17):
1. Go to the PR page on GitHub
2. Click "Edit" next to the PR title or go to the PR settings
3. Change the base branch from `main` to `copilot/combine-open-prs-into-new-pr`
4. Save the changes

### Option 2: Using GitHub CLI

```bash
# For each PR number
gh pr edit <PR_NUMBER> --base copilot/combine-open-prs-into-new-pr
```

Example:
```bash
gh pr edit 1 --base copilot/combine-open-prs-into-new-pr
gh pr edit 2 --base copilot/combine-open-prs-into-new-pr
# ... and so on for PRs 3-17
```

### Option 3: Batch Update Script

```bash
#!/bin/bash
for pr in 1 2 3 4 5 6 7 8 9 10 13 14 15 16 17; do
  gh pr edit $pr --base copilot/combine-open-prs-into-new-pr
  echo "Updated PR #$pr"
done
```

## Next Steps

1. **Fix Prisma 7 breaking changes** - This is the primary blocker
2. **Update PR base branches** - Use one of the methods above
3. **Test the combined changes** - Ensure all dependencies work together
4. **Review security vulnerabilities** - Run `npm audit` and address issues
5. **Update documentation** - If any API changes affect usage

## Alternative Approach

If the Prisma 7 upgrade is too complex to handle right now, consider:

1. Excluding the Prisma-related PRs (#14, #17) from this combined branch
2. Creating a separate branch for Prisma upgrades
3. Merging the other dependency updates first
4. Handling Prisma 7 migration as a separate, focused effort

## Files Changed

The following files were modified during the merge:
- `.github/workflows/ci.yml` - GitHub Actions updates
- `.github/workflows/codeql.yml` - Checkout action update
- `.github/workflows/docker-publish.yml` - Docker and checkout action updates
- `apps/bot/Dockerfile` - Node.js version bump
- `apps/bot/package.json` - Dependency updates
- `apps/worker/Dockerfile` - Node.js version bump
- `apps/worker/package.json` - Dependency updates
- `package-lock.json` - Lockfile regenerated with new dependencies
- `package.json` - Root dependencies updated
- `packages/core/package.json` - Core package dependencies updated

## Merge Conflicts Resolved

During the merge process, several conflicts were resolved:
- **apps/worker/package.json** - Conflicting dependency versions (dotenv, date-fns)
- **apps/bot/package.json** - Conflicting dependency versions (pino-pretty, dotenv)
- **package-lock.json** - Multiple conflicts due to overlapping dependency updates

All conflicts were resolved by choosing the newer versions of dependencies.
