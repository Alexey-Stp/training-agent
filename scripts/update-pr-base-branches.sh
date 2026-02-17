#!/bin/bash

# Script to update base branch for all open Dependabot PRs
# This script uses the GitHub CLI (gh) to update PR base branches

set -e

# Configuration
NEW_BASE_BRANCH="copilot/combine-open-prs-into-new-pr"
REPO_OWNER="Alexey-Stp"
REPO_NAME="training-agent"

# List of PR numbers to update (excluding PR #19 which is the combined PR itself)
PR_NUMBERS=(1 2 3 4 5 6 7 8 9 10 13 14 15 16 17)

echo "=========================================="
echo "Updating PR Base Branches"
echo "=========================================="
echo "Repository: $REPO_OWNER/$REPO_NAME"
echo "New base branch: $NEW_BASE_BRANCH"
echo "PRs to update: ${PR_NUMBERS[@]}"
echo "=========================================="
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "ERROR: GitHub CLI (gh) is not installed."
    echo "Please install it from: https://cli.github.com/"
    exit 1
fi

# Check if authenticated
if ! gh auth status &> /dev/null; then
    echo "ERROR: Not authenticated with GitHub CLI."
    echo "Please run: gh auth login"
    exit 1
fi

# Update each PR
for pr_number in "${PR_NUMBERS[@]}"; do
    echo "Processing PR #$pr_number..."
    
    if gh pr edit "$pr_number" --repo "$REPO_OWNER/$REPO_NAME" --base "$NEW_BASE_BRANCH"; then
        echo "✅ Successfully updated PR #$pr_number"
    else
        echo "❌ Failed to update PR #$pr_number"
    fi
    
    echo ""
done

echo "=========================================="
echo "Done!"
echo "=========================================="
