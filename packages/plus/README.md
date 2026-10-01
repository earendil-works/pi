# plus

Shared override core for the pi-plus artifacts, consumed by
[`../plus-cli`](../plus-cli) (builds the `pi-plus` npm package — the `pipi` CLI) and
[`../plus-api`](../plus-api) (builds the `pi-plus-sdk` npm package — the embeddable
library). Direct updates to any other folder under `packages/` are forbidden —
upstream packages stay pristine so they can be synced/updated without merge conflicts.

## What lives here

1. **Context usage detection** (`src/context/`) — effective context window = `min(contextWindow, cap) − min(maxTokens, 20000)`, with the cap/floor/threshold persisted via `threshold-setting.ts` (`~/.pi/agent/pi-plus-settings.json`); auto-compact threshold as a percent of the effective window (default 80%), warning/error = threshold ∓ 20k, blocking limit = effective window − 3k, 3-failure circuit breaker, footer fullness measured against the effective window.
2. **Compaction** (`src/compaction/`) — single full-conversation summary using the CC 9-section prompt (`prompt.ts`); prompt-too-long retries drop the oldest turn (`compact.ts`); post-compact re-injection of recently read files, the active plan file, and invoked skills; recompaction analytics.
3. **Reasoning effort** (`src/reasoning/effort.ts`) — CC effort levels (`low`/`medium`/`high`/`max`), adaptive thinking default, `ultrathink` keyword, thinking budgets from env; `wrapStreamFn` re-applies the session level and honors the no-reasoning marker used by compaction summarization.
4. **Redirect wrapper modules** (`src/agent/`, `src/coding-agent/core/`) — the seven upstream overrides: `agent/agent.ts` (effort wrap), `agent/harness/compaction/compaction.ts` (summary no-reasoning), `coding-agent/core/agent-session.ts` (compaction serialization queue, post-compact usage, microcompact), `core/compaction/compaction.ts` (shouldCompact/compact/estimateContextTokens), `core/config.ts` (APP_NAME=pipi / APP_TITLE=pi+ display shadows + staged-bundle asset dirs), `core/defaults.ts` (thinking-level env override), `core/model-resolver.ts` (`PI_MAX_CONTEXT_TOKENS` + current-model publish). Each does `export * from "<upstream>"` and redefines selected exports, so upstream fixes propagate.
5. **The eight non-TUI extensions** (`src/extensions/`) — subagent, tasks, memory, plan, ask-user, hooks, context-guard, /cd. Registered by both the CLI wrapper and the SDK entry (`plusSdkExtensionFactories` in plus-api). The extension barrel (`src/extensions/index.ts`) exports exactly these eight.
6. **The redirect mechanism** — `loader/redirects.mjs` is the shared core redirect table; `build/redirect-plugin.mjs` is the esbuild plugin both artifact builds use (redirect + dist-funnel + externals validation + asset copying). The source-mode loader hook lives in `../plus-cli/loader/`.

## Mechanism

- Wrappers import the original upstream module via a relative path. Importers inside
  any `packages/plus*` dir are never redirected (see `isInsidePlus` in
  `../plus-cli/loader/hooks.mjs` and the exempt-prefix list in
  `build/redirect-plugin.mjs`), so no redirect loop occurs.
- Artifact-specific redirects layer on top of the core table:
  - `../plus-cli/loader/redirects.mjs` adds `main.ts` (hub wrapper), `cli/args.ts`
    (usage print), and `settings-selector.ts` — CLI only.
  - `../plus-api/build/redirects.mjs` adds `main.ts` → a throwing stub, keeping the
    upstream CLI entry graph out of the SDK bundle — SDK only.
- Nothing under `packages/plus*` may be imported by upstream code; overrides are
  wired in only through the loader/bundle redirects.

## Env vars (pi-style names)

| Var | Values | Effect |
| --- | --- | --- |
| `PI_MAX_CONTEXT_TOKENS` | number | Overrides `model.contextWindow` after model resolution |
| `PI_AUTO_COMPACT_WINDOW` | number | Session cap on the threshold-math window (lowers the persisted cap) |
| `PI_AUTOCOMPACT_PCT_OVERRIDE` | 1–100 | Auto-compact threshold as % of effective window (capped at default) |
| `PI_CONTEXT_FLOOR_TOKENS` | number ≥ 13000 | Context floor override (only raises the built-in 13k floor) |
| `PI_BLOCKING_LIMIT_OVERRIDE` | number | Blocking limit override |
| `PI_DISABLE_COMPACT` | truthy | Disables all compaction (incl. manual) |
| `PI_DISABLE_AUTO_COMPACT` | truthy | Disables threshold-triggered auto-compaction |
| `PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS` | ms ≥ 10000 | Circuit-breaker cooldown after 3 consecutive auto-compact failures |
| `PI_MAX_ACTIVE_MESSAGES` | number (`0`/invalid = off, default 1000) | Forces compaction when the active message count exceeds the cap |
| `PI_PRUNE_TAIL_TURNS` | number ≥ 1 (default 3) | Recent turns preserved verbatim by relevance pruning |
| `PI_MICROCOMPACT_IDLE_MINUTES` | minutes (default 60; ≤ 0 disables) | Idle gap that triggers clearing of stale tool-result content on session open |
| `PI_MICROCOMPACT_KEEP_RECENT` | number (default 5) | Tool results preserved verbatim by idle micro-compact |
| `PI_COMPACT_ANALYTICS` | truthy | Emits recompaction diagnostics to stderr after compaction |
| `PI_COMPACT_DEBUG` | truthy | Stderr stage trace for compaction |
| `PI_PLUS_SETTINGS_FILE` | path | Overrides `~/.pi/agent/pi-plus-settings.json` (test/debug knob) |
| `PI_EFFORT_LEVEL` | `off`/`auto`/`low`/`medium`/`high`/`max` | Per-request reasoning effort override |
| `PI_MAX_THINKING_TOKENS` | number (`0` disables) | Thinking budget (enables thinking at `high` when > 0) |
| `PI_DISABLE_THINKING` | truthy | Disables thinking entirely |
| `PI_DISABLE_ADAPTIVE_THINKING` | truthy | Forces the budget-based thinking path |

## Tests

```bash
npx vitest run   # from packages/plus; unit tests for the shared core + shared extensions
```
