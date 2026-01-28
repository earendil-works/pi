# Pin: Default tools update + version bump (2026-01-22)

## Goal
Remove Grep/Glob from default tools, bump version, build, run checks, commit changes, and run `npm link` in packages/coding-agent.

## Constraints
- Use npm version bump script (lockstep).
- Commit message for version bump: `chore: bump version to 0.22.24`.
- Generated build artifacts must be committed separately from human-authored changes.
- Do not commit unrelated devdocs pins/worklogs.

## Current State
- Code changes committed: remove Grep/Glob defaults and update CLI help.
- Version bumped to 0.22.24 and committed.
- Generated models artifacts committed.
- Build + check completed.
- `npm link` run in packages/coding-agent.

## Next Step
None.

## Verification
- `npm run build`
- `npm run check`
- `cd packages/coding-agent && npm link`
