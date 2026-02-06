## Goal
Reduce `mu` (coding-agent) startup latency by fixing slow startup-time file tree generation, and prevent the pods package from ever clobbering the `mu` binary.

## Constraints / Non-goals
- Keep startup behavior functionally equivalent (system prompt still includes a small file tree).
- Avoid unbounded directory scans at startup.
- No commits.

## Current State (facts)
- Root cause: `buildSystemPrompt()` generates a file tree via `generateFileTree()` before the TUI renders; previous implementation used `glob("**/*")` and could take ~10s+ in large repos (and even hang/OOM in `$HOME`).
- `generateFileTree()` now prefers `git ls-files` (tracked files only), falls back to bounded `fd`, then falls back to shallow `readdir` (never recursive).
- Pods package binary renamed to `mu-pods` so it can’t take over the `mu` command.

## Verification
- Unit test: `npm test -w @kennyfrc/mu-coding-agent -- file-tree.test.ts`
- Runtime (xtui): `cd ~/work/ai21 && mu` header appeared in ~1.7s after change
- Root check: `npm run check`

## Next step (if needed)
- Reinstall global packages so the new `mu-pods` binary name takes effect:
  - `npm i -g @kennyfrc/mu` (will install `mu-pods`)
  - Ensure `mu` still points to `@kennyfrc/mu-coding-agent`
