# .husky

## Purpose
Git hooks managed by Husky. Runs pre-commit checks (formatting, linting, type-checking) before every commit.

## Technology
Shell scripts executed by Husky (npm prepare hook).

## Contents
- `pre-commit` - Runs `npm run check` (biome + tsgo --noEmit), restages formatted files, blocks commit on failure

## Key Functions
- Pre-commit hook: runs `npm run check`, captures staged files, restages after auto-formatting

## Data Types
N/A

## Logging
Prints pass/fail status to stdout.

## CRUD Entry Points
- **Create**: Add new hook files (e.g., `commit-msg`, `pre-push`)
- **Update**: Edit `pre-commit` to change validation steps
- **Delete**: Remove hook file to disable that hook

## Style Guide
- POSIX shell (`#!/bin/sh`)
- Uses `$?` for exit code checking
- Restages files modified by formatting to avoid dirty-tree commits
