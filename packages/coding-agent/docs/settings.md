# Settings Reference

This reference lists user-configurable settings, their types, defaults, and purposes. Project settings override agent-directory settings. Resource lists are combined. See [Configuration](configuration.md) for file locations and trust behavior.

Add `"$schema": "https://pi.dev/schemas/settings.schema.json"` to `settings.json` for editor validation and completion.

## Model and thinking

<a id="model-cycling"></a>

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string | Automatic | Startup AI provider. |
| `defaultModel` | string | Automatic | Startup model ID. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | Startup thinking level. |
| `modelThinkingLevels` | object | None | Per-model startup thinking levels keyed by exact `provider/modelId`. |
| `thinkingBudgets` | object | Built-in budgets | Token budgets for `minimal`, `low`, `medium`, and `high` thinking levels. |
| `enabledModels` | `string[]` | All available models | Model patterns used for startup selection and model cycling. Uses the same format as `--models`. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in the transcript. |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant cache misses, successful cache warming, compaction usage, and provider recovery. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"streaming"` | Keep eligible provider prompt caches warm during active runs or, with `"idle"`, between runs. Global setting only. |

Cache warming runs only when the model declares a cache lifetime and Pi estimates at least $0.05 in avoided cache-miss cost. Refresh usage counts toward session totals but does not enter model context. `/session` shows the next decision; extensions can override it with `cache_warming_decision`. See [Prompt Cache Lifetimes](models.md#prompt-cache-lifetimes).

See [Choose a Model](models.md) for model selection and thinking controls.

## Interaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued steering messages are delivered. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued follow-up messages are delivered. |
| `externalEditor` | string | `$VISUAL`, `$EDITOR`, then platform default | Command opened by the external-editor keybinding. |
| `doubleEscapeAction` | `"tree" \| "fork" \| "none"` | `"tree"` | Action for double Escape with an empty editor. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Initial filter used by `/tree`. |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Fallback project-trust behavior. **Can only be set in agent-directory settings.** |

## Tools

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write`, `grep`, `find` | Tools enabled at startup. Plain names replace the defaults; `+name` adds a tool and `-name` removes one. An empty array disables all built-in tools but not extension or SDK tools. |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | How the `codemode` tool presents tools while it is active. `on`: declared tools get a note on calling them from scripts appended to their description, and `codemode` lists only tools that are not declared. `only`: `codemode` lists every tool scripts can call, and active built-in and extension tools are hidden from the model, so it reaches them through `codemode`. |
| `codemode.inlineBudget` | number | `3000` | Estimated tokens (characters / 4) the `codemode` tool's description may spend on tool declarations. Tools that do not fit are left out and found with `searchTools()`. `0` lists only namespaces. |

Available built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. `defaultTools` can also name `codemode` and `tool_search`, which built-in extensions register inactive, and other extension tools registered inactive.

A list of only `+name` and `-name` entries changes the inherited selection instead of replacing it. For example, this enables `codemode` next to the default tools:

```json
{
  "defaultTools": ["+codemode"]
}
```

This replaces `bash` with `powershell` and enables `ls`: `["-bash", "+powershell", "+ls"]`. Project settings apply on top of user settings: a project list with only `+name` and `-name` entries changes the user's selection, and a project list with a plain name replaces it. In one list, plain names form the selection, and `+name` and `-name` then apply in order.

`/reload` enables tools newly added to `defaultTools`. It does not disable tools removed from it or re-enable unchanged tools you turned off. `--tools` with plain names, `--no-tools`, and `--no-builtin-tools` override `defaultTools`, also on reload.

CLI tool options override this setting for one invocation. `--tools` with only `+name` and `-name` entries changes the resolved `defaultTools` selection instead, for example `pi --tools +codemode`. On `/reload`, these entries apply to the reloaded setting too, so a tool removed with `-name` stays removed. See [Command Line](cli.md#tools).

## Document reading

| Setting | Type | Default | Description |
|---|---|---|---|
| `read.browserExecutablePath` | string | Auto-discover installed Chromium | Trusted Chrome/Chromium-family executable for explicit `read` calls with `strategy:"browser"`. Prefer an absolute path. |

No browser runs for ordinary URL reads or as an automatic extraction fallback. Explicit browser reads reuse a persistent Pi-owned profile and browser per canonical project working directory, shared by Pi processes using the same agent directory. Your personal browser and login are never attached. Cookies and site storage acquired inside Pi persist under `<agent-dir>/browser/<project-hash>/`; see [document and web reading](../README.md#document-and-web-reading) for retention and reset instructions. Chromium sandboxing remains enabled, and Pi never downloads a browser. Both fetching and browser rendering honor inherited HTTP/HTTPS proxy settings. The executable override is checked at execution time; a running project browser rejects conflicting executable/proxy settings, so close Pi processes using the project before changing them.

## Output artifacts

| Setting | Type | Default | Description |
|---|---|---|---|
| `outputArtifacts.maxInlineTokens` | positive safe integer | `8000` | Maximum estimated tokens of inline text per tool result. |
| `outputArtifacts.contextWindowFraction` | number, greater than 0 and at most 1 | `0.05` | Further bound each result by this fraction of the selected model's context window. |

The effective budget is the smaller of these limits, with a 128-token floor for references and navigation. Estimation uses four UTF-16 characters per token, not a provider tokenizer; a separate 64 KiB UTF-8 byte ceiling applies. Reference and navigation text consume the same budget. Image attachments are preserved separately.

Oversized text from built-ins, extensions, and MCP tools is retained and replaced with an `artifact://...` reference plus a bounded preview. Use `read` with the exact reference and ordinary 1-indexed `offset`/`limit` line arguments. Pages also report a 0-indexed `byteOffset` continuation, so even a single very long line can be retrieved without gaps. Do not supply `offset` and `byteOffset` together.

Native shell captures spill while producing output, with backpressure and storage errors propagated to the producer. Assembled results are saved when the tool returns. Nested programmatic calls keep their full returned text and structured values; the outer result shown to the model gets the shared budget. Existing query, source-file read, and upstream-tool limits still apply: artifacts cannot restore data discarded before it reaches this layer.

Persistent artifacts live under `<agent-dir>/artifacts/`, outside session JSONL, and survive resume and compaction. Main and child sessions have separate namespaces. Temporary-session artifacts use `artifact://temporary/...` references valid only in the originating process and are removed on normal process exit. References can be read explicitly across main and side sessions without merging their histories; SDK hosts should use the same configured agent directory for related sessions.

On POSIX, new files and directories use owner-only permissions; Windows inherits directory ACLs. Captures are not encrypted and can contain credentials or other sensitive output. Streaming command captures can retain text later hidden by result hooks. Persistent captures have no automatic expiration or quota: preserve the artifact store alongside session backups, and remove only files no retained session, fork, or checkpoint needs. See [Session storage](session-format.md#output-artifacts).

## Sub-agents

| Setting | Type | Default | Description |
|---|---|---|---|
| `subagents.maxConcurrent` | positive safe integer | `4` | Maximum active children per parent manager; additional tasks queue until a slot is available. |

Role definitions, descriptions, local tool selections, and optional model/thinking overrides use Markdown files in `<agent-dir>/agents/` or the nearest project `.pi/agents/`, not inline settings objects. See [Native sub-agents](../README.md#native-sub-agents) for the format, trust checks, controls, and history isolation.


## Sessions and context

| Setting | Type | Default | Description |
|---|---|---|---|
| `sessionDir` | string | Agent session directory | Session storage directory. Relative paths resolve from the working directory. `PI_CODING_AGENT_SESSION_DIR` and `--session-dir` override this setting. |
| `sessionShareDestination` | `"auto" \| "gist" \| "radius"` | `"auto"` | Destination used by `/share`. `auto` uses Radius when authenticated and otherwise creates a GitHub gist. `gist` always uses a gist. `radius` requires Radius authentication and never falls back to a gist. |

### Compaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | Enable automatic compaction. |
| `compaction.prepareThreshold` | number | `75` | Context percentage at which background summary preparation starts. |
| `compaction.threshold` | number | `85` | Context percentage at which Pi waits for and applies the prepared summary. |
| `compaction.maxSummaryTokens` | number | `8000` | Maximum total summary output tokens, bounded by model limits. |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens retained by manual/overflow compaction. Background preparation keeps its whole live tail. |
| `compaction.modelOverrides` | object | None | Per-model percentages and budgets keyed by exact `provider/modelId`. |

<a id="per-model-compaction-overrides"></a>

Percentages may be fractional: `0 <= prepareThreshold < threshold <= 100`. `maxSummaryTokens` must be a positive safe integer and `keepRecentTokens` a non-negative safe integer. Each field resolves independently from the matching model override, then the ordinary setting, then the built-in default. Project and user objects merge before model lookup. `enabled` is not model-specific.

Preparation freezes completed history; all subsequent messages remain verbatim when the summary is applied. Original entries stay in the session and the default `recall_context` tool can recover omitted details through a read-only LLM helper. Recall makes additional model calls. The old `compaction.reserveTokens` fields are retired and removed on the next settings write; set percentage thresholds instead.

See [Compaction Reference](compaction.md) for trigger, summarization, and validation behavior.

### Branch summaries

| Setting | Type | Default | Description |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when summarizing branch history. |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the branch-summary prompt and default to no summary. |

## Terminal and display

| Setting | Type | Default | Description |
|---|---|---|---|
| `theme` | string | `"system"` | Built-in or custom theme name. `system` derives colors from the terminal theme. |
| `iconPreset` | `"unicode" \| "nerd"` | `"unicode"` | Shared interactive icon catalog. The Nerd Font preset requires a Nerd Font selected in the terminal. |
| `quietStartup` | boolean \| `"header"` | `false` | `true` hides the startup header and loaded-resource listing. `"header"` keeps the header (version and key hints) but hides the model scope line and loaded-resource listing. |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | Interactive terminal UI mode. |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | Output printed when fullscreen mode exits. |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | Fullscreen transcript scrollbar behavior. |
| `fullscreenCopyOnSelect` | boolean | `true` | Copy selected text automatically in fullscreen mode. |
| `fullscreenWheelScrollLines` | `"auto"` \| number | `"auto"` | Lines per mouse-wheel event in fullscreen mode, from 1 to 100. `"auto"` moves one line per event in local macOS terminals, which already accelerate wheel and trackpad input; elsewhere, and over SSH, it speeds up fast wheel spins to at most 6 lines per event. Alt+wheel moves five times as far. |
| `editorPaddingX` | number | `0` | Horizontal editor padding from 0 to 3 cells. |
| `outputPad` | `0 \| 1` | `1` | Horizontal transcript padding for messages, tool output, `!` command output, and summary blocks. |
| `autocompleteMaxVisible` | number | `5` | Visible autocomplete entries, from 3 to 20. |
| `showHardwareCursor` | boolean | `false` | Use the terminal cursor instead of Pi's drawn cursor. Pi still positions it for input methods. |
| `terminal.showImages` | boolean | `true` | Display inline images when supported. |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells. |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when rendered content shrinks. When unset, `PI_CLEAR_ON_SHRINK=1` enables it. |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress in the terminal tab. |
| `terminal.hyperlinks` | `boolean \| "auto"` | `"auto"` | Override OSC 8 hyperlink detection. |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` | `"auto"` | Override inline-image protocol detection. |
| `terminal.trueColor` | `boolean \| "auto"` | `"auto"` | Override true-color detection. |
| `images.autoResize` | boolean | `true` | Resize images to at most 2000 by 2000 pixels before sending them to a model. |
| `images.blockImages` | boolean | `false` | Prevent images from being sent to models. |
| `markdown.codeBlockIndent` | string | `"  "` | Prefix used to indent rendered code blocks. |
| `markdown.mermaid` | `"off" \| "final" \| "streaming"` | `"streaming"` | Mermaid rendering mode. |

See [Themes](themes.md) and [Terminal Setup](terminal-setup.md) for format and platform details.

To enable Nerd Font icons, open `/settings`, search for **Icons**, and select `nerd`, or set `"iconPreset": "nerd"` in `settings.json` and run `/reload`. The copy picker uses `U+F44F` for code blocks, `U+F10E` for quotes, and `U+F09A8` for the whole response. Other components and extensions can use the same [shared icon API](tui.md#use-shared-icons). The setting changes glyphs, not copied text. Pi does not install fonts or detect missing glyphs; use `unicode` if the terminal shows empty boxes.

## Network and retries

| Setting | Type | Default | Description |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Preferred transport for AI providers that support multiple transports. |
| `httpProxy` | string | None | Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for Pi-managed HTTP clients. **Can only be set in agent-directory settings.** |
| `httpIdleTimeoutMs` | number \| `"disabled"` | `300000` | HTTP header and body idle timeout in milliseconds. Set to `0` or `"disabled"` to disable. |
| `websocketConnectTimeoutMs` | number \| `"disabled"` | `15000` | WebSocket connection timeout in milliseconds. Set to `0` or `"disabled"` to disable. |
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry for transient failures. |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts. |
| `retry.baseDelayMs` | number | `2000` | Initial exponential-backoff delay in milliseconds. |
| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level retry delay in milliseconds. |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Provider request timeout in milliseconds. |
| `retry.provider.maxRetries` | number | `0` | Provider-level retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay in milliseconds. Set to `0` to disable the limit. |

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are required. Provider retries can delay Pi from handling quota and usage-limit errors itself.

## Shell

| Setting | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string | Platform default | Custom shell executable path. Supports a leading `~`. |
| `shellCommandPrefix` | string | None | Prefix prepended to every shell command. |
| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation. |
| `selfUpdateCommand` | `string[]` | None | Command and arguments `pi update` runs to update Pi itself, with `{packageName}`, `{version}`, and `{installSpec}` placeholders. `PI_SELF_UPDATE_COMMAND` takes precedence. **Can only be set in agent-directory settings.** See [Custom update command](cli.md#custom-update-command). |

See [Shell aliases](shell-aliases.md) for shell setup and [Pi Packages](packages.md) for package-manager behavior.

## Resources

Resource paths in user settings resolve from the agent directory. Paths in project settings resolve from the project `.pi` directory. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---|---|---|---|
| `packages` | array | `[]` | npm, git, or local Pi package sources. See [Pi Packages](packages.md). |
| `extensions` | `string[]` | `[]` | Extension files or directories. |
| `skills` | `string[]` | `[]` | Skill files or directories. |
| `prompts` | `string[]` | `[]` | Prompt-template files or directories. |
| `themes` | `string[]` | `[]` | Theme files or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands. |

Resource arrays support glob exclusions with `!pattern`, exact inclusion with `+path`, and exact exclusion with `-path`. Pi loads resources listed in both user-level and project settings.

Built-in extensions include `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, and `builtin:tool-search` in `extensions`. They load by default; `-builtin:mcp` disables one. A `+builtin:<name>` or `-builtin:<name>` entry in project settings overrides the user setting. `pi config` lists them under Built-in. `--no-extensions` disables them too, and `-e builtin:<name>` loads one explicitly.

`builtin:recall` enables the default `recall_context` checkpoint-retrieval tool. Use `-builtin:recall` to disable it without disabling compaction.

`builtin:subagents` enables the native `subagent` tool and `/agents` view by default. Use `-builtin:subagents` to disable both. An installed extension that replaces `subagent` or `/agents` can supersede the native implementation; remove that replacement to use native controls and isolated retained histories.

## Updates, telemetry, and warnings

| Setting | Type | Default | Description |
|---|---|---|---|
| `collapseChangelog` | boolean | `false` | Show a condensed changelog after an update. Also condenses extension package changelogs to one line per package. |
| `enableInstallTelemetry` | boolean | `true` | Enable anonymous install/update reporting and selected provider attribution headers. Does not control update checks. |
| `enableAnalytics` | boolean | `false` | Opt in to analytics data sharing. Currently used only by the experimental first-run setup. |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription authentication may use paid extra usage. |
