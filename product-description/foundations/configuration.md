# Configuration

## Summary

pi keeps everything it remembers under one directory, `~/.pi/agent/`, and reads a small number of settings from a JSON file there and, for trusted projects, from `.pi/settings.json` in the project. This document owns the directory layout, the precedence between command-line flags, project settings, global settings, and built-in defaults, the full list of defaults the other documents depend on, the environment variables pi reads, and what `/settings` and `/reload` do to all of it. It has no interaction of its own; the settings panel is [its own document](../settings/the-settings-panel.md).

## The simple case

A fresh install has no `~/.pi/agent/` at all. The first run creates it, with `sessions/` for the first saved session and `bin/` for the `fd` and `rg` binaries pi downloads. The user opens `/settings`, changes the theme to light, and closes the panel; `~/.pi/agent/settings.json` now contains `{"theme": "light"}` and every later run uses it. Nothing else is written unless the user changes something.

## The agent directory

`~/.pi/agent/`, or the directory named by `PI_CODING_AGENT_DIR`. Its contents, all created on demand:

| Path | What it is |
| --- | --- |
| `settings.json` | Global settings, written by `/settings`, Ctrl+S in selectors, and by hand. |
| `auth.json` | Stored credentials from `/login`; owner-only permissions. |
| `keybindings.json` | Key overrides; absent until the user creates it. |
| `trust.json` | Project trust decisions, keyed by directory. |
| `sessions/<dir>/` | Session files, one subdirectory per working directory; see [sessions](sessions.md). |
| `bin/` | Downloaded `fd` and `rg`, prepended to `PATH` for shell commands and tools. |
| `models.json` | Custom providers and models; out of scope. |
| `skills/`, `prompts/`, `extensions/`, `themes/`, `npm/`, `git/` | Resources and packages; out of scope. |
| `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` | Global context file and system-prompt overrides, if the user creates them. |
| `pi-debug.log` | Written by the hidden `/debug` command. |

In the project: `.pi/settings.json` (project settings), `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, `.pi/skills/`, `.pi/prompts/`, `.pi/extensions/`, `.pi/themes/`. Any of these existing makes the project one that needs a [trust decision](../settings/project-trust.md); until the project is trusted they are all ignored and a warning says so at startup. `AGENTS.md` in the project is not a trust-requiring resource and is always read.

## Precedence

For a setting that several sources could supply, the first of these wins:

1. A command-line flag for this run (`--use-theme`, `--thinking`, `--model`, `--tools`, `--session-dir`, `--no-context-files`, …). Flags never write to a file.
2. An environment variable, for the few settings that have one (`PI_CODING_AGENT_SESSION_DIR` for the session directory; `PI_HARDWARE_CURSOR` and `PI_CLEAR_ON_SHRINK` are exceptions: the settings file beats them).
3. `.pi/settings.json` in the working directory, if the project is trusted. Nested objects merge key by key with the global file; an array (`defaultTools`, `packages`) replaces the global array.
4. `~/.pi/agent/settings.json`.
5. The built-in default.

`/settings` and Ctrl+S always write the global file, merging only the keys they changed so that edits made by hand or by another pi process are kept. A settings file that does not parse is reported as a warning at startup and treated as empty; pi never writes back to a file it could not read.

## Defaults

The values every other document assumes. Settings not in `/settings` are edited by hand.

| Setting | Default | Where it matters |
| --- | --- | --- |
| `defaultProvider`, `defaultModel` | unset | [models](models-and-credentials.md) |
| `defaultThinkingLevel` | `medium` | [thinking](../conversation/thinking.md) |
| `modelThinkingLevels` | none | per-model level overrides |
| `enabledModels` | unset (every available model) | [cycling models](../models/cycling-models.md) |
| `theme` | auto-detected from the terminal, `dark` fallback | [themes](../settings/themes.md) |
| `steeringMode`, `followUpMode` | `one-at-a-time` | [the message queue](../conversation/the-message-queue.md) |
| `compaction.enabled` | `true` | [compaction](../sessions/compaction.md) |
| `compaction.reserveTokens` | `16384` | threshold: window minus this |
| `compaction.keepRecentTokens` | `20000` | kept verbatim |
| `branchSummary.reserveTokens` | `16384` | [the tree](../sessions/the-tree.md) |
| `branchSummary.skipPrompt` | `false` | skip the summarize question |
| `retry.enabled` | `true` | [errors and retries](../cross-cutting/errors-and-retries.md) |
| `retry.maxRetries` | `3` | |
| `retry.baseDelayMs` | `2000` (2, 4, 8 s) | |
| `retry.provider.maxRetryDelayMs` | `60000` | longest provider-requested wait before failing |
| `httpIdleTimeoutMs` | `300000` | a stalled stream fails after 5 minutes |
| `transport` | `auto` | |
| `hideThinkingBlock` | `false` | Ctrl+T |
| `showCacheMissNotices` | `false` | |
| `quietStartup` | `false` | [the screen](the-screen.md) |
| `collapseChangelog` | `false` | after an upgrade |
| `enableInstallTelemetry` | `true` | one anonymous ping after install or upgrade |
| `enableAnalytics` | `false` | |
| `defaultProjectTrust` | `ask` | global only |
| `doubleEscapeAction` | `tree` | [input](input.md#escape) |
| `treeFilterMode` | `default` | |
| `editorPaddingX` | `0` (0–3) | |
| `outputPad` | `1` (0 or 1) | |
| `autocompleteMaxVisible` | `5` (3–20) | [autocomplete](../conversation/autocomplete.md) |
| `showHardwareCursor` | `false` | |
| `tuiMode` | `regular` | |
| `fullscreenExitOutput`, `fullscreenScrollbar` | `transcript`, `auto` | fullscreen only |
| `markdown.codeBlockIndent` | two spaces | |
| `markdown.mermaid` | `streaming` | |
| `terminal.showImages` | `true` | |
| `terminal.imageWidthCells` | `60` | |
| `terminal.clearOnShrink` | `false` | |
| `terminal.showTerminalProgress` | `false` | undocumented in the user docs |
| `images.autoResize` | `true` (2000×2000) | |
| `images.blockImages` | `false` | |
| `warnings.anthropicExtraUsage` | `true` | |
| `externalEditor` | `$VISUAL`, then `$EDITOR`, then `nano` (Notepad on Windows) | Ctrl+G |
| `shellPath`, `shellCommandPrefix`, `npmCommand` | unset | shell commands and the `bash` tool |
| `defaultTools` | `read`, `bash`, `edit`, `write` | [tool calls](../conversation/tool-calls.md) |
| `sessionDir` | unset | [sessions](sessions.md) |
| `enableSkillCommands` | `true` | no effect with no skills |
| `packages`, `extensions`, `skills`, `prompts`, `themes` | empty | out of scope |
| `httpProxy` | unset | applied as `HTTP_PROXY`/`HTTPS_PROXY`; global only |

Limits that are not settings: tool output 2,000 lines or 50 KB; prompt history 100 entries; large paste 10 lines or 1,000 characters; double-press window 500 ms; provider catalogue refresh and login 15 s; version check 10 s; OAuth refresh when under 5 minutes remain, 15 s to refresh.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Relocate the agent directory. |
| `PI_CODING_AGENT_SESSION_DIR` | Relocate session storage (below `--session-dir`, above `sessionDir`). |
| `PI_OFFLINE` (`1`, `true`, `yes`) or `--offline` | No startup network: no version check, no catalogue refresh, no package check, no telemetry, no `fd`/`rg` download. (The model selector still prints `Model catalogs refreshed.` when opened.) |
| `PI_SKIP_VERSION_CHECK` | No version check only. |
| `PI_HARDWARE_CURSOR=1` | Show the terminal's cursor (for IME positioning); the setting overrides it. |
| `PI_CLEAR_ON_SHRINK=1` | As the setting. |
| `PI_TUI_ESC_TIMEOUT` | Milliseconds to wait before a lone Escape byte counts as the Escape key. |
| `PI_EXPERIMENTAL=1` | Experimental features; out of scope. |
| Provider keys | `ANTHROPIC_API_KEY` and the rest; see [models](models-and-credentials.md#credentials). |
| `VISUAL`, `EDITOR` | The external editor for Ctrl+G. |

pi sets `AI_AGENT=pi` and `PI_CODING_AGENT=true` in every process it starts, and `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` in the model's `bash` tool (not in user `!` commands).

## Keybindings

`~/.pi/agent/keybindings.json` maps action ids to a key or a list of keys: `{"tui.editor.historyPrevious": "ctrl+p", "tui.input.newLine": ["shift+enter", "ctrl+j"]}`. A user binding replaces the defaults for that action; an empty list unbinds it. Conflicts between user bindings are reported at startup; conflicts between defaults are not. Old ids without a namespace are migrated in place. `/reload` applies changes. The full default table is in [input](input.md#default-keybindings).

## Trust

`~/.pi/agent/trust.json` maps directory paths to `true` or `false`. The nearest ancestor with a decision wins. See [project trust](../settings/project-trust.md).

## Changing configuration at runtime

- `/settings` writes each change to the global file as it is made and applies it to the running session at once for everything it exposes (theme, padding, thinking visibility, transport, queue modes, auto-compaction, image settings, trust default, double-Escape action, TUI mode). Nothing needs a restart except `quietStartup`, `collapseChangelog`, the project-trust default, and install telemetry, which apply at the next start or install.
- Ctrl+S in the model, thinking, and scoped-models selectors writes `defaultProvider`/`defaultModel`, `defaultThinkingLevel`, and `enabledModels`.
- `/reload` re-reads `settings.json` (applying theme, padding, queue modes, and the rest), `keybindings.json`, context files, and the resource directories; it is refused while the agent is working.
- Editing `settings.json` by hand while pi runs: the next `/settings` write merges around the edit; the running session keeps its current values until `/reload` or a restart. `models.json` and `auth.json` are watched or re-read and take effect without restart.
- `/trust` writes `trust.json` and asks for a restart.

## Interactions with other systems

**Session persistence.** The session directory location and nothing else.

**Branching and history.** No interaction.

**Compaction.** `compaction.*` and `branchSummary.*`.

**Context files and the system prompt.** `~/.pi/agent/AGENTS.md` is read on every run; `SYSTEM.md` and `APPEND_SYSTEM.md` in the agent directory replace or extend the system prompt; `--system-prompt` and `--append-system-prompt` override them; `--no-context-files` skips all context files.

**Settings and keybindings.** This document.

**Tools and the working directory.** `defaultTools`, `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`; `shellPath`, `shellCommandPrefix`.

**Terminal and rendering.** `theme`, `terminal.*`, `images.*`, `outputPad`, `editorPaddingX`, `showHardwareCursor`, `markdown.*`.

**Credentials and providers.** `auth.json`, `defaultProvider`/`defaultModel`, `httpProxy`, `transport`, `retry.provider.*`.

## Edge cases

- A project `.pi/settings.json` in an untrusted project is not merely ignored: the startup warning names it and `/trust` is the way out.
- `defaultProjectTrust` and `httpProxy` are read from the global file only; putting them in a project file does nothing.
- `editorPaddingX` and `autocompleteMaxVisible` are clamped when written by `/settings`; values outside the range written by hand are clamped on read.
- A `theme` value containing `/` (`light/dark`) means an automatic light/dark pair; the panel's Theme row shows the raw value, and the submenu offers "Automatic" to set one.
- The user docs list `websocketConnectTimeoutMs` with a default of 15000; the settings code has no default for it and leaves the provider's own in place.
- Settings written by an older pi under old names (`queueMode`, `websockets`, `retry.maxDelayMs`) are migrated when read.

## Open questions and verification

- Whether the `PI_HARDWARE_CURSOR`/`PI_CLEAR_ON_SHRINK` precedence (setting beats environment) is intended or an accident of the getters was not determined; it is the reverse of every other environment variable.
- The claim that `auth.json` changes from another process are picked up on the next call was read from a revision-cache in the auth store and not observed.
- The `websocketConnectTimeoutMs` documentation mismatch may be worth treating as a documentation bug rather than documenting here.

Verified against pi-mono commit `a69bef789`.
