#!/bin/bash

# A simple script to add, commit, and push all current changes to GitHub.

# --- Configuration ---
# You can change the default branch name here if you don't use "main".
BRANCH_NAME="main"
REMOTE_NAME="origin"
# ---------------------

# Exit immediately if a command exits with a non-zero status.
set -e

# Check if there are any changes to commit.
if git diff-index --quiet HEAD --; then
    echo "No changes to commit. Working tree clean."
    exit 0
fi

# Check for a commit message.
if [ -z "$1" ]; then
  echo "Error: No commit message provided."
  echo "Usage: ./git_push.sh \"Your commit message\""
  exit 1
fi

# Step 1: Add all changes to the staging area.
echo "Adding all changes..."
git add .

# Step 2: Commit the changes with the message provided as the first argument.
echo "Committing changes..."
git commit -m "$1"

# Step 3: Push the changes to the remote repository.
echo "Pushing changes to $REMOTE_NAME/$BRANCH_NAME..."
git push $REMOTE_NAME $BRANCH_NAME

echo "✅ Successfully pushed to $REMOTE_NAME/$BRANCH_NAME."

