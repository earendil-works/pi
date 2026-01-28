## Goal
Remove ApplyPatch safety rails so it can edit any path (like Write/Edit): allow relative paths to escape cwd, allow symlink parents/targets, and remove O_NOFOLLOW restrictions.

## Constraints / Notes
- Keep changes tight; no refactors beyond what's needed.
- Must run `npm run check` at repo root after code changes.

## Plan (slices)
1. Update ApplyPatch engine to remove cwd-escape + symlink + O_NOFOLLOW restrictions; add vitest coverage.
2. Update ApplyPatch tool description in `packages/coding-agent/src/prompts/tools.yaml`; run root check + coding-agent build.

## Current state
- Engine currently throws `Path escapes working directory: ...` for relative paths leaving cwd.
- Engine refuses symlink parents and refuses updating symlink files.

## Status
Done. ApplyPatch no longer restricts paths to the working directory and no longer blocks symlinks.

## Verification
- `npm test -w @kennyfrc/pi-coding-agent -- src/tools/apply-patch/path-access.test.ts`
- `npm run check`
- `npm run build -w @kennyfrc/pi-coding-agent`
