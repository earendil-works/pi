# plus

All override/custom logic lives here. Direct updates to any other folder under `packages/` are forbidden — upstream packages stay pristine so they can be synced/updated without merge conflicts.

## What this layer does

Ports Claude Code semantics (reference: `../free-code/`, CC v2.1.87) onto pi's context detection, compaction, and reasoning — with pi-style env var names:

1. **Context usage detection** (`src/context/detection.ts`) — effective context window = `min(contextWindow, cap) − min(maxTokens, 20000)`, where the cap defaults to the model's advertised window and can be set in `/settings` ("Context window cap": "No cap"/131072/262144/524288/1048576, persisted in `~/.pi/agent/pi-plus-settings.json`). Capping below the model window gives a sane auto-compact threshold on huge-context models (e.g. the 1M-token DeepSeek V4.1 Flash capped at 262144 triggers at ~194K instead of ~800K that never fires); auto-compact threshold = a percent of the effective window (**default 80%**, adjustable 70–95% in `/settings`); warning/error = threshold ∓ 20k; blocking limit = effective window − 3k; 3-failure circuit breaker. When a cap shrinks the window, the footer's fullness percentage is also measured against the effective window (e.g. `14.4%/242K`), so the meter tracks the usable window instead of crawling against raw 1M capacity; with no cap the meter reads against full model capacity. The "Auto-compact threshold" row persists to `~/.pi/agent/pi-plus-settings.json` (`src/context/threshold-setting.ts`); `PI_AUTOCOMPACT_PCT_OVERRIDE` keeps its session-scoped, capped-at-the-CC-buffer test semantics. The effective window is also floored at the output reserve plus a context floor buffer (**default 13k**, adjustable 13000–65536 in `/settings`); the floor only ever raises the built-in 13k minimum so small-context models keep a usable (non-negative-threshold) window, and `PI_CONTEXT_FLOOR_TOKENS` overrides it for the session. `PI_AUTO_COMPACT_WINDOW` can only lower the (capped) window further for the session.
2. **Compaction** (`src/compaction/`) — single full-conversation summary using the CC 9-section prompt (`prompt.ts`); prompt-too-long retries drop the oldest turn (`compact.ts`); post-compact re-injection of up to 5 recently read files (50k token budget). Summarization never applies the session thinking level: the summary's output cap is `0.8 × reserveTokens` and reasoning tokens count against it, so a `high` session level on a reasoning model could truncate the summary mid-generation and fail compaction ("generation hit the token cap"). Summary requests carry a no-reasoning marker (`markNoReasoning` in `src/reasoning/effort.ts`) that `wrapStreamFn` honors by stripping reasoning/thinking budgets instead of re-applying the session level.
3. **Reasoning effort** (`src/reasoning/effort.ts`) — CC effort levels (`low`/`medium`/`high`/`max`, `max` → `xhigh` → `high` downgrading), adaptive thinking default, `ultrathink` keyword → high effort for that turn, thinking budgets from env.
4. **Hub profiles** (`src/coding-agent/main.ts` wrapper, backed by `@earendil-works/pi-hub` = `packages/hub`) — named pi profiles (provider/models/thinking/token/base URL) stored in `~/.pi/profiles.json`, materialized into isolated agent dirs under `~/.pi/pi-hub/profiles/<name>/`. Adds `pipi profile …`, `pipi use` / `pipi unuse`, and the `pipi --as <name>` flag. The wrapper resolves the profile, sets `PI_CODING_AGENT_DIR` in-process (read lazily by `getAgentDir()`), and delegates to the original `main`.
5. **CLI surface** (`src/completion/`, `src/coding-agent/cli/args.ts` wrapper) — `pipi --help` gains a "Profile commands (pi-plus)" section, and `pipi completion <bash|zsh>` prints a shell completion script covering the whole CLI: hub subcommands (with dynamic profile/model names from `~/.pi/profiles.json`) plus pi's native commands and flags.
6. **Welcome banner** (`src/coding-agent/ui/banner.ts`, registered as a hidden built-in extension from the `main.ts` wrapper) — pipi's TUI startup header becomes a CC-style banner (ported from better-claude-code-ui) with a block-character π+ mark: condensed logo by default, boxed variant with Extensions/Skills feeds on first run in a project or version change, compact/plain degradation on narrow terminals, `resumed <id> · <title>` on resume/fork. `setHeader` replaces pi's built-in header, so no settings changes are needed.
7. **Vim modal editing** (`src/coding-agent/ui/vim/`, core subset ported from [pi-vimmode](https://github.com/pekochan069/pi-vimmode), MIT, (c) 2026 pekochan069) — vim-style modal editing for the prompt input, as a hidden built-in extension replacing the editor component. Supported: insert/normal/visual (`v`)/visual-line (`V`) modes; motions `h j k l w b e 0 $ ^ f F t T` with counts; operators `d c y` over motions, linewise `dd cc yy`; `x s r J p P i a I A o O C`; `u`/Ctrl-r undo/redo; prompt search `/ ? n N`. Excluded (vs full pi-vimmode): ex commands, macros, marks, named registers, easymotion, visual-block, JS config, cursor-shape escapes. Enable with `"vim": true` in settings — project `.pi/settings.json` wins over the agent dir, which wins over `~/.pi/settings.json` — or toggle with `/vim`, which applies immediately and persists the new state to the agent dir `settings.json` (project settings still override per project).
8. **Subagent tool** (`src/extensions/subagent/`, ported from pi's subagent example, single mode only) — delegates a task to a specialized sub-agent in an isolated `pi -p --no-session` subprocess with its own context window. Agent types are markdown files with frontmatter (`name`, `description`, `tools`, `model`) in `<agent dir>/agents/` or the project's `.pi/agents/`; built-in types `worker` (full toolset) and `explore` (read-only) always exist. Parallel-safe (`executionMode: "parallel"`), abort propagates to the child, child usage/cost is reported, and sub-agents can't recurse unless their definition allows it.
9. **Task tools** (`src/extensions/tasks/`, openclaude V2 style) — `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` backed by one JSON file per task under `<agent dir>/tasks/<sessionId>/` (monotonic ids via `.highwatermark`, atomic tmp+rename writes), with per-task `owner` and `blocks`/`blockedBy` dependencies. `/tasks` or `ctrl+shift+t` opens a task-list overlay in the TUI.
10. **ask_user tool** (`src/extensions/ask-user/`, openclaude AskUserQuestion style) — the model can ask 1–4 structured questions per call (2–4 options with descriptions each, optional `multiSelect`, automatic "Other" free-text). In TUI mode a tabbed overlay dialog collects the answers; RPC mode falls back to sequential select/input dialogs; print/JSON mode makes the tool fail with an error result so the model proceeds with its own assumptions. Guardrails: unique question texts and option labels, no model-supplied "Other" option, header chips ≤ 12 chars.
11. **User command hooks** (`src/extensions/hooks/`) — fires command hooks declared in `settings.json` under a `"hooks"` key (per-event matcher groups of `{type:"command", command, async}` entries; hooks from `~/.pi`, the agent dir, and the project `.pi` settings files are merged) at CC-analogue moments: `PermissionRequest` when any blocking prompt opens (ask_user dialog, plan-mode entry/approval), `PreToolUse` per tool call (`ask_user` matches `AskUserQuestion` matchers), `Stop` when the agent settles. Fire-and-forget detached spawns; never blocks or fails the agent.
12. **Long-term memory** (`src/extensions/memory/`, openclaude memdir/extractMemories style) — per-project memories as markdown files with frontmatter (`name`, `description`, `type`: user/feedback/project/reference) under `<agent dir>/memory/<project-key>/`, indexed in `MEMORY.md` (200-line / 25 KB caps). The `memory_save`/`memory_recall` tools let the model persist and search durable facts; the index is injected as a `<memory>` system-prompt section each run; `/memory` browses/edits/adds/forgets. At `agent_settled` a background sub-agent restricted to the two memory tools reviews the conversation and saves noteworthy facts (skipped when the main agent already saved one, below `extractMinMessages` new messages, or within `extractCooldownMs`). Toggle via the `"memory"` key in settings.json (`enabled`, `autoExtract`, `extractMinMessages`, `extractCooldownMs`; project > agent dir > `~/.pi`).
13. **Tab title + busy spinner** (`src/extensions/tab-title/`) — the terminal window/tab title brands as `pi+ - [sessionName -] cwdBasename` (via the `config.ts` wrapper's `APP_TITLE`, which upstream's `updateTerminalTitle` also uses, so both paths agree). While the agent is working (`agent_start` until `agent_settled`/`turn_end`) or context compaction is running (`session_before_compact` until `session_compact`/`session_compact_failed`, covering manual `/compact` when idle and auto/overflow compaction mid-run), a braille spinner frame is prepended to the title and ticks every 120 ms, so a backgrounded tab shows at a glance that pi+ is busy. TUI mode only; the ticker is cleared on session shutdown.
14. **Plain tool blocks** (`src/extensions/plain-tools/`) — strips the background fills upstream paints on tool result blocks (`toolPendingBg` while running, `toolSuccessBg`/`toolErrorBg` on completion, including edit diff boxes), so tool status reads as text — words like `Command exited with code 3` and the subagent tool's `running` / `✓ done` / `✗ failed` — instead of colored blocks. Implemented as a one-time `Theme.prototype.bg` wrapper (idempotent, applied at extension registration), so it holds across theme switches and spares every other background token (selections, user message bubble).

The CLI identifies as **`pipi`** (pi-plus) in CLI text via the `config.ts` wrapper's `APP_NAME` shadow; the terminal tab title brands as **`pi+`** via the `APP_TITLE` shadow. Scope is the display name only — config dir (`.pi`), `PI_`-prefixed env vars, and session layout stay pi's.

## Mechanism

- `loader/hooks.mjs` — Node module customization hook. Two jobs: (a) map `@earendil-works/*` specifiers to `packages/*/src` (mirrors root tsconfig paths), (b) redirect selected upstream modules to the wrapper modules below. Importers inside `packages/plus/` are never redirected, so wrappers can import the true original via relative path without a loop.
- `loader/run-plus.mjs` + `pipi` — entry point. Runs pi from TypeScript sources on Node's native type stripping (the repo is `erasableSyntaxOnly`). tsx is intentionally not used: its load hook silently produces empty modules when another customization hook is registered alongside it (Node 25).
- `src/<upstream-path>.ts` — wrapper modules. Each does `export * from "<relative path to original>"` and redefines selected exports; per ESM spec, explicit named exports shadow star exports, so everything not overridden passes through untouched.
- Redirect map: `loader/redirects.mjs` (10 modules: coding-agent compaction/agent-session/model-resolver/defaults/config/main/cli-args/settings-selector, agent agent.ts, agent harness compaction).

## Shell completion

`pipi completion <bash|zsh>` prints a completion script for the whole CLI — hub subcommands
(dynamic profile names and per-profile models from `~/.pi/profiles.json`, providers, thinking
levels) plus pi's native commands and flags. Install with:

```bash
source <(pipi completion zsh)   # add to ~/.zshrc
source <(pipi completion bash)   # add to ~/.bashrc
```

## Env vars (pi-style names)

| Var                           | Values                              | Effect                                                          |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `PI_MAX_CONTEXT_TOKENS`       | number                              | Overrides `model.contextWindow` after model resolution          |
| `PI_AUTO_COMPACT_WINDOW`      | number                              | Session cap on the threshold-math window (lowers the persisted cap) |
| `PI_AUTOCOMPACT_PCT_OVERRIDE` | 1–100                               | Auto-compact threshold as % of effective window (capped at default) |
| `PI_CONTEXT_FLOOR_TOKENS`     | number ≥ 13000                      | Context floor override (only raises the built-in 13k floor)     |
| `PI_BLOCKING_LIMIT_OVERRIDE`  | number                              | Blocking limit override                                         |
| `PI_DISABLE_COMPACT`          | truthy                              | Disables all compaction (incl. manual)                          |
| `PI_DISABLE_AUTO_COMPACT`     | truthy                              | Disables threshold-triggered auto-compaction                    |
| `PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS` | ms ≥ 10000                   | Circuit-breaker cooldown after 3 consecutive auto-compact failures |
| `PI_MAX_ACTIVE_MESSAGES`      | number (`0`/invalid = off, default 1000) | Forces compaction when the active message count exceeds the cap  |
| `PI_PRUNE_TAIL_TURNS`         | number ≥ 1 (default 3)              | Recent turns preserved verbatim by relevance pruning            |
| `PI_MICROCOMPACT_IDLE_MINUTES` | minutes (default 60; ≤ 0 disables) | Idle gap that triggers clearing of stale tool-result content on session open |
| `PI_MICROCOMPACT_KEEP_RECENT` | number (default 5)                  | Tool results preserved verbatim by idle micro-compact           |
| `PI_COMPACT_ANALYTICS`        | truthy                              | Emits recompaction diagnostics to stderr after compaction       |
| `PI_COMPACT_DEBUG`            | truthy                              | Stderr stage trace for compaction (prompt built, stream entered/settled, response stopReason, result) |
| `PI_PLUS_SETTINGS_FILE`       | path                                | Overrides `~/.pi/agent/pi-plus-settings.json` (test/debug knob) |
| `PI_EFFORT_LEVEL`             | `off`/`auto`/`low`/`medium`/`high`/`max` | Per-request reasoning effort override                      |
| `PI_MAX_THINKING_TOKENS`      | number (`0` disables)               | Thinking budget (enables thinking at `high` when > 0)           |
| `PI_DISABLE_THINKING`         | truthy                              | Disables thinking entirely                                      |
| `PI_DISABLE_ADAPTIVE_THINKING`| truthy                              | Forces the budget-based thinking path                           |

## Conventions

- Mirror the upstream layout when overriding: e.g. logic overriding `packages/coding-agent/src/core/compaction/compaction.ts` lives in `src/coding-agent/core/compaction/compaction.ts`.
- Prefer extension points over patching: pi's extension API (see `packages/coding-agent/docs/extensions.md`), prompt templates, skills, and settings come first; reach for behavior overrides only when those cannot express the change.
- Each override module must re-export or wrap the upstream implementation instead of copying it, so upstream fixes propagate.
- Overrides are wired in only through the loader; nothing under `packages/plus` may be imported by upstream code.

## Compiled artifact (npm)

`build.mjs` bundles `pipi` into `dist/npm/` — a self-contained staging tree that `npm link` /
`npm publish` operate on (this package itself stays private). The published artifact is
**`pi-plus`** on npmjs; it installs a single global command, **`pipi`** — deliberately
not `pi` (pi-plus must not own pi's command). The CLI identifies as `pipi` everywhere
(help text, hub commands).

```bash
npm run build            # in packages/plus; requires `npm run build:offline` at the repo root first
npm link                 # in packages/plus/dist/npm — global `pipi`
npm publish --access public --ignore-scripts   # in packages/plus/dist/npm
```

The bundle applies `loader/redirects.mjs` at bundle time (esbuild plugin) and keeps each
module a singleton by funneling every `packages/*/src/**` import with a compiled `dist/`
counterpart to that dist file. `--no-env` is preserved via a banner scrub (inert for
library imports: it only scrubs when `process.argv` contains a literal `--no-env`).
Provider credentials, config dir (`~/.pi`), and session layout are identical to
source-mode `pipi`.

### Programmatic API (library hosts)

The same package also exposes a programmatic entry for hosts that embed pi-plus
in-process (e.g. a desktop app) instead of running the `pipi` CLI:

```js
import { createPlusAgentSession } from "pi-plus";

const { session } = await createPlusAgentSession({
	cwd: projectDir,
	ui: {
		select: async (title, options) => showPicker(title, options),
		confirm: async (title, message) => showConfirm(title, message),
		input: async (title, placeholder) => showInput(title, placeholder),
	},
	// Hosts without a pi CLI on PATH should exclude the subagent tool: it
	// launches a pi subprocess and could otherwise relaunch the host app.
	excludeTools: ["subagent"],
});
await session.prompt("Review this repository");
```

- The full pi-plus layer is included: the compaction/context/reasoning overrides are
  baked into `api.js` by the same bundle-time redirect plugin as the CLI, and the seven
  non-TUI pi-plus extensions (subagent, tasks, memory, plan, ask-user, hooks,
  context-guard) are registered exactly as the CLI wrapper registers them.
- `createPlusAgentSession()` extends the upstream `createAgentSession` (re-exported, with
  the whole upstream SDK surface) with those extension factories, and always binds
  extensions once — do not call `session.bindExtensions()` yourself. Pass `ui` dialog
  handlers to get working `ask_user` questions (bound with mode `"rpc"`, so the tool
  falls back to sequential select/input/confirm dialogs bridged to your UI); omit `ui`
  for a headless session.
- The staged `package.json` has an `exports` map, so deep imports (e.g.
  `pi-plus/pipi.js`) are no longer reachable; `api.d.ts` re-exports the
  `@earendil-works/pi-coding-agent` types (exact-pinned dependency, type resolution
  only — the runtime is self-contained). Building `api.js` as a second esbuild entry
  roughly doubles the artifact size.

Known limitations of the compiled artifact:

- `pipi server` / `pipi client` experimental subcommands (`PI_EXPERIMENTAL=1`) spawn sibling JS
  files that are not emitted next to the bundle; use source-mode `./pipi` for those.
- `docs/` and `examples/` are not shipped, so `/docs`-style paths into them are absent.
- Hub profile resolution (`pipi --as <name>`, `pipi profile …`) is CLI-launch logic and is
  not part of the programmatic entry; SDK hosts pass `cwd`/`agentDir` explicitly.

## Tests

```
npx vitest run        # from packages/plus; unit tests under test/ (faux streamFn, no real APIs)
./pipi --no-env    # run pipi (pi-plus) from sources with the override layer active
```
