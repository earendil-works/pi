## Summary
Fixed `mu` startup latency by replacing unbounded filesystem globbing used to inject a file tree into the system prompt.

## Changes
- `packages/coding-agent/src/prompts/file-tree.ts`
  - Replaced `tinyglobby("**/*")` crawl with:
    1) `git ls-files` (tracked-only, fast, respects ignore via tracked set)
    2) `fd --max-results ...` (bounded crawl)
    3) shallow `readdir` fallback (never recursive)
  - Added hard caps + timeouts for command execution
  - Added support for directory sentinel paths like `foo/`

- `packages/coding-agent/src/prompts/file-tree.test.ts`
  - Added regression test proving untracked files are excluded in git repos

- `packages/pods/package.json`, `packages/pods/src/cli.ts`, `packages/pods/README.md`, root `README.md`
  - Renamed pods binary to `mu-pods` and updated docs/help text to avoid `mu` CLI name conflict

## Commands run
- `npm test -w @kennyfrc/mu-coding-agent -- file-tree.test.ts`
- `npm run build -w @kennyfrc/mu-coding-agent`
- `xtui snap ...` (startup timing checks)
- `npm run check`

## Observed results
- Before: `generateFileTree()` in `~/work/ai21` ~9–10s; `mu` header appeared ~11–12s after launch
- After: `mu` header appeared ~1.7s in `~/work/ai21`; ~1.6s from `$HOME`
