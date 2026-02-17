# How to Update PR Base Branches

This document provides instructions on how to change the base branch for all open Dependabot PRs to point to the combined PR branch (`copilot/combine-open-prs-into-new-pr`) instead of `main`.

## Why Update Base Branches?

By changing the base branch of all individual dependency update PRs to point to this combined PR, you achieve the following:

1. **Consolidation**: All changes are grouped into one PR
2. **Simplified Review**: Review all dependency updates together
3. **Conflict Resolution**: Merge conflicts have already been resolved in the combined PR
4. **Testing**: The combined changes have been tested together

## PRs to Update

The following PRs need their base branch changed from `main` to `copilot/combine-open-prs-into-new-pr`:

- PR #1: build(deps): Bump docker/build-push-action from 5 to 6
- PR #2: build(deps): Bump node from 20-alpine to 25-alpine in /apps/bot
- PR #3: build(deps): Bump node from 20-alpine to 25-alpine in /apps/worker
- PR #4: build(deps): Bump actions/checkout from 4 to 6
- PR #5: build(deps): Bump actions/attest-build-provenance from 1 to 3
- PR #6: build(deps): Bump actions/upload-artifact from 4 to 6
- PR #7: build(deps): Bump actions/setup-node from 4 to 6
- PR #8: chore(deps): Bump zod from 3.25.76 to 4.3.6
- PR #9: chore(deps-dev): Bump @types/node from 20.19.33 to 25.2.3
- PR #10: chore(deps): Bump date-fns from 3.6.0 to 4.1.0
- PR #13: chore(deps): Bump dotenv from 16.6.1 to 17.2.4
- PR #14: chore(deps-dev): Bump prisma from 5.22.0 to 7.4.0
- PR #15: chore(deps): Bump pino-pretty from 10.3.1 to 13.1.3
- PR #16: chore(deps-dev): Bump vitest from 1.6.1 to 4.0.18
- PR #17: chore(deps): Bump @prisma/client from 5.22.0 to 7.4.0

## Method 1: Using the Provided Script (Recommended)

A bash script has been provided to automate this process using the GitHub CLI.

### Prerequisites

1. Install GitHub CLI (`gh`):
   - macOS: `brew install gh`
   - Linux: See https://github.com/cli/cli#installation
   - Windows: See https://github.com/cli/cli#installation

2. Authenticate with GitHub:
   ```bash
   gh auth login
   ```

### Run the Script

```bash
cd /path/to/training-agent
chmod +x scripts/update-pr-base-branches.sh
./scripts/update-pr-base-branches.sh
```

The script will:
- Check if `gh` CLI is installed and authenticated
- Update each PR's base branch to `copilot/combine-open-prs-into-new-pr`
- Display success/failure status for each PR

## Method 2: Using GitHub CLI Manually

If you prefer to update PRs one by one:

```bash
gh pr edit 1 --repo Alexey-Stp/training-agent --base copilot/combine-open-prs-into-new-pr
gh pr edit 2 --repo Alexey-Stp/training-agent --base copilot/combine-open-prs-into-new-pr
# ... continue for each PR
```

## Method 3: Using GitHub Web UI

For each PR:

1. Navigate to the PR page on GitHub
2. In the right sidebar, look for the "base" branch information
3. Click "Edit" next to the base branch
4. Change the base from `main` to `copilot/combine-open-prs-into-new-pr`
5. Confirm the change

**Note:** Some PRs may show conflicts after changing the base. This is expected since all changes are already in the combined PR. These individual PRs can then be closed, as their changes are included in PR #19.

## After Updating Base Branches

Once all PR base branches have been updated:

1. The individual PRs will show as mergeable into the combined PR
2. You can verify that there are no new changes (they're all already in the combined PR)
3. Close the individual PRs as "completed" since their changes are in the combined PR
4. Merge PR #19 (the combined PR) into `main`

## What Happens Next?

After merging the combined PR into `main`:
- All dependency updates will be applied at once
- The Prisma 7 migration will be complete
- Docker and GitHub Actions will use the latest versions
- All individual Dependabot PRs can be closed

## Troubleshooting

### "PR not found" error
- Ensure you're authenticated with `gh auth login`
- Verify you have permission to edit PRs in the repository

### "Permission denied" error
- You need write access to the repository
- Contact the repository owner if you don't have access

### Script fails halfway through
- The script will show which PRs succeeded and which failed
- You can manually update the failed PRs using Method 2 or 3
- Re-run the script - it will skip already-updated PRs

## Alternative: Close Individual PRs

Since all changes are already in the combined PR, you could also:

1. Review and merge PR #19 (the combined PR) into `main`
2. Close all individual Dependabot PRs with a comment like:
   > "Closing this PR as the changes have been included in #19 (combined dependency updates)"

This approach is simpler but means you won't have individual PR history for each dependency update.
