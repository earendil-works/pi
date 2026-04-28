# Changelog

## [Unreleased]

### Changed

- Changed Pi version checks to identify Pi with a `pi/<version>` user agent.

### Fixed

- Fixed `pi update` to skip self-update reinstalls when the installed version is already current ([#3853](https://github.com/badlogic/pi-mono/issues/3853)).
- Fixed Cloudflare Workers AI attribution headers to honor the install telemetry setting.
- Fixed `pi update --self` detection and execution for Windows package-manager shim installs, including symlinked global package roots, and print the manual fallback command when self-update fails. ([#3857](https://github.com/badlogic/pi-mono/issues/3857))

## [0.70.5] - 2026-04-27

### Fixed

- Fixed HTML export preserving ANSI-renderer trailing padding as extra blank wrapped lines.

## [0.70.4] - 2026-04-27

### Fixed

- Fixed packaged `pi` startup failing because the session selector imported a source-only utility path.

## [0.70.3] - 2026-04-27

### New Features

- `pi update` can now update pi itself in addition to installed pi packages. See [docs/packages.md](docs/packages.md). ([#3680](https://github.com/badlogic/pi-mono/pull/3680) by [@mitsuhiko](https://github.com/mitsuhiko))
- Azure Cognitive Services endpoint support for Azure OpenAI Responses deployments. See [docs/providers.md#api-keys](docs/providers.md#api-keys). ([#3799](https://github.com/badlogic/pi-mono/pull/3799) by [@marcbloech](https://github.com/marcbloech))
- Suppressible Anthropic extra-usage billing warning via `warnings.anthropicExtraUsage` in `/settings`. See [docs/settings.md](docs/settings.md). ([#3808](https://github.com/badlogic/pi-mono/issues/3808))
- Extension-controlled working row visibility via `ctx.ui.setWorkingVisible()`, allowing extensions to hide the built-in loader row and render custom working state. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/border-status-editor.ts](examples/extensions/border-status-editor.ts). ([#3674](https://github.com/badlogic/pi-mono/issues/3674))

### Added

- Added `pi update` support for updating pi itself in addition to installed pi packages ([#3680](https://github.com/badlogic/pi-mono/pull/3680) by [@mitsuhiko](https://github.com/mitsuhiko)).
- Added Azure Cognitive Services endpoint support for Azure OpenAI Responses base URLs ([#3799](https://github.com/badlogic/pi-mono/pull/3799) by [@marcbloech](https://github.com/marcbloech)).
- Added `warnings.anthropicExtraUsage` and a `/settings` warnings submenu to suppress the Anthropic extra usage billing warning ([#3808](https://github.com/badlogic/pi-mono/issues/3808))
- Added `ctx.ui.setWorkingVisible()` so extensions can hide the built-in interactive working loader row without reserving layout space, plus a border-status editor example that moves working state into a custom editor border ([#3674](https://github.com/badlogic/pi-mono/issues/3674))

### Fixed

- Fixed duplicate printable characters from Kitty keyboard protocol CSI-u plus raw character input on layouts such as Italian ([#3780](https://github.com/badlogic/pi-mono/issues/3780)).
- Fixed API-key environment discovery and Bun startup to fall back to `/proc/self/environ` when Bun's sandbox leaves `process.env` empty ([#3801](https://github.com/badlogic/pi-mono/pull/3801) by [@mdsjip](https://github.com/mdsjip)).
- Fixed Bun sandboxed package-manager commands when `process.env` is empty ([#3807](https://github.com/badlogic/pi-mono/pull/3807) by [@mdsjip](https://github.com/mdsjip)).
- Fixed symlinked packages, resources, skills, and sessions being duplicated in selectors and loaders ([#3818](https://github.com/badlogic/pi-mono/pull/3818) by [@aliou](https://github.com/aliou)).
- Fixed Bedrock prompt-caching and adaptive-thinking capability checks for inference profile ARNs ([#3527](https://github.com/badlogic/pi-mono/pull/3527) by [@anirudhmarc](https://github.com/anirudhmarc)).
- Fixed OpenAI Codex Responses default verbosity to `low` when no verbosity is specified.
- Stopped sending empty `tools` arrays to providers that reject them when tools are disabled ([#3650](https://github.com/badlogic/pi-mono/pull/3650) by [@HQidea](https://github.com/HQidea)).
- Fixed Anthropic SSE parsing to ignore unknown proxy events such as OpenAI-style `done` terminators ([#3708](https://github.com/badlogic/pi-mono/issues/3708)).
- Fixed provider registration with override-only `models.json` entries to preserve built-in model lists ([#3651](https://github.com/badlogic/pi-mono/issues/3651)).
- Fixed `/login` to show auth supplied by `models.json` provider definitions.
- Fixed HTML export whitespace around extension-rendered tool output and expandable output hints.
- Fixed bash executor temp output streams leaking file descriptors when output was truncated by line count ([#3786](https://github.com/badlogic/pi-mono/issues/3786))
- Fixed extension `pi.setSessionName()` updates to refresh the interactive terminal title immediately ([#3686](https://github.com/badlogic/pi-mono/issues/3686))
- Fixed `/tree` cancellation via `session_before_tree` leaving the session stuck in compaction state ([#3688](https://github.com/badlogic/pi-mono/issues/3688))
- Fixed Escape interrupt handling when extensions hide the built-in working loader row ([#3674](https://github.com/badlogic/pi-mono/issues/3674))
- Fixed coding-agent test expectations for current default models and missing-auth guidance.
- Fixed long local-LLM SSE streams aborting at 5 minutes with `UND_ERR_BODY_TIMEOUT` by disabling undici `bodyTimeout`/`headersTimeout` on the global dispatcher; provider SDKs continue to enforce their own deadlines via `retry.provider.timeoutMs` ([#3715](https://github.com/badlogic/pi-mono/issues/3715))

## [0.70.2] - 2026-04-24

### Fixed

- Fixed provider retry/timeout forwarding to omit undefined provider request controls, avoiding downstream SDK validation errors such as `timeout must be an integer` when `retry.provider.timeoutMs` is not configured ([#3627](https://github.com/badlogic/pi-mono/issues/3627))

## [0.70.1] - 2026-04-24

### New Features

- DeepSeek provider support with V4 Flash/Pro models and `DEEPSEEK_API_KEY` authentication. See [README.md#providers--models](README.md#providers--models) and [docs/providers.md#api-keys](docs/providers.md#api-keys).
- Provider request timeout/retry controls via `retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}`, useful for long-running local inference and provider SDK retry behavior. See [docs/settings.md#retry](docs/settings.md#retry). ([#3627](https://github.com/badlogic/pi-mono/issues/3627))

### Added

- Added DeepSeek to built-in provider setup, default model resolution, and provider documentation.

### Fixed

- Fixed `/copy` to avoid unbounded OSC 52 writes and clipboard races that could break terminal rendering or panic the native clipboard addon ([#3639](https://github.com/badlogic/pi-mono/issues/3639))
- Fixed extension flag docs to show `pi.getFlag()` using registered flag names without the CLI `--` prefix ([#3614](https://github.com/badlogic/pi-mono/issues/3614))
- Fixed provider retry/timeout settings wiring by adding `retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}`, migrating legacy `retry.maxDelayMs`, and forwarding provider controls into `streamSimple` request options ([#3627](https://github.com/badlogic/pi-mono/issues/3627))
- Fixed Windows git package installs to bypass `cmd.exe` for native git commands, so install paths containing spaces no longer break `pi install git:...` with `fatal: Too many arguments` ([#3642](https://github.com/badlogic/pi-mono/issues/3642))
- Fixed DeepSeek V4 session replay 400 errors by sending DeepSeek-compatible thinking controls and replayed assistant `reasoning_content` fields ([#3636](https://github.com/badlogic/pi-mono/issues/3636))
- Fixed GPT-5.5 generated context window metadata to use the observed 272k limit.
- Fixed CSI-u Ctrl+letter decoding inside bracketed paste, so pasted modified-key escape sequences no longer become literal editor text ([#3623](https://github.com/badlogic/pi-mono/pull/3623) by [@Exrun94](https://github.com/Exrun94))

## [0.70.0] - 2026-04-23

### New Features

- Searchable auth provider login flow: the `/login` provider selector now supports fuzzy search/filtering, making it faster to find providers when many are configured. See [docs/providers.md](docs/providers.md). ([#3572](https://github.com/badlogic/pi-mono/pull/3572) by [@mitsuhiko](https://github.com/mitsuhiko))
- GPT-5.5 Codex support: `openai-codex/gpt-5.5` is available as a model option, including `xhigh` reasoning support and corrected priority-tier pricing.
- Terminal progress indicators are now opt-in: OSC 9;4 progress reporting during streaming/compaction is off by default and can be toggled via `terminal.showTerminalProgress` in `/settings` ([#3588](https://github.com/badlogic/pi-mono/issues/3588))
- `--no-builtin-tools` / `createAgentSession({ noTools: "builtin" })` now correctly disables only built-in tools while keeping extension tools active. See [docs/extensions.md](docs/extensions.md) and [README.md](README.md) ([#3592](https://github.com/badlogic/pi-mono/issues/3592))

### Breaking Changes

- Disabled OSC 9;4 terminal progress indicators by default. Set `terminal.showTerminalProgress` to `true` in `/settings` to re-enable ([#3588](https://github.com/badlogic/pi-mono/issues/3588))

### Added

- Added searchable auth provider login flow with fuzzy filtering in the provider selector ([#3572](https://github.com/badlogic/pi-mono/pull/3572) by [@mitsuhiko](https://github.com/mitsuhiko))
- Added GPT-5.5 Codex model
- Added auth source labels in `/login` so provider entries can show when auth comes from `--api-key`, an environment variable, or custom provider fallback without exposing secrets.

### Changed

- Updated default model selection across providers to current recommended models.
- Improved stale extension context errors after session replacement or reload to tell extension authors to avoid captured `pi`/command `ctx` and use `withSession` for post-replacement work.

### Fixed

- Fixed `/model` selector cancellation to request render instead of incorrectly triggering login selector.
- Changed login, OAuth, and extension selectors for more consistent styling.
- Added Amazon Bedrock setup guidance to `/login` and updated `/model` copy to refer to configured providers instead of only API keys.
- Improved no-model and missing-auth warnings to point users to `/login` for OAuth or API key setup.
- Fixed `/quit` shutdown ordering to stop the TUI before extension UI teardown can repaint, preserving the final rendered frame while still emitting `session_shutdown` before process exit.
- Fixed `SettingsManager.inMemory()` initial settings being lost after reloads triggered by SDK resource loading ([#3616](https://github.com/badlogic/pi-mono/issues/3616))
- Fixed `models.json` provider compatibility to accept `compat.supportsLongCacheRetention`, allowing proxies to opt out of long-retention cache fields when needed while long retention is enabled by default when requested ([#3543](https://github.com/badlogic/pi-mono/issues/3543))
- Fixed `--thinking xhigh` for `openai-codex` `gpt-5.5` so it is no longer downgraded to `high`.
- Fixed git package installs with custom `npmCommand` values such as `pnpm` by avoiding npm-specific production flags in that compatibility path ([#3604](https://github.com/badlogic/pi-mono/issues/3604))
- Fixed first user messages rendering without spacing after existing notices such as compaction summaries or status messages ([#3613](https://github.com/badlogic/pi-mono/issues/3613))
- Fixed the handoff extension example to use the replacement-session context after creating a new session, avoiding stale `ctx` errors when it installs the generated prompt ([#3606](https://github.com/badlogic/pi-mono/issues/3606))
- Fixed session replacement and `/quit` teardown ordering to run host-owned extension UI cleanup synchronously after `session_shutdown` handlers complete but before invalidating the old extension context, preventing stale extension UI from rendering against a disposed session ([#3597](https://github.com/badlogic/pi-mono/pull/3597) by [@vegarsti](https://github.com/vegarsti))
- Fixed crash on `/quit` when an extension registers a custom footer whose `render()` accesses `ctx`, by tearing down extension-provided UI before invalidating the extension runner during shutdown ([#3595](https://github.com/badlogic/pi-mono/issues/3595))
- Fixed auto-retry to treat Bedrock/Smithy HTTP/2 transport failures like `http2 request did not get a response` as transient errors, so the agent retries automatically instead of waiting for a manual nudge ([#3594](https://github.com/badlogic/pi-mono/issues/3594))
- Fixed the CLI/SDK tool-selection split so `--no-builtin-tools` and `createAgentSession({ noTools: "builtin" })` disable only built-in default tools while keeping extension/custom tools enabled, instead of falling through to the same "disable everything" path as `--no-tools` ([#3592](https://github.com/badlogic/pi-mono/issues/3592))
- Fixed remaining hardcoded `pi` / `.pi` branding to route through `APP_NAME` and `CONFIG_DIR_NAME` extension points, so SDK rebrands get consistent naming in `/quit` description, `process.title`, and the project-local extensions directory ([#3583](https://github.com/badlogic/pi-mono/pull/3583) by [@jlaneve](https://github.com/jlaneve))
- Fixed `pi-coding-agent` shipping `uuid@11`, which triggered `npm audit` moderate vulnerability reports for downstream installs; the package now depends on `uuid@14` ([#3577](https://github.com/badlogic/pi-mono/issues/3577))
- Fixed `openai-completions` streamed tool-call assembly to coalesce deltas by stable tool index when OpenAI-compatible gateways mutate tool call IDs mid-stream, preventing malformed Kimi K2.6/OpenCode tool streams from splitting one call into multiple bogus tool calls ([#3576](https://github.com/badlogic/pi-mono/issues/3576))
- Fixed `ctx.ui.setWorkingMessage()` to persist across loader recreation, matching the behavior of `ctx.ui.setWorkingIndicator()` ([#3566](https://github.com/badlogic/pi-mono/issues/3566))
- Fixed coding-agent `fs.watch` error handling for theme and git-footer watchers to retry after transient watcher failures such as `EMFILE`, avoiding startup crashes in large repos ([#3564](https://github.com/badlogic/pi-mono/issues/3564))
- Fixed built-in `kimi-coding` model generation to attach the expected `User-Agent` header so direct Kimi Coding requests use the provider's expected client identity ([#3586](https://github.com/badlogic/pi-mono/issues/3586))
- Fixed extension shortcut conflict diagnostics to display at startup instead of only on reload, so extension authors discover reserved keybinding conflicts immediately rather than discovering them later through user feedback ([#3617](https://github.com/badlogic/pi-mono/issues/3617))
- Fixed `models.json` Anthropic-compatible provider configuration to accept `compat.supportsEagerToolInputStreaming`, allowing proxies that reject per-tool `eager_input_streaming` to use the legacy fine-grained tool streaming beta header instead ([#3575](https://github.com/badlogic/pi-mono/issues/3575))
- Fixed startup banner extension labels to strip trailing `index.js`/`index.ts` suffixes ([#3596](https://github.com/badlogic/pi-mono/pull/3596) by [@aliou](https://github.com/aliou))
- Fixed OSC 9;4 terminal progress updates to stay alive in terminals such as Ghostty during long-running agent work ([#3610](https://github.com/badlogic/pi-mono/issues/3610))
- Fixed OpenAI-compatible completion usage parsing to avoid double-counting reasoning tokens already included in `completion_tokens` ([#3581](https://github.com/badlogic/pi-mono/issues/3581))
- Fixed `openai-responses` compatibility for strict OpenAI-compatible proxies by allowing `models.json` to disable the underscore-containing `session_id` header with `compat.sendSessionIdHeader: false` ([#3579](https://github.com/badlogic/pi-mono/issues/3579))
- Fixed GPT-5.5 Codex capability handling to clamp unsupported minimal reasoning to `low` and apply the model's 2.5x priority service-tier pricing multiplier ([#3618](https://github.com/badlogic/pi-mono/pull/3618) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.69.0] - 2026-04-22

### New Features

- TypeBox 1.x migration for extensions and SDK integrations, including TypeBox-native tool argument validation that now works in eval-restricted runtimes such as Cloudflare Workers. See [docs/extensions.md](docs/extensions.md) and [docs/sdk.md](docs/sdk.md).
- Stacked extension autocomplete providers via `ctx.ui.addAutocompleteProvider(...)`, allowing extensions to layer custom completion logic on top of built-in slash and path completion. See [docs/extensions.md#autocomplete-providers](docs/extensions.md#autocomplete-providers) and [examples/extensions/github-issue-autocomplete.ts](examples/extensions/github-issue-autocomplete.ts).
- Terminating tool results via `terminate: true`, allowing custom tools to end on a final tool call without paying for an automatic follow-up LLM turn. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/structured-output.ts](examples/extensions/structured-output.ts).
- OSC 9;4 terminal progress indicators during agent streaming and compaction for supporting terminals.

### Breaking Changes

- Migrated first-party coding-agent code, SDK/examples/docs, and package metadata from `@sinclair/typebox` 0.34.x to `typebox` 1.x. New extensions, SDK integrations, and pi packages should depend on and import from `typebox`. Legacy extension loading still aliases the root `@sinclair/typebox` package, but `@sinclair/typebox/compiler` is no longer shimmed. This migration also picks up the new `@mariozechner/pi-ai` TypeBox-native validator path, so tool argument validation now works in eval-restricted runtimes such as Cloudflare Workers instead of being skipped ([#3112](https://github.com/badlogic/pi-mono/issues/3112))
- Session-replacement commands now invalidate captured pre-replacement session-bound extension objects after `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()`. Old `pi` and command `ctx` references now throw instead of silently targeting the replaced session. Migration: if code needs to keep working in the replacement session after one of those calls, pass `withSession` to that same method and do the post-switch work there. In practice, move post-switch `pi.sendUserMessage()`, `pi.sendMessage()`, and command-ctx/session-manager access into `withSession`, and use only the `ReplacedSessionContext` passed to that callback for session-bound operations. Footguns: `withSession` runs after the old extension instance has already received `session_shutdown`, old cleanup may already have invalidated captured state, captured old `pi` / old command `ctx` are stale, and previously extracted raw objects such as `const sm = ctx.sessionManager` remain the caller's responsibility and must not be reused after the switch.

### Added

- Added support for terminating tool results via `terminate: true`, allowing custom tools to end the current tool batch without an automatic follow-up LLM call, plus a `structured-output.ts` extension example and extension docs showing the pattern ([#3525](https://github.com/badlogic/pi-mono/issues/3525))
- Added OSC 9;4 terminal progress indicators during agent streaming and compaction, so terminals like iTerm2, WezTerm, Windows Terminal, and Kitty show activity in their tab bar
- Added `ctx.ui.addAutocompleteProvider(...)` for stacking extension autocomplete providers on top of the built-in slash/path provider, plus a `github-issue-autocomplete.ts` example and extension docs ([#2983](https://github.com/badlogic/pi-mono/issues/2983))

### Fixed

- Fixed exported session HTML to sanitize markdown link URLs before rendering them into anchor tags, blocking `javascript:`-style payloads while preserving safe links in shared/exported sessions ([#3532](https://github.com/badlogic/pi-mono/issues/3532))
- Fixed `ctx.getSystemPrompt()` inside `before_agent_start` to reflect chained system-prompt changes made by earlier `before_agent_start` handlers, and clarified the extension docs around provider-payload rewrites and what `ctx.getSystemPrompt()` does and does not report ([#3539](https://github.com/badlogic/pi-mono/issues/3539))
- Fixed built-in `google-gemini-cli` model lists and selector entries to include `gemini-3.1-flash-lite-preview`, so Cloud Code Assist users no longer need manual `--model` fallback selection to use it ([#3545](https://github.com/badlogic/pi-mono/issues/3545))
- Fixed extension session-replacement flows so `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, and imported-session replacements fully rebind before post-switch work runs, added `withSession` replacement callbacks with fresh `ReplacedSessionContext` helpers, and make stale pre-replacement `pi` / `ctx` session-bound accesses throw instead of silently targeting the wrong session ([#2860](https://github.com/badlogic/pi-mono/issues/2860))
- Fixed `models.json` built-in provider overrides to accept `headers` without requiring `baseUrl`, so request-header-only overrides now load and apply correctly ([#3538](https://github.com/badlogic/pi-mono/issues/3538))

## [0.68.1] - 2026-04-22

### New Features

- Fireworks provider support with built-in models and `FIREWORKS_API_KEY` auth. See [README.md#providers--models](README.md#providers--models) and [docs/providers.md](docs/providers.md).
- Configurable inline tool image width via `terminal.imageWidthCells` in `/settings`. See [docs/settings.md#terminal--images](docs/settings.md#terminal--images).

### Added

- Added built-in Fireworks provider support, including `FIREWORKS_API_KEY` setup/docs and the default Fireworks model `accounts/fireworks/models/kimi-k2p6` ([#3519](https://github.com/badlogic/pi-mono/issues/3519))

### Fixed

- Fixed interactive inline tool images to honor configurable `terminal.imageWidthCells` via `/settings`, so tool-output images are no longer hard-capped to 60 terminal cells ([#3508](https://github.com/badlogic/pi-mono/issues/3508))
- Fixed `sessionDir` in `settings.json` to expand `~`, so portable session-directory settings no longer require a shell wrapper ([#3514](https://github.com/badlogic/pi-mono/issues/3514))
- Fixed parallel tool-call rows to leave the pending state as soon as each tool is finalized, while still appending persisted tool results in assistant source order ([#3503](https://github.com/badlogic/pi-mono/issues/3503))
- Fixed exported session markdown to render Markdown while showing HTML-like message content such as `<file name="...">...</file>` verbatim, so shared sessions match the TUI instead of letting the browser interpret message text ([#3484](https://github.com/badlogic/pi-mono/issues/3484))
- Fixed exported session HTML to render `grep` and `find` output through their existing TUI renderers and `ls` output through a native template renderer, avoiding missing formatting and spacing artifacts in shared sessions ([#3491](https://github.com/badlogic/pi-mono/pull/3491) by [@aliou](https://github.com/aliou))
- Fixed `@` autocomplete fuzzy search to follow symlinked directories and include symlinked paths in results ([#3507](https://github.com/badlogic/pi-mono/issues/3507))
- Fixed proxied agent streams to preserve the proxy-safe serializable subset of stream options, including session, transport, retry-delay, metadata, header, cache-retention, and thinking-budget settings ([#3512](https://github.com/badlogic/pi-mono/issues/3512))
- Hardened Anthropic streaming against malformed tool-call JSON by owning SSE parsing with defensive JSON repair, replacing the deprecated `fine-grained-tool-streaming` beta header with per-tool `eager_input_streaming`, and updating stale test model references ([#3175](https://github.com/badlogic/pi-mono/issues/3175))
- Fixed Bedrock runtime endpoint resolution to stop pinning built-in regional endpoints over `AWS_REGION` / `AWS_PROFILE`, restoring `us.*` and `eu.*` inference profile support after v0.68.0 while preserving custom VPC/proxy endpoint overrides ([#3481](https://github.com/badlogic/pi-mono/issues/3481), [#3485](https://github.com/badlogic/pi-mono/issues/3485), [#3486](https://github.com/badlogic/pi-mono/issues/3486), [#3487](https://github.com/badlogic/pi-mono/issues/3487), [#3488](https://github.com/badlogic/pi-mono/issues/3488))

## [0.68.0] - 2026-04-20

### New Features

- Configurable streaming working indicator for extensions via `ctx.ui.setWorkingIndicator()`, including animated, static, and hidden indicators. See [docs/tui.md#working-indicator](docs/tui.md#working-indicator), [docs/extensions.md](docs/extensions.md), and [examples/extensions/working-indicator.ts](examples/extensions/working-indicator.ts).
- `before_agent_start` now exposes `systemPromptOptions` (`BuildSystemPromptOptions`) so extensions can inspect the structured system-prompt inputs without re-discovering resources. See [docs/extensions.md#before_agent_start](docs/extensions.md#before_agent_start) and [examples/extensions/prompt-customizer.ts](examples/extensions/prompt-customizer.ts).
- Configurable keybindings for scoped model selector actions and session-tree filter actions. See [docs/keybindings.md](docs/keybindings.md).
- `/clone` duplicates the current active branch into a new session, while extensions can choose whether to fork `before` or `at` an entry via `ctx.fork(..., { position })`. See [README.md](README.md), [docs/extensions.md](docs/extensions.md), and [docs/session.md](docs/session.md).

### Breaking Changes

- Changed SDK and CLI tool selection from cwd-bound built-in tool instances to tool-name allowlists. `createAgentSession({ tools })` now expects `string[]` names such as `"read"` and `"bash"` instead of `Tool[]`, `--tools` now allowlists built-in, extension, and custom tools by name, and `--no-tools` now disables all tools by default rather than only built-ins. Migrate SDK code from `tools: [readTool, bashTool]` to `tools: ["read", "bash"]` ([#2835](https://github.com/badlogic/pi-mono/issues/2835), [#3452](https://github.com/badlogic/pi-mono/issues/3452))
- Removed prebuilt cwd-bound tool and tool-definition exports from `@mariozechner/pi-coding-agent`, including `readTool`, `bashTool`, `editTool`, `writeTool`, `grepTool`, `findTool`, `lsTool`, `readOnlyTools`, `codingTools`, and the corresponding `*ToolDefinition` values. Use the explicit factory exports instead, for example `createReadTool(cwd)`, `createBashTool(cwd)`, `createCodingTools(cwd)`, and `createReadToolDefinition(cwd)` ([#3452](https://github.com/badlogic/pi-mono/issues/3452))
- Removed ambient `process.cwd()` / default agent-dir fallback behavior from public resource helpers. `DefaultResourceLoader`, `loadProjectContextFiles()`, and `loadSkills()` now require explicit cwd/agent-dir style inputs, and exported system-prompt option types now require an explicit `cwd`. Pass the session or project cwd explicitly instead of relying on process-global defaults ([#3452](https://github.com/badlogic/pi-mono/issues/3452))

### Added

- Added extension support for customizing the interactive streaming working indicator via `ctx.ui.setWorkingIndicator()`, including custom animated frames, static indicators, hidden indicators, a new `working-indicator.ts` example extension, and updated extension/TUI/RPC docs ([#3413](https://github.com/badlogic/pi-mono/issues/3413))
- Added `systemPromptOptions` (`BuildSystemPromptOptions`) to `before_agent_start` extension events, so extensions can inspect the structured inputs used to build the current system prompt ([#3473](https://github.com/badlogic/pi-mono/pull/3473) by [@dljsjr](https://github.com/dljsjr))
- Added `/clone` to duplicate the current active branch into a new session, while keeping `/fork` focused on forking from a previous user message ([#2962](https://github.com/badlogic/pi-mono/issues/2962))
- Added `ctx.fork()` support for `position: "before" | "at"` so extensions and integrations can branch before a user message or duplicate the current point in the conversation; the interactive clone/fork UX builds on that runtime support ([#3431](https://github.com/badlogic/pi-mono/pull/3431) by [@mitsuhiko](https://github.com/mitsuhiko))
- Added configurable keybinding ids for scoped model selector actions and tree filter actions, so those interactive shortcuts can be remapped in `keybindings.json` ([#3343](https://github.com/badlogic/pi-mono/pull/3343) by [@mpazik](https://github.com/mpazik))
- Added `PI_OAUTH_CALLBACK_HOST` support for built-in OAuth login flows, allowing local callback servers used by `pi auth` to bind to a custom interface instead of hardcoded `127.0.0.1` ([#3409](https://github.com/badlogic/pi-mono/pull/3409) by [@Michaelliv](https://github.com/Michaelliv))
- Added `reason` and `targetSessionFile` metadata to `session_shutdown` extension events, so extensions can distinguish quit, reload, new-session, resume, and fork teardown paths ([#2863](https://github.com/badlogic/pi-mono/issues/2863))

### Changed

- Changed `pi update` to batch npm package updates per scope and run git package updates with bounded parallelism, reducing multi-package update time while preserving skip behavior for pinned and already-current packages ([#2980](https://github.com/badlogic/pi-mono/issues/2980))
- Changed Bedrock session requests to omit `maxTokens` when model token limits are unknown and to omit `temperature` when unset, letting Bedrock use provider defaults and avoid unnecessary TPM quota reservation ([#3400](https://github.com/badlogic/pi-mono/pull/3400) by [@wirjo](https://github.com/wirjo))

### Fixed

- Fixed `AgentSession` system-prompt option initialization to avoid constructing an invalid empty `BuildSystemPromptOptions`, so `npm run check` passes after `cwd` became mandatory.
- Fixed shell-path resolution to stop consulting ambient `process.cwd()` state during bash execution, so session/project-specific `shellPath` settings now follow the active coding-agent session cwd instead of the launcher cwd ([#3452](https://github.com/badlogic/pi-mono/issues/3452))
- Fixed `ctx.ui.setWorkingIndicator()` custom frames to render verbatim instead of forcing the theme accent color, so extensions now own working-indicator coloring when they customize it ([#3467](https://github.com/badlogic/pi-mono/issues/3467))
- Fixed `pi update` reinstalling npm packages that are already at the latest published version by checking the installed package version before running `npm install <pkg>@latest` ([#3000](https://github.com/badlogic/pi-mono/issues/3000))
- Fixed `@` autocomplete plain queries to stop matching against the full cwd/base path, so path fragments in worktree names no longer crowd out intended results such as `@plan` ([#2778](https://github.com/badlogic/pi-mono/issues/2778))
- Fixed built-in tool wrapping to use the same extension-runner context path as extension tools, so built-in tools receive execution context and `read` can warn when the current model does not support images ([#3429](https://github.com/badlogic/pi-mono/issues/3429))
- Fixed `openai-completions` assistant replay to preserve `compat.requiresThinkingAsText` text-part serialization, avoiding same-model follow-up crashes when previous assistant messages mix thinking and text ([#3387](https://github.com/badlogic/pi-mono/issues/3387))
- Fixed direct OpenAI Chat Completions sessions to map `sessionId` and `cacheRetention` to prompt caching fields, sending `prompt_cache_key` when caching is enabled and `prompt_cache_retention: "24h"` for direct `api.openai.com` requests with long retention ([#3426](https://github.com/badlogic/pi-mono/issues/3426))
- Fixed OpenAI-compatible Chat Completions sessions to optionally send aligned `session_id`, `x-client-request-id`, and `x-session-affinity` headers from `sessionId` via `compat.sendSessionAffinityHeaders`, improving cache-affinity routing for backends such as Fireworks ([#3430](https://github.com/badlogic/pi-mono/issues/3430))
- Fixed threaded `/resume` session relationships and current-session detection to canonicalize symlinked session paths during selector comparisons, so shared session directories no longer break parent-child matching or active-session delete protection ([#3364](https://github.com/badlogic/pi-mono/issues/3364))
- Fixed `/session`, Sessions docs, and CLI help to consistently document that session reuse supports both file paths and session IDs, and that `/session` shows the current session ID ([#3390](https://github.com/badlogic/pi-mono/issues/3390))
- Fixed Windows pnpm global install detection to recognize `\\.pnpm\\` store paths, so update notices now suggest `pnpm install -g @mariozechner/pi-coding-agent` instead of falling back to npm ([#3378](https://github.com/badlogic/pi-mono/issues/3378))
- Fixed missing `@sinclair/typebox` runtime dependency in `@mariozechner/pi-coding-agent`, so strict pnpm installs no longer fail with `ERR_MODULE_NOT_FOUND` when starting `pi` ([#3434](https://github.com/badlogic/pi-mono/issues/3434))
- Fixed xterm uppercase typing in the interactive editor by decoding printable `modifyOtherKeys` input and normalizing shifted letter matching, so `Shift+letter` no longer disappears in `pi` ([#3436](https://github.com/badlogic/pi-mono/issues/3436))
- Fixed `/compact` to reuse the session thinking level for compaction summaries instead of forcing `high`, avoiding invalid reasoning-effort errors on `github-copilot/claude-opus-4.7` sessions configured for `medium` thinking ([#3438](https://github.com/badlogic/pi-mono/issues/3438))
- Fixed shared/exported plain-text tool output to preserve indentation instead of collapsing leading whitespace in the web share page ([#3440](https://github.com/badlogic/pi-mono/issues/3440))
- Fixed exported share pages to use browser-safe `T` and `O` shortcuts with clickable header toggles for thinking and tool visibility instead of browser-reserved `Ctrl+T` / `Ctrl+O` bindings ([#3374](https://github.com/badlogic/pi-mono/pull/3374) by [@vekexasia](https://github.com/vekexasia))
- Fixed skill resolution to dedupe symlinked aliases by canonical path, so `pi config` no longer shows duplicate skill entries when `~/.pi/agent/skills` points to `~/.agents/skills` ([#3417](https://github.com/badlogic/pi-mono/pull/3417) by [@rwachtler](https://github.com/rwachtler))
- Fixed OpenRouter request attribution to include Pi app headers (`HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi`, `X-OpenRouter-Categories: cli-agent`) when sessions are created through the coding-agent SDK and install telemetry is enabled ([#3414](https://github.com/badlogic/pi-mono/issues/3414))
- Fixed custom-model `compat` schema/docs to support `cacheControlFormat: "anthropic"` for OpenAI-compatible providers that expose Anthropic-style prompt caching via `cache_control` markers ([#3392](https://github.com/badlogic/pi-mono/issues/3392))
- Fixed Cloud Code Assist tool schemas to strip JSON Schema meta-declaration keys before provider translation, avoiding validation failures for tool-enabled sessions that use `$schema`, `$defs`, and related metadata ([#3412](https://github.com/badlogic/pi-mono/pull/3412) by [@vladlearns](https://github.com/vladlearns))
- Fixed direct Bedrock sessions to honor `model.baseUrl` as the runtime client endpoint, restoring support for custom Bedrock VPC or proxy routes ([#3402](https://github.com/badlogic/pi-mono/pull/3402) by [@wirjo](https://github.com/wirjo))
- Fixed the `edit` tool to coerce stringified `edits` JSON before validation, so models that send the array payload as a JSON string no longer fall back to ad-hoc shell edits ([#3370](https://github.com/badlogic/pi-mono/pull/3370) by [@dannote](https://github.com/dannote))
- Fixed package manifest positive glob entries to expand before loading packaged resources, restoring manifest patterns such as `skills/**/*.md` ([#3350](https://github.com/badlogic/pi-mono/pull/3350) by [@neonspectra](https://github.com/neonspectra))

## [0.67.68] - 2026-04-17

## [0.67.67] - 2026-04-17

### New Features

- Bedrock sessions can now authenticate with `AWS_BEARER_TOKEN_BEDROCK`, enabling Converse API access without local SigV4 credentials. See [docs/providers.md#amazon-bedrock](docs/providers.md#amazon-bedrock).

### Added

- Added Bedrock bearer-token authentication support via `AWS_BEARER_TOKEN_BEDROCK`, enabling coding-agent sessions to use Bedrock Converse without local SigV4 credentials ([#3125](https://github.com/badlogic/pi-mono/pull/3125) by [@wirjo](https://github.com/wirjo))

### Fixed

- Fixed `/scoped-models` Alt+Up/Down to stay a no-op in the implicit `all enabled` state instead of materializing a full explicit enabled-model list and marking the selector dirty ([#3331](https://github.com/badlogic/pi-mono/issues/3331))
- Fixed Mistral Small 4 default thinking requests to use the model's supported reasoning control, avoiding `400` errors when starting sessions on `mistral-small-2603` and `mistral-small-latest` ([#3338](https://github.com/badlogic/pi-mono/issues/3338))
- Fixed Qwen chat-template thinking replay to preserve prior thinking across turns, so affected OpenAI-compatible models keep multi-turn tool-call arguments instead of degrading to empty `{}` payloads ([#3325](https://github.com/badlogic/pi-mono/issues/3325))
- Fixed exported HTML transcripts so text selection no longer triggers click-based expand/collapse toggles ([#3332](https://github.com/badlogic/pi-mono/pull/3332) by [@xu0o0](https://github.com/xu0o0))
- Fixed flaky git package update notifications by waiting for captured git command stdio to fully drain before comparing local and remote commit SHAs ([#3027](https://github.com/badlogic/pi-mono/issues/3027))
- Fixed system prompt dates to use a stable `YYYY-MM-DD` format instead of locale-dependent output, keeping prompts deterministic across runtimes and locales ([#2814](https://github.com/badlogic/pi-mono/issues/2814))
- Fixed auto-retry transient error detection to treat `Network connection lost.` as retryable, so dropped provider connections retry instead of terminating the agent ([#3317](https://github.com/badlogic/pi-mono/issues/3317))
- Fixed compact interactive extension startup summaries to disambiguate package extensions and repeated local `index.ts` entries by using package-aware labels and the minimal parent path needed to make local entries unique ([#3308](https://github.com/badlogic/pi-mono/issues/3308))
- Fixed git package dependency installation to use production installs (`npm install --omit=dev`) during both install and update flows, so extension runtime dependencies must come from `dependencies` and not `devDependencies` ([#3009](https://github.com/badlogic/pi-mono/issues/3009))
- Fixed `tool_result` / `afterToolCall` extension handling for error results by forwarding `details` and `isError` overrides through `AgentSession` instead of dropping them when `isError` was already true ([#3051](https://github.com/badlogic/pi-mono/issues/3051))
- Fixed missing root exports for `RpcClient` and RPC protocol types from `@mariozechner/pi-coding-agent`, so ESM consumers can import them from the main package entrypoint ([#3275](https://github.com/badlogic/pi-mono/issues/3275))
- Fixed OpenAI Codex service-tier cost accounting to trust the explicitly requested tier when the API echoes the default tier in responses, keeping session cost displays aligned with the selected tier ([#3307](https://github.com/badlogic/pi-mono/pull/3307) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Fixed parallel tool-call finalization to convert `afterToolCall` hook throws into error tool results instead of aborting the remaining tool batch ([#3084](https://github.com/badlogic/pi-mono/issues/3084))
- Fixed Bun binary asset path resolution to honor `PI_PACKAGE_DIR` for built-in themes, HTML export templates, and interactive bundled assets ([#3074](https://github.com/badlogic/pi-mono/issues/3074))
- Fixed user-message turn spacing in interactive mode by restoring an inter-message spacer before user turns (except the first user message), preventing assistant and user blocks from rendering flush together.
- Fixed interactive `/import` handling to support quoted JSONL paths with spaces, route missing JSONL files through the non-fatal `SessionImportFileNotFoundError` path, and document the `importFromJsonl()` exceptions (`SessionImportFileNotFoundError`, `MissingSessionCwdError`).

## [0.67.6] - 2026-04-16

### New Features

- Prompt templates support an `argument-hint` frontmatter field that renders before the description in the `/` autocomplete dropdown, using `<angle>` for required and `[square]` for optional arguments. See [docs/prompt-templates.md#argument-hints](docs/prompt-templates.md#argument-hints).
- New `after_provider_response` extension hook lets extensions inspect provider HTTP status codes and headers immediately after each response is received and before stream consumption begins. See [docs/extensions.md](docs/extensions.md).
- Compact interactive startup header with a comma-separated view of loaded AGENTS.md files, prompt templates, skills, and extensions. Press `Ctrl+O` to toggle the expanded listing.
- Markdown links in assistant output now render as OSC 8 hyperlinks on terminals that advertise support; unknown terminals and tmux/screen default to plain text so URLs are never silently dropped.

### Added

- Added `argument-hint` frontmatter field for prompt templates, displayed before the description in the autocomplete dropdown ([#2780](https://github.com/badlogic/pi-mono/pull/2780) by [@andresvi94](https://github.com/andresvi94))
- Added `after_provider_response` extension hook so extensions can inspect provider HTTP status codes and headers after each provider response is received and before stream consumption begins ([#3128](https://github.com/badlogic/pi-mono/issues/3128))
- Added OSC 8 hyperlink rendering for markdown links when the terminal advertises support ([#3248](https://github.com/badlogic/pi-mono/pull/3248) by [@ofa1](https://github.com/ofa1))

### Changed

- Changed interactive startup header to a compact, comma-separated view of loaded AGENTS.md files, prompt templates, skills, and extensions, with `Ctrl+O` to toggle the expanded listing ([#3267](https://github.com/badlogic/pi-mono/pull/3267))
- Tightened hyperlink capability detection to default `hyperlinks: false` for unknown terminals and force it off under tmux/screen (including nested sessions), preventing markdown link URLs from disappearing on terminals that silently swallow OSC 8 sequences ([#3248](https://github.com/badlogic/pi-mono/pull/3248))

### Fixed

- Fixed interactive user message rendering to keep bottom padding visible in terminals affected by OSC 133 prompt markers without adding an extra blank line before the following assistant message ([#3090](https://github.com/badlogic/pi-mono/issues/3090))
- Fixed `--verbose` startup output to begin with expanded startup help and loaded resource listings after the compact startup header change ([#3147](https://github.com/badlogic/pi-mono/issues/3147))
- Fixed `find` tool returning no results for path-based glob patterns such as `src/**/*.spec.ts` or `some/parent/child/**` by switching fd into full-path mode and normalizing the pattern when it contains a `/` ([#3302](https://github.com/badlogic/pi-mono/issues/3302))
- Fixed `find` tool applying nested `.gitignore` rules across sibling directories (e.g. rules from `a/.gitignore` hiding matching files under `b/`) by dropping the manual `--ignore-file` collection and delegating to fd's hierarchical `.gitignore` handling via `--no-require-git` ([#3303](https://github.com/badlogic/pi-mono/issues/3303))
- Fixed OpenAI Responses prompt caching for non-`api.openai.com` base URLs (OpenAI-compatible proxies such as litellm, theclawbay) by sending the `session_id` and `x-client-request-id` cache-affinity headers unconditionally when a `sessionId` is provided, matching the official Codex CLI behavior ([#3264](https://github.com/badlogic/pi-mono/pull/3264) by [@vegarsti](https://github.com/vegarsti))
- Fixed the `preset` example extension to snapshot the active model, thinking level, and tool set on the first preset application and restore that state when cycling back to `(none)`, instead of falling back to a hardcoded default tool list ([#3272](https://github.com/badlogic/pi-mono/pull/3272) by [@stembi](https://github.com/stembi))

## [0.67.5] - 2026-04-16

### Fixed

- Fixed Opus 4.7 adaptive thinking configuration across Anthropic and Bedrock providers by recognizing Opus 4.7 adaptive-thinking support and mapping `xhigh` reasoning to provider-supported effort values ([#3286](https://github.com/badlogic/pi-mono/pull/3286) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Fixed Zellij `Shift+Enter` regressions by reverting the Zellij-specific Kitty keyboard query bypass and restoring the previous keyboard negotiation behavior ([#3259](https://github.com/badlogic/pi-mono/issues/3259))

## [0.67.4] - 2026-04-16

### New Features

- `--no-context-files` (`-nc`) disables automatic `AGENTS.md` / `CLAUDE.md` discovery when you need a clean run without project context injection. See [README.md#context-files](README.md#context-files).
- `loadProjectContextFiles()` is now exported as a standalone utility for extensions and SDK-style integrations that need to inspect the same context-file resolution order used by the CLI. See [README.md#context-files](README.md#context-files).
- New `after_provider_response` extension hook lets extensions inspect provider HTTP status codes and headers immediately after response creation and before stream consumption. See [docs/extensions.md](docs/extensions.md).

### Added

- Added `--no-context-files` (`-nc`) to disable `AGENTS.md` and `CLAUDE.md` context file discovery and loading ([#3253](https://github.com/badlogic/pi-mono/issues/3253))
- Exported `loadProjectContextFiles()` as a standalone utility so extensions can discover project context files without instantiating a full `DefaultResourceLoader` ([#3142](https://github.com/badlogic/pi-mono/issues/3142))
- Added `after_provider_response` extension hook so extensions can inspect provider HTTP status codes and headers after each provider response is received and before stream consumption begins ([#3128](https://github.com/badlogic/pi-mono/issues/3128))

### Changed

- Added `claude-opus-4-7` model for Anthropic.
- Changed Anthropic prompt caching to add a `cache_control` breakpoint on the last tool definition, so tool schemas can be cached independently from transcript updates while preserving existing cache retention behavior ([#3260](https://github.com/badlogic/pi-mono/issues/3260))

### Fixed

- Fixed markdown strikethrough parsing in interactive rendering and HTML export to require strict double-tilde delimiters (`~~text~~`) with non-whitespace boundaries.
- Fixed shutdown handling to kill tracked detached `bash` tool child processes on exit signals, preventing orphaned background processes.
- Fixed flaky `edit-tool-no-full-redraw` TUI tests by waiting for asynchronous preview and preflight error rendering instead of relying on fixed render ticks.
- Fixed `kimi-coding` default model selection to use `kimi-for-coding` instead of `kimi-k2-thinking` ([#3242](https://github.com/badlogic/pi-mono/issues/3242))
- Fixed `ctrl+z` on native Windows to avoid crashing interactive mode, disable the default suspend binding there, and show a status message when suspend is invoked manually ([#3191](https://github.com/badlogic/pi-mono/issues/3191))
- Fixed `find` tool cancellation and responsiveness on broad searches by making `.gitignore` discovery and `fd` execution fully abort-aware and non-blocking ([#3148](https://github.com/badlogic/pi-mono/issues/3148))
- Fixed `grep` broad-search stalls when `context=0` by formatting match lines from ripgrep JSON output instead of doing synchronous per-match file reads ([#3205](https://github.com/badlogic/pi-mono/issues/3205))

## [0.67.3] - 2026-04-15

### New Features

- `renderShell: "self"` for custom and built-in tool renderers so tools can own their outer shell instead of the default boxed shell. Useful for stable large previews such as edit diffs. See [docs/extensions.md#custom-rendering](docs/extensions.md#custom-rendering).
- Interactive auto-retry status now shows a live countdown during backoff instead of a static retry delay message.

### Added

- Added `renderShell: "self"` for custom and built-in tool renderers so tools can own their outer shell instead of using the default boxed shell. This is useful for stable large previews such as edit diffs ([#3134](https://github.com/badlogic/pi-mono/issues/3134))

### Fixed

- Fixed edit diff previews to stay visible during edit permission dialogs and session replay without reintroducing large-result redraw flicker ([#3134](https://github.com/badlogic/pi-mono/issues/3134))
- Fixed `/reload` to render a static reload status box instead of an animated spinner, avoiding redraw instability during interactive reloads.
- Fixed the `plan-mode` example extension to allow `eza` in the read-only bash allowlist instead of the deprecated `exa` command ([#3240](https://github.com/badlogic/pi-mono/pull/3240) by [@rwachtler](https://github.com/rwachtler))
- Fixed `google-vertex` API key resolution to treat `gcp-vertex-credentials` as an Application Default Credentials marker instead of a literal API key, so marker-based setups correctly fall back to ADC ([#3221](https://github.com/badlogic/pi-mono/pull/3221) by [@deepkilo](https://github.com/deepkilo))
- Fixed RPC `prompt` to wait for prompt preflight success before emitting its single authoritative response, while still treating handled and queued prompts as success ([#3049](https://github.com/badlogic/pi-mono/issues/3049))
- Fixed `/scoped-models` reordering to propagate into the `/model` scoped tab, preserving the user-defined scoped model order instead of re-sorting it ([#3217](https://github.com/badlogic/pi-mono/issues/3217))
- Fixed `session_shutdown` to fire on `SIGHUP` and `SIGTERM` in interactive, print, and RPC modes so extensions can run shutdown cleanup on those signal-driven exits ([#3212](https://github.com/badlogic/pi-mono/issues/3212))
- Fixed screenshot path parsing to handle lower case am/pm in macOS screenshot filenames ([#3194](https://github.com/badlogic/pi-mono/pull/3194) by [@jay-aye-see-kay](https://github.com/jay-aye-see-kay))
- Fixed interactive auto-retry status updates to show a live countdown during backoff instead of a static retry delay message ([#3187](https://github.com/badlogic/pi-mono/issues/3187))

## [0.67.2] - 2026-04-14

### New Features

- Support for multiple `--append-system-prompt` flags, each value is appended to the system prompt separated by double newlines. See [README.md#other-options](README.md#other-options).
- Support for passing inline extension factories to `main()` for embedded integrations and custom entrypoints.
- Interactive keybinding support for Kitty `super`-modified shortcuts such as `super+k`, `super+enter`, and `ctrl+super+k`. See [docs/keybindings.md](docs/keybindings.md).

### Added

- Added support for multiple `--append-system-prompt` flags, each value is appended to the system prompt separated by double newlines ([#3171](https://github.com/badlogic/pi-mono/pull/3171) by [@aliou](https://github.com/aliou))
- Added interactive keybinding support for Kitty `super`-modified shortcuts such as `super+k`, `super+enter`, and `ctrl+super+k` ([#3111](https://github.com/badlogic/pi-mono/pull/3111) by [@sudosubin](https://github.com/sudosubin))
- Added support for passing inline extension factories to `main()` for embedded integrations and custom entrypoints ([#3099](https://github.com/badlogic/pi-mono/pull/3099) by [@pmateusz](https://github.com/pmateusz))

### Fixed

- Fixed direct OpenAI Responses and Codex SSE requests to align `prompt_cache_key`, `session_id`, and `x-client-request-id` values with the same session-derived identifier, improving prompt cache affinity for append-only sessions ([#3018](https://github.com/badlogic/pi-mono/pull/3018) by [@steipete](https://github.com/steipete))
- Fixed streaming-only `partialJson` scratch buffers leaking into persisted OpenAI Responses tool calls, which could corrupt follow-up payloads on resumed conversations.
- Fixed Ctrl+Alt letter key matching in tmux by falling through from legacy ESC-prefixed handling to CSI-u and xterm `modifyOtherKeys` parsing when the legacy form does not match ([#2989](https://github.com/badlogic/pi-mono/pull/2989) by [@kaofelix](https://github.com/kaofelix))
- Fixed the shipped `subagent` example to avoid leaking Bun virtual filesystem script paths into subagent prompts ([#3002](https://github.com/badlogic/pi-mono/pull/3002) by [@nathyong](https://github.com/nathyong))
- Fixed bordered loaders to stop their animation timer when disposed, preventing stale loader updates after teardown.

## [0.67.1] - 2026-04-13

### Telemetry

Interactive mode now sends a lightweight anonymous install/update telemetry ping to `https://pi.dev/install?version=x.y.z` after it writes `lastChangelogVersion` in `settings.json`.

Why this exists:
- Pi needs a reliable per-version usage signal to understand whether releases are being adopted and to help justify funding continued development.
- npm download counts are not a reliable proxy for actual Pi usage.

How it works:
- It only runs in interactive mode.
- It does not run in RPC mode, print mode, JSON mode, or SDK mode.
- On a fresh interactive install, Pi writes `lastChangelogVersion`, then sends the ping.
- On later interactive startups, if the local changelog contains entries newer than the previously stored `lastChangelogVersion`, Pi writes the new `lastChangelogVersion`, then sends the ping.
- The request is fire-and-forget. Startup does not wait for it, and any errors are ignored.

What data is collected:
- Only the Pi version in the request path, for example `https://pi.dev/install?version=0.67.1`.
- The server stores only aggregate per-version counters such as `{ "0.67.1": 3 }`.
- It does not store IP addresses, client identifiers, prompts, paths, models, auth state, or any other per-user data. It literally only increments a counter for that version.

How to disable it:
- `/settings` → disable `Install telemetry`
- `settings.json` → set `enableInstallTelemetry` to `false`
- `PI_OFFLINE=1`
- `PI_TELEMETRY=0`

### New Features

- Full `openRouterRouting` support in `models.json`, including fallbacks, parameter requirements, data collection, ZDR, ignore lists, quantizations, provider sorting, max price, and preferred throughput and latency constraints. See [docs/models.md](docs/models.md).
- `PI_CODING_AGENT=true` environment variable set at startup so subprocesses can detect they are running inside the coding agent.
- Updated `antigravity-image-gen.ts` example extension to use User-Agent version `1.21.9` ([#2901](https://github.com/badlogic/pi-mono/pull/2901) by [@aadishv](https://github.com/aadishv))
- Fixed `--list-models` silently swallowing `models.json` load errors; errors are now printed to stderr ([#3072](https://github.com/badlogic/pi-mono/issues/3072))
- Fixed custom models for built-in providers (e.g. `openrouter`) being silently dropped from `--list-models` by inheriting `api`/`baseUrl` from built-in model definitions and no longer requiring `apiKey` for providers with existing auth ([#2921](https://github.com/badlogic/pi-mono/issues/2921) and [#3072](https://github.com/badlogic/pi-mono/issues/3072))
### Added

- Added full `openRouterRouting` field support in `models.json`, including fallbacks, parameter requirements, data collection, ZDR, ignore lists, quantizations, provider sorting, max price, and preferred throughput and latency constraints ([#2904](https://github.com/badlogic/pi-mono/pull/2904) by [@zmberber](https://github.com/zmberber))
- Set `PI_CODING_AGENT=true` environment variable at startup so sub-processes can detect they are running inside the coding agent ([#2868](https://github.com/badlogic/pi-mono/issues/2868))

### Fixed

- Fixed interactive changelog rendering for the telemetry notes by moving the section under a `### Telemetry` heading, so startup shows the full release notes instead of only the version header.
- Updated `antigravity-image-gen.ts` example extension to use User-Agent version `1.21.9` ([#2901](https://github.com/badlogic/pi-mono/pull/2901) by [@aadishv](https://github.com/aadishv))
- Bumped default Antigravity User-Agent version to `1.21.9` ([#2901](https://github.com/badlogic/pi-mono/pull/2901) by [@aadishv](https://github.com/aadishv))
- Fixed Gemma 4 thinking level mapping to route between `MINIMAL` and `HIGH`, and map Pi reasoning levels to the model's supported thinking levels ([#2903](https://github.com/badlogic/pi-mono/pull/2903) by [@aadishv](https://github.com/aadishv))
- Fixed Gemini 2.5 Flash Lite minimal thinking budget to use the model's supported 512-token minimum instead of the regular Flash 128-token minimum, avoiding invalid thinking budget errors ([#2861](https://github.com/badlogic/pi-mono/pull/2861) by [@JasonOA888](https://github.com/JasonOA888))
- Fixed OpenAI Codex Responses requests to forward configured `serviceTier` values, restoring service-tier selection for Codex sessions ([#2996](https://github.com/badlogic/pi-mono/pull/2996) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Fixed newly generated session IDs to use UUIDv7, improving time locality for session-based request routing ([#3018](https://github.com/badlogic/pi-mono/pull/3018) by [@steipete](https://github.com/steipete))
- Fixed `Container.render()` stack overflow on long sessions by replacing `Array.push(...spread)` with a loop-based push, preventing `RangeError: Maximum call stack size exceeded` when child output exceeds the V8 call stack argument limit ([#2651](https://github.com/badlogic/pi-mono/issues/2651))
- Fixed editor sticky-column tracking around paste markers so vertical cursor navigation restores the column from before the cursor entered a paste marker instead of jumping inside or past pasted content ([#3092](https://github.com/badlogic/pi-mono/pull/3092) by [@Perlence](https://github.com/Perlence))
- Fixed queued messages typed during `/tree` branch summarization to flush automatically after navigation completes, so they no longer remain stuck in the steering queue ([#3091](https://github.com/badlogic/pi-mono/pull/3091) by [@Perlence](https://github.com/Perlence))
- Fixed npm package update check to work with packages on non-default registries by using `npm view` instead of hardcoded `registry.npmjs.org` fetch ([#3164](https://github.com/badlogic/pi-mono/pull/3164) by [@aliou](https://github.com/aliou))

## [0.67.0] - 2026-04-13

See [0.67.1]. Version 0.67.0 shipped with a changelog formatting error that caused interactive startup to show only the version header instead of the full release notes.

## [0.66.1] - 2026-04-08

### Changed

- Changed the Earendil announcement from an automatic startup notice to the hidden `/dementedelves` slash command.

## [0.66.0] - 2026-04-08

### New Features

- Earendil startup announcement with bundled inline image rendering and a linked blog post for April 8 and 9, 2026.
- Interactive Anthropic subscription auth warning when Anthropic subscription auth is active, clarifying that Anthropic third-party usage draws from extra usage and is billed per token.

### Fixed

- Fixed bare `readline` import to use `node:readline` prefix for Deno compatibility ([#2885](https://github.com/badlogic/pi-mono/issues/2885) by [@milosv-vtool](https://github.com/milosv-vtool))
- Fixed auto-retry to treat stream failures like `request ended without sending any chunks` as transient errors ([#2892](https://github.com/badlogic/pi-mono/issues/2892))
- Fixed interactive startup notices to render after the initial resource listing, and added a bundled Earendil startup announcement with inline image rendering for April 8 and 9, 2026. Moved the blog link above the image to avoid overlap with terminal image rendering.
- Fixed interactive mode to warn when Anthropic subscription auth is active, so users know Anthropic third-party usage draws from extra usage and is billed per token.

## [0.65.2] - 2026-04-06

## [0.65.1] - 2026-04-05

### Fixed

- Fixed bash output truncation by line count to always persist full output to a temp file, preventing data loss when output exceeds 2000 lines but stays under the byte threshold ([#2852](https://github.com/badlogic/pi-mono/issues/2852))
- RpcClient now forwards subprocess stderr to parent process in real-time ([#2805](https://github.com/badlogic/pi-mono/issues/2805))
- Theme file watcher now handles async `fs.watch` error events instead of crashing the process ([#2791](https://github.com/badlogic/pi-mono/issues/2791))
- Fixed stored session cwd handling so resuming or importing a session whose original working directory no longer exists now prompts interactive users to continue in the current cwd, while non-interactive modes fail with a clear error.
- Fixed resource collision precedence so project and user skills, prompt templates, and themes override package resources consistently, and CLI-provided paths take precedence over discovered resources ([#2781](https://github.com/badlogic/pi-mono/issues/2781))
- Fixed OpenAI-compatible completions streaming usage accounting to preserve `prompt_tokens_details.cache_write_tokens` and normalize OpenRouter `cached_tokens`, preventing incorrect cache read/write token and cost reporting in pi ([#2802](https://github.com/badlogic/pi-mono/issues/2802))
- Fixed CLI extension paths like `git:gist.github.com/...` being incorrectly resolved against cwd instead of being passed through to the package manager ([#2845](https://github.com/badlogic/pi-mono/pull/2845) by [@aliou](https://github.com/aliou))
- Fixed piped stdin runs with `--mode json` to preserve JSONL output instead of falling back to plain text ([#2848](https://github.com/badlogic/pi-mono/pull/2848) by [@aliou](https://github.com/aliou))
- Fixed interactive command docs to stop listing removed `/exit` as a supported quit command ([#2850](https://github.com/badlogic/pi-mono/issues/2850))

## [0.65.0] - 2026-04-03

### New Features

- **Session runtime API**: `createAgentSessionRuntime()` and `AgentSessionRuntime` provide a closure-based runtime that recreates cwd-bound services and session config on every session switch. Startup, `/new`, `/resume`, `/fork`, and import all use the same creation path. See [docs/sdk.md](docs/sdk.md) and [examples/sdk/13-session-runtime.ts](examples/sdk/13-session-runtime.ts).
- **Label timestamps in `/tree`**: Toggle timestamps on tree entries with `Shift+T`, with smart date formatting and timestamp preservation through branching ([#2691](https://github.com/badlogic/pi-mono/pull/2691) by [@w-winter](https://github.com/w-winter))
- **`defineTool()` helper**: Create standalone custom tool definitions with full TypeScript parameter type inference, no manual casts needed ([#2746](https://github.com/badlogic/pi-mono/issues/2746)). See [docs/extensions.md](docs/extensions.md).
- **Unified diagnostics**: Arg parsing, service creation, session option resolution, and resource loading all return structured diagnostics (`info`/`warning`/`error`) instead of logging or exiting. The app layer decides presentation and exit behavior.

### Breaking Changes

- Removed extension post-transition events `session_switch` and `session_fork`. Use `session_start` with `event.reason` (`"startup" | "reload" | "new" | "resume" | "fork"`). For `"new"`, `"resume"`, and `"fork"`, `session_start` includes `previousSessionFile`.
- Removed session-replacement methods from `AgentSession`. Use `AgentSessionRuntime` for `newSession()`, `switchSession()`, `fork()`, and `importFromJsonl()`. Cross-cwd session replacement rebuilds all cwd-bound runtime state and replaces the live `AgentSession` instance.
- Removed `session_directory` from extension and settings APIs.
- Unknown single-dash CLI flags (e.g. `-s`) now produce an error instead of being silently ignored.

#### Migration: Extensions

Before:

```ts
pi.on("session_switch", async (event, ctx) => { ... });
pi.on("session_fork", async (_event, ctx) => { ... });
```

After:

```ts
pi.on("session_start", async (event, ctx) => {
  // event.reason: "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile: set for "new", "resume", "fork"
});
```

#### Migration: SDK session replacement

Before:

```ts
await session.newSession();
await session.switchSession("/path/to/session.jsonl");
```

After:

```ts
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runtime.newSession();
await runtime.switchSession("/path/to/session.jsonl");
await runtime.fork("entry-id");

// After replacement, runtime.session is the new live session.
// Rebind any session-local subscriptions or extension bindings.
```

### Added

- Added `createAgentSessionRuntime()` and `AgentSessionRuntime` for runtime-backed session replacement. The runtime takes a `CreateAgentSessionRuntimeFactory` closure that closes over process-global fixed inputs and recreates cwd-bound services and session config for each effective cwd. Startup and later `/new`, `/resume`, `/fork`, import all use the same factory.
- Added unified diagnostics model (`info`/`warning`/`error`) for arg parsing, service creation, session option resolution, and resource loading. Creation logic no longer logs or exits. The app layer decides presentation and exit behavior.
- Added error diagnostics for missing explicit CLI resource paths (`-e`, `--skill`, `--prompt-template`, `--theme`)

- Added `defineTool()` so standalone and array-based custom tool definitions keep inferred parameter types without manual casts ([#2746](https://github.com/badlogic/pi-mono/issues/2746))

- Added label timestamps to the session tree with a `Shift+T` toggle in `/tree`, smart date formatting, and timestamp preservation through branching ([#2691](https://github.com/badlogic/pi-mono/pull/2691) by [@w-winter](https://github.com/w-winter))

### Fixed

- Fixed startup resource loading to reuse the initial `ResourceLoader` for the first runtime, so extensions are not loaded twice before session startup and `session_start` handlers still fire for singleton-style extensions ([#2766](https://github.com/badlogic/pi-mono/issues/2766))
- Fixed retry settlement so retried agent runs wait for the full retry cycle to complete before declaring idle, preventing stale state after transient errors
- Fixed theme `export` colors to resolve theme variables the same way as `colors`, so `/export` HTML backgrounds now honor entries like `pageBg: "base"` instead of requiring inline hex values ([#2707](https://github.com/badlogic/pi-mono/issues/2707))
- Fixed Bedrock throttling errors being misidentified as context overflow, causing unnecessary compaction instead of retry ([#2699](https://github.com/badlogic/pi-mono/pull/2699) by [@xu0o0](https://github.com/xu0o0))
- Added tool streaming support for newer Z.ai models ([#2732](https://github.com/badlogic/pi-mono/pull/2732) by [@kaofelix](https://github.com/kaofelix))

## [0.64.0] - 2026-03-29

### New Features

- Extensions and SDK callers can attach a `prepareArguments` hook to any tool definition, letting them normalize or migrate raw model arguments before schema validation. The built-in `edit` tool uses this to transparently support sessions created with the old single-edit schema. See [docs/extensions.md](docs/extensions.md)
- Extensions can customize the collapsed thinking block label via `ctx.ui.setHiddenThinkingLabel()`. See [examples/extensions/hidden-thinking-label.ts](examples/extensions/hidden-thinking-label.ts) ([#2673](https://github.com/badlogic/pi-mono/issues/2673))

### Breaking Changes

- `ModelRegistry` no longer has a public constructor. SDK callers and tests must use `ModelRegistry.create(authStorage, modelsJsonPath?)` for file-backed registries or `ModelRegistry.inMemory(authStorage)` for built-in-only registries. Direct `new ModelRegistry(...)` calls no longer compile.

### Added

- Added `ToolDefinition.prepareArguments` hook to prepare raw tool call arguments before schema validation, enabling compatibility shims for resumed sessions with outdated tool schemas
- Built-in `edit` tool now uses `prepareArguments` to silently fold legacy top-level `oldText`/`newText` into `edits[]` when resuming old sessions
- Added `ctx.ui.setHiddenThinkingLabel()` so extensions can customize the collapsed thinking label in interactive mode, with a no-op in RPC mode and a runnable example extension in `examples/extensions/hidden-thinking-label.ts` ([#2673](https://github.com/badlogic/pi-mono/issues/2673))

### Fixed

- Fixed extension-queued user messages to refresh the interactive pending-message list so messages submitted while a turn is active are no longer silently dropped ([#2674](https://github.com/badlogic/pi-mono/pull/2674) by [@mrexodia](https://github.com/mrexodia))
- Fixed monorepo `tsconfig.json` path mappings to resolve `@mariozechner/pi-ai` subpath exports to source files in development checkouts ([#2625](https://github.com/badlogic/pi-mono/pull/2625) by [@ferologics](https://github.com/ferologics))
- Fixed TUI cell size response handling to consume only exact `CSI 6 ; height ; width t` replies, so bare `Escape` is no longer swallowed while waiting for terminal image metadata ([#2661](https://github.com/badlogic/pi-mono/issues/2661))
- Fixed Kitty keyboard protocol keypad functional keys to normalize to logical digits, symbols, and navigation keys, so numpad input in terminals such as iTerm2 no longer inserts Private Use Area gibberish or gets ignored ([#2650](https://github.com/badlogic/pi-mono/issues/2650))

## [0.63.2] - 2026-03-29

### New Features

- Extension handlers can now use `ctx.signal` to forward cancellation into nested model calls, `fetch()`, and other abort-aware work. See [docs/extensions.md#ctxsignal](docs/extensions.md#ctxsignal) ([#2660](https://github.com/badlogic/pi-mono/issues/2660))
- Built-in `edit` tool input now uses `edits[]` as the only replacement shape, reducing invalid tool calls caused by mixed single-edit and multi-edit schemas ([#2639](https://github.com/badlogic/pi-mono/issues/2639))
- Large multi-edit results no longer trigger full-screen redraws in the interactive TUI when the final diff is rendered ([#2664](https://github.com/badlogic/pi-mono/issues/2664))

### Added

- Added `ctx.signal` to `ExtensionContext` and wired it to the active agent turn so extension handlers can forward cancellation into nested model calls, `fetch()`, and other abort-aware work ([#2660](https://github.com/badlogic/pi-mono/issues/2660))

### Fixed

- Fixed built-in `edit` tool input to use `edits[]` as the only replacement shape, eliminating the mixed single-edit and multi-edit modes that caused repeated invalid tool calls and retries ([#2639](https://github.com/badlogic/pi-mono/issues/2639))
- Fixed edit tool TUI rendering to defer large multi-edit diffs to the settled result, avoiding full-screen redraws when the tool completes ([#2664](https://github.com/badlogic/pi-mono/issues/2664))

## [0.63.1] - 2026-03-27

### Added

- Added `gemini-3.1-pro-preview-customtools` model availability for the `google-vertex` provider ([#2610](https://github.com/badlogic/pi-mono/pull/2610) by [@gordonhwc](https://github.com/gordonhwc))

### Fixed

- Documented `tool_call` input mutation as supported extension API behavior, clarified that post-mutation inputs are not re-validated, and added regression coverage for executing mutated tool arguments ([#2611](https://github.com/badlogic/pi-mono/issues/2611))
- Fixed repeated compactions dropping messages that were kept by an earlier compaction by re-summarizing from the previous kept boundary and recalculating `tokensBefore` from the rebuilt session context ([#2608](https://github.com/badlogic/pi-mono/issues/2608))
- Fixed interactive compaction UI updates so `ctx.compact()` rebuilds the chat through unified compaction events, manual compaction no longer duplicates the summary block, and the `trigger-compact` example only fires when context usage crosses its threshold ([#2617](https://github.com/badlogic/pi-mono/issues/2617))
- Fixed interactive compaction completion to append a synthetic compaction summary after rebuilding the chat so the latest compaction remains visible at the bottom
- Fixed skill discovery to stop recursing once a directory contains `SKILL.md`, and to ignore root `*.md` files in `.agents/skills` while keeping root markdown skill files supported in `~/.pi/agent/skills`, `.pi/skills`, and package `skills/` directories ([#2603](https://github.com/badlogic/pi-mono/issues/2603))
- Fixed edit tool diff rendering for multi-edit operations with large unchanged gaps so distant edits collapse intermediate context instead of dumping the full unchanged middle block
- Fixed edit tool error rendering to avoid repeating the same exact-match failure in both the preview and result blocks
- Fixed auto-compaction overflow recovery for Ollama models when the backend returns explicit `prompt too long; exceeded max context length ...` errors instead of silently truncating input ([#2626](https://github.com/badlogic/pi-mono/issues/2626))
- Fixed built-in tool overrides that reuse built-in parameter schemas to still honor custom `renderCall` and `renderResult` renderers in the interactive TUI, restoring the `minimal-mode` example ([#2595](https://github.com/badlogic/pi-mono/issues/2595))

## [0.63.0] - 2026-03-27

### Breaking Changes

- `ModelRegistry.getApiKey(model)` has been replaced by `getApiKeyAndHeaders(model)` because `models.json` auth and header values can now resolve dynamically on every request. Extensions and SDK integrations that previously fetched only an API key must now fetch request auth per call and forward both `apiKey` and `headers`. Use `getApiKeyForProvider(provider)` only when you explicitly want provider-level API key lookup without model headers or `authHeader` handling ([#1835](https://github.com/badlogic/pi-mono/issues/1835))
- Removed deprecated direct `minimax` and `minimax-cn` model IDs, keeping only `MiniMax-M2.7` and `MiniMax-M2.7-highspeed`. Update pinned model IDs to one of those supported direct MiniMax models, or use another provider route that still exposes the older IDs ([#2596](https://github.com/badlogic/pi-mono/pull/2596) by [@liyuan97](https://github.com/liyuan97))

#### Migration Notes

Before:

```ts
const apiKey = await ctx.modelRegistry.getApiKey(model);
return streamSimple(model, messages, { apiKey });
```

After:

```ts
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
if (!auth.ok) throw new Error(auth.error);
return streamSimple(model, messages, {
  apiKey: auth.apiKey,
  headers: auth.headers,
});
```

### Added

- Added `sessionDir` setting support in global and project `settings.json` so session storage can be configured without passing `--session-dir` on every invocation ([#2598](https://github.com/badlogic/pi-mono/pull/2598) by [@smcllns](https://github.com/smcllns))
- Added a startup onboarding hint in the interactive header telling users pi can explain its own features and documentation ([#2620](https://github.com/badlogic/pi-mono/pull/2620) by [@ferologics](https://github.com/ferologics))
- Added `edit` tool multi-edit support so one call can update multiple separate, disjoint regions in the same file while matching all replacements against the original file content
- Added support for `PI_TUI_WRITE_LOG` directory paths, creating a unique log file (`tui-<timestamp>-<pid>.log`) per instance for easier debugging of multiple pi sessions ([#2508](https://github.com/badlogic/pi-mono/pull/2508) by [@mrexodia](https://github.com/mrexodia))

### Changed

### Fixed

- Fixed file mutation queue ordering so concurrent `edit` and `write` operations targeting the same file stay serialized in request order instead of being reordered during queue-key resolution
- Fixed `models.json` shell-command auth and headers to resolve at request time instead of being cached into long-lived model state. pi now leaves TTL, caching, and recovery policy to user-provided wrapper commands because arbitrary shell commands need provider-specific strategies ([#1835](https://github.com/badlogic/pi-mono/issues/1835))
- Fixed Google and Vertex cost calculation to subtract cached prompt tokens from billable input tokens instead of double-counting them when providers report `cachedContentTokenCount` ([#2588](https://github.com/badlogic/pi-mono/pull/2588) by [@sparkleMing](https://github.com/sparkleMing))
- Added missing `ajv` direct dependency; previously relied on transitive install via `@mariozechner/pi-ai` which broke standalone installs ([#2252](https://github.com/badlogic/pi-mono/issues/2252))
- Fixed `/export` HTML backgrounds to honor `theme.export.pageBg`, `cardBg`, and `infoBg` instead of always deriving them from `userMessageBg` ([#2565](https://github.com/badlogic/pi-mono/issues/2565))
- Fixed interactive bash execution collapsed previews to recompute visual line wrapping at render time, so previews respect the current terminal width after resizes and split-pane width changes ([#2569](https://github.com/badlogic/pi-mono/issues/2569))
- Fixed RPC `get_session_stats` to expose `contextUsage`, so headless clients can read actual current context-window usage instead of deriving it from token totals ([#2550](https://github.com/badlogic/pi-mono/issues/2550))
- Fixed `pi update` for git packages to fetch only the tracked target branch with `--no-tags`, reducing unrelated branch and tag noise while preserving force-push-safe updates ([#2548](https://github.com/badlogic/pi-mono/issues/2548))
- Fixed print and JSON modes to emit `session_shutdown` before exit, so extensions can release long-lived resources and non-interactive runs terminate cleanly ([#2576](https://github.com/badlogic/pi-mono/issues/2576))
- Fixed GitHub Copilot OpenAI Responses requests to omit the `reasoning` field entirely when no reasoning effort is requested, avoiding `400` errors from Copilot `gpt-5-mini` rejecting `reasoning: { effort: "none" }` during internal summary calls ([#2567](https://github.com/badlogic/pi-mono/issues/2567))
- Fixed blockquote text color breaking after inline links (and other inline elements) due to missing style restoration prefix
- Fixed slash-command Tab completion from immediately chaining into argument autocomplete after completing the command name, restoring flows like `/model` that submit into a selector dialog ([#2577](https://github.com/badlogic/pi-mono/issues/2577))
- Fixed stale content and incorrect viewport tracking after TUI content shrinks or transient components inflate the working area ([#2126](https://github.com/badlogic/pi-mono/pull/2126) by [@Perlence](https://github.com/Perlence))
- Fixed `@` autocomplete to debounce editor-triggered searches, cancel in-flight `fd` lookups cleanly, and keep suggestions visible while results refresh ([#1278](https://github.com/badlogic/pi-mono/issues/1278))

## [0.62.0] - 2026-03-23

### New Features

- Built-in tools as extensible ToolDefinitions. Extension authors can now override rendering of built-in read/write/edit/bash/grep/find/ls tools with custom `renderCall`/`renderResult` components. See [docs/extensions.md](docs/extensions.md).
- Unified source provenance via `sourceInfo`. All resources, commands, tools, skills, and prompt templates now carry structured `sourceInfo` with path, scope, and source metadata. Visible in autocomplete, RPC discovery, and SDK introspection. See [docs/extensions.md](docs/extensions.md).
- AWS Bedrock cost allocation tagging. New `requestMetadata` option on `BedrockOptions` forwards key-value pairs to the Bedrock Converse API for AWS Cost Explorer split cost allocation.

### Breaking Changes

- Changed `ToolDefinition.renderCall` and `renderResult` semantics. Fallback rendering now happens only when a renderer is not defined for that slot. If `renderCall` or `renderResult` is defined, it must return a `Component`.
- Changed slash command provenance to use `sourceInfo` consistently. RPC `get_commands`, `RpcSlashCommand`, and SDK `SlashCommandInfo` no longer expose `location` or `path`. Use `sourceInfo` instead ([#1734](https://github.com/badlogic/pi-mono/issues/1734))
- Removed legacy `source` fields from `Skill` and `PromptTemplate`. Use `sourceInfo.source` for provenance instead ([#1734](https://github.com/badlogic/pi-mono/issues/1734))
- Removed `ResourceLoader.getPathMetadata()`. Resource provenance is now attached directly to loaded resources via `sourceInfo` ([#1734](https://github.com/badlogic/pi-mono/issues/1734))
- Removed `extensionPath` from `RegisteredCommand` and `RegisteredTool`. Use `sourceInfo.path` for provenance instead ([#1734](https://github.com/badlogic/pi-mono/issues/1734))

#### Migration Notes

Resource, command, and tool provenance now use `sourceInfo` consistently.

Common updates:
- RPC `get_commands`: replace `path` and `location` with `sourceInfo.path`, `sourceInfo.scope`, and `sourceInfo.source`
- `SlashCommandInfo`: replace `command.path` and `command.location` with `command.sourceInfo`
- `Skill` and `PromptTemplate`: replace `.source` with `.sourceInfo.source`
- `RegisteredCommand` and `RegisteredTool`: replace `.extensionPath` with `.sourceInfo.path`
- Custom `ResourceLoader` implementations: remove `getPathMetadata()` and read provenance from loaded resources directly

Examples:
- `command.path` -> `command.sourceInfo.path`
- `command.location === "user"` -> `command.sourceInfo.scope === "user"`
- `skill.source` -> `skill.sourceInfo.source`
- `tool.extensionPath` -> `tool.sourceInfo.path`

### Changed

- Built-in tools now work like custom tools in extensions. To get built-in tool definitions, import `readToolDefinition` / `createReadToolDefinition()` and the equivalent `bash`, `edit`, `write`, `grep`, `find`, and `ls` exports from `@mariozechner/pi-coding-agent`.
- Cleaned up `buildSystemPrompt()` so built-in tool snippets and tool-local guidelines come from built-in `ToolDefinition` metadata, while cross-tool and global prompt rules stay in system prompt construction.
- Added structured `sourceInfo` to `pi.getAllTools()` results for built-in, SDK, and extension tools ([#1734](https://github.com/badlogic/pi-mono/issues/1734))

### Fixed

- Fixed extension command name conflicts so extensions with duplicate command names can load together. Conflicting extension commands now get numeric invocation suffixes in load order, for example `/review:1` and `/review:2` ([#1061](https://github.com/badlogic/pi-mono/issues/1061))
- Fixed slash command source attribution for extension commands, prompt templates, and skills in autocomplete and command discovery ([#1734](https://github.com/badlogic/pi-mono/issues/1734))
- Fixed auto-resized image handling to enforce the inline image size limit on the final base64 payload, return text-only fallbacks when resizing cannot produce a safe image, and avoid falling back to the original image in `read` and `@file` auto-resize paths ([#2055](https://github.com/badlogic/pi-mono/issues/2055))
- Fixed `pi update` for git packages to skip destructive reset, clean, and reinstall steps when the fetched target already matches the local checkout ([#2503](https://github.com/badlogic/pi-mono/issues/2503))
- Fixed print and JSON mode to take over stdout during non-interactive startup, keeping package-manager and other incidental chatter off protocol/output stdout ([#2482](https://github.com/badlogic/pi-mono/issues/2482))
- Fixed cli-highlight auto-detection for languageless code blocks that misidentified prose as programming languages and colored random English words as keywords
- Fixed Anthropic thinking disable handling to send `thinking: { type: "disabled" }` for reasoning-capable models when thinking is explicitly off ([#2022](https://github.com/badlogic/pi-mono/issues/2022))
- Fixed explicit thinking disable handling across Google, Google Vertex, Gemini CLI, OpenAI Responses, Azure OpenAI Responses, and OpenRouter-backed OpenAI-compatible completions ([#2490](https://github.com/badlogic/pi-mono/issues/2490))
- Fixed OpenAI Responses replay for foreign tool-call item IDs by hashing foreign IDs into bounded `fc_<hash>` IDs
- Fixed OpenAI-compatible completions streams to ignore null chunks instead of crashing ([#2466](https://github.com/badlogic/pi-mono/pull/2466) by [@Cheng-Zi-Qing](https://github.com/Cheng-Zi-Qing))
- Fixed `truncateToWidth()` performance for very large strings by streaming truncation ([#2447](https://github.com/badlogic/pi-mono/issues/2447))
- Fixed markdown heading styling being lost after inline code spans within headings

## [0.61.1] - 2026-03-20

### New Features

- Typed `tool_call` handler return values via `ToolCallEventResult` exports from the top-level package and core extension entry. See [docs/extensions.md](docs/extensions.md).
- Updated default models for `zai`, `cerebras`, `minimax`, and `minimax-cn`, and aligned MiniMax catalog coverage and limits with the current provider lineup. See [docs/models.md](docs/models.md) and [docs/providers.md](docs/providers.md).

### Added

- Added `ToolCallEventResult` to the `@mariozechner/pi-coding-agent` top-level and core extension exports so extension authors can type explicit `tool_call` handler return values ([#2458](https://github.com/badlogic/pi-mono/issues/2458))

### Changed

- Changed the default models for `zai`, `cerebras`, `minimax`, and `minimax-cn` to match the current provider lineup, and added missing `MiniMax-M2.1-highspeed` model entries with normalized MiniMax context limits ([#2445](https://github.com/badlogic/pi-mono/pull/2445) by [@1500256797](https://github.com/1500256797))

### Fixed

- Fixed `ctrl+z` suspend and `fg` resume reliability by keeping the process alive until the `SIGCONT` handler restores the TUI, avoiding immediate process exit in environments with no other live event-loop handles ([#2454](https://github.com/badlogic/pi-mono/issues/2454))
- Fixed `createAgentSession({ agentDir })` to derive the default persisted session path from the provided `agentDir`, keeping session storage aligned with settings, auth, models, and resource loading ([#2457](https://github.com/badlogic/pi-mono/issues/2457))
- Fixed shared keybinding resolution to stop user overrides from evicting unrelated default shortcuts such as selector confirm and editor cursor keys ([#2455](https://github.com/badlogic/pi-mono/issues/2455))
- Fixed Termux software keyboard height changes from forcing full-screen redraws and replaying TUI history on every toggle ([#2467](https://github.com/badlogic/pi-mono/issues/2467))
- Fixed project-local npm package updates to install npm `latest` instead of reusing stale saved dependency ranges, and added `Did you mean ...?` suggestions when `pi update <source>` omits the configured npm or git source prefix ([#2459](https://github.com/badlogic/pi-mono/issues/2459))

## [0.61.0] - 2026-03-20

### New Features

- Namespaced keybinding ids and a unified keybinding manager across the app and TUI. See [docs/keybindings.md](docs/keybindings.md) and [docs/extensions.md](docs/extensions.md).
- JSONL session export and import via `/export <path.jsonl>` and `/import <path.jsonl>`. See [README.md](README.md) and [docs/session.md](docs/session.md).
- Resizable sidebar in HTML share and export views. See [README.md](README.md).

### Breaking Changes

- Interactive keybinding ids are now namespaced, and `keybindings.json` now uses those same canonical namespaced ids. Older config files are migrated automatically on startup. Custom editors and extension UI components still receive an injected `keybindings: KeybindingsManager`. They do not call `getKeybindings()` or `setKeybindings()` themselves. Declaration merging applies to that injected type ([#2391](https://github.com/badlogic/pi-mono/issues/2391))
- Extension author migration: update `keyHint()`, `keyText()`, and injected `keybindings.matches(...)` calls from old built-in names like `"expandTools"`, `"selectConfirm"`, and `"interrupt"` to namespaced ids like `"app.tools.expand"`, `"tui.select.confirm"`, and `"app.interrupt"`. See [docs/keybindings.md](docs/keybindings.md) for the full list. `pi.registerShortcut("ctrl+shift+p", ...)` is unchanged because extension shortcuts still use raw key combos, not keybinding ids.

### Added

- Added `gpt-5.4-mini` to the `openai-codex` model catalog ([#2334](https://github.com/badlogic/pi-mono/pull/2334) by [@justram](https://github.com/justram))
- Added JSONL session export and import via `/export <path.jsonl>` and `/import <path.jsonl>` ([#2356](https://github.com/badlogic/pi-mono/pull/2356) by [@hjanuschka](https://github.com/hjanuschka))
- Added a resizable sidebar to HTML share and export views ([#2435](https://github.com/badlogic/pi-mono/pull/2435) by [@dmmulroy](https://github.com/dmmulroy))

### Fixed

- Tests for session-selector-rename and tree-selector are now keybinding-agnostic, resetting editor keybindings to defaults before each test so user `keybindings.json` cannot cause failures ([#2360](https://github.com/badlogic/pi-mono/issues/2360))
- Fixed custom `keybindings.json` overrides to shadow conflicting default shortcuts globally, so bindings such as `cursorUp: ["up", "ctrl+p"]` no longer leave default actions like model cycling active ([#2391](https://github.com/badlogic/pi-mono/issues/2391))
- Fixed concurrent `edit` and `write` mutations targeting the same file to run serially, preventing interleaved file writes from overwriting each other ([#2327](https://github.com/badlogic/pi-mono/issues/2327))
- Fixed RPC mode to redirect unexpected stdout writes to stderr so JSONL responses remain parseable ([#2388](https://github.com/badlogic/pi-mono/issues/2388))
- Fixed auto-retry with tool-using retry responses so `session.prompt()` waits for the full retry loop, including tool execution, before returning ([#2440](https://github.com/badlogic/pi-mono/pull/2440) by [@pasky](https://github.com/pasky))
- Fixed `/model` to refresh scoped model lists after `models.json` changes, avoiding stale selector contents ([#2408](https://github.com/badlogic/pi-mono/pull/2408) by [@Perlence](https://github.com/Perlence))
- Fixed `validateToolArguments()` to fall back gracefully when AJV schema compilation is blocked in restricted runtimes such as Cloudflare Workers, allowing tool execution to proceed without schema validation ([#2395](https://github.com/badlogic/pi-mono/issues/2395))
- Fixed CLI startup to suppress process warnings from leaking into terminal, print, and RPC output ([#2404](https://github.com/badlogic/pi-mono/issues/2404))
- Fixed bash tool rendering to show elapsed time at the bottom of the tool block ([#2406](https://github.com/badlogic/pi-mono/issues/2406))
- Fixed custom theme file watching to reload updated theme contents from disk instead of keeping stale cached theme data ([#2417](https://github.com/badlogic/pi-mono/issues/2417), [#2003](https://github.com/badlogic/pi-mono/issues/2003))
- Fixed footer Git branch refreshes to run asynchronously so branch watcher updates do not block the UI ([#2418](https://github.com/badlogic/pi-mono/issues/2418))
- Fixed invalid extension provider registrations to surface an extension error without preventing other providers from loading ([#2431](https://github.com/badlogic/pi-mono/issues/2431))
- Fixed Windows bash execution hanging for commands that spawn detached descendants inheriting stdout/stderr handles, which caused `agent-browser` and similar commands to spin forever ([#2389](https://github.com/badlogic/pi-mono/pull/2389) by [@mrexodia](https://github.com/mrexodia))
- Fixed `google-vertex` API key resolution to ignore placeholder auth markers like `<authenticated>` and fall back to ADC instead of sending them as literal API keys ([#2335](https://github.com/badlogic/pi-mono/issues/2335))
- Fixed desktop clipboard text copy to prefer native OS clipboard integration before shell fallbacks, improving reliability on macOS and Windows ([#2347](https://github.com/badlogic/pi-mono/issues/2347))
- Fixed Bun Bedrock provider registration to survive provider resets and session reloads in compiled binaries ([#2350](https://github.com/badlogic/pi-mono/pull/2350) by [@unexge](https://github.com/unexge))
- Fixed OpenRouter reasoning requests to use the provider's nested reasoning payload, restoring thinking level support for OpenRouter models and custom compat settings ([#2298](https://github.com/badlogic/pi-mono/pull/2298) by [@PriNova](https://github.com/PriNova))
- Fixed Bedrock application inference profiles to support prompt caching when `AWS_BEDROCK_FORCE_CACHE=1` is set, covering profile ARNs that do not expose the underlying Claude model name ([#2346](https://github.com/badlogic/pi-mono/pull/2346) by [@haoqixu](https://github.com/haoqixu))

## [0.60.0] - 2026-03-18

### New Features

- Fork existing sessions directly from the CLI with `--fork <path|id>`, which copies a source session into a new session in the current project. See [README.md](README.md).
- Extensions and SDK callers can reuse pi's built-in local bash backend via `createLocalBashOperations()` for `user_bash` interception and custom bash integrations. See [docs/extensions.md#user_bash](docs/extensions.md#user_bash).
- Startup no longer updates unpinned npm and git packages automatically. Use `pi update` explicitly, while interactive mode checks for updates in the background and notifies you when newer packages are available. See [README.md](README.md).

### Breaking Changes

- Changed package startup behavior so installed unpinned packages are no longer checked or updated during startup. Use `pi update` to apply npm/git package updates, while interactive mode now checks for available package updates in the background and notifies you when updates are available ([#1963](https://github.com/badlogic/pi-mono/issues/1963))

### Added

- Added `--fork <path|id>` CLI flag to fork an existing session file or partial session UUID directly into a new session ([#2290](https://github.com/badlogic/pi-mono/issues/2290))
- Added `createLocalBashOperations()` export so extensions and SDK callers can wrap pi's built-in local bash backend for `user_bash` handling and other custom bash integrations ([#2299](https://github.com/badlogic/pi-mono/issues/2299))

### Fixed

- Fixed active model selection to refresh immediately after dynamic provider registrations or updates change the available model set ([#2291](https://github.com/badlogic/pi-mono/issues/2291))
- Fixed tmux xterm `modifyOtherKeys` matching for `Backspace`, `Escape`, and `Space`, and resolved raw `\x08` backspace ambiguity by treating Windows Terminal sessions differently from legacy terminals ([#2293](https://github.com/badlogic/pi-mono/issues/2293))
- Fixed Gemini 3 and Antigravity image tool results to stay inline as multimodal tool responses instead of being rerouted through separate follow-up messages ([#2052](https://github.com/badlogic/pi-mono/issues/2052))
- Fixed bundled Bedrock Claude 4.6 model metadata to use the correct 200K context window instead of 1M ([#2305](https://github.com/badlogic/pi-mono/issues/2305))
- Fixed `/reload` to reload keybindings from disk so changes in `keybindings.json` apply immediately ([#2309](https://github.com/badlogic/pi-mono/issues/2309))
- Fixed lazy built-in provider registration so compiled Bun binaries can still load providers on first use without eagerly bundling provider SDKs ([#2314](https://github.com/badlogic/pi-mono/issues/2314))
- Fixed built-in OAuth login flows to use aligned callback handling across Anthropic, Gemini CLI, Antigravity, and OpenAI Codex, and fixed OpenAI Codex login to complete immediately once the browser callback succeeds ([#2316](https://github.com/badlogic/pi-mono/issues/2316))
- Fixed OpenAI-compatible z.ai `network_error` responses to trigger error handling and retries instead of being treated as successful assistant output ([#2313](https://github.com/badlogic/pi-mono/issues/2313))
- Fixed print mode to merge piped stdin into the initial prompt when both stdin and an explicit prompt are provided ([#2315](https://github.com/badlogic/pi-mono/issues/2315))
- Fixed OpenAI Responses replay in coding-agent to normalize oversized resumed tool call IDs before sending them back to OpenAI Codex and other Responses-compatible targets ([#2328](https://github.com/badlogic/pi-mono/issues/2328))
- Fixed tmux extended-keys warning to stay hidden when the tmux server is unreachable, avoiding false startup warnings in sandboxed environments ([#2311](https://github.com/badlogic/pi-mono/pull/2311) by [@kaffarell](https://github.com/kaffarell))

## [0.59.0] - 2026-03-17

### New Features

- Faster startup by lazy-loading `@mariozechner/pi-ai` provider SDKs on first use instead of import time ([#2297](https://github.com/badlogic/pi-mono/issues/2297))
- Better provider retry behavior when providers return error messages as responses ([#2264](https://github.com/badlogic/pi-mono/issues/2264))
- Better terminal integration via OSC 133 command-executed markers ([#2242](https://github.com/badlogic/pi-mono/issues/2242))
- Better Git footer branch detection for repositories using reftable storage ([#2300](https://github.com/badlogic/pi-mono/issues/2300))

### Breaking Changes

- Changed custom tool system prompt behavior so extension and SDK tools are included in the default `Available tools` section only when they provide `promptSnippet`. Omitting `promptSnippet` now leaves the tool out of that section instead of falling back to `description` ([#2285](https://github.com/badlogic/pi-mono/issues/2285))

### Changed

- Lazy-load built-in `@mariozechner/pi-ai` provider modules and root provider wrappers so coding-agent startup no longer eagerly loads provider SDKs before first use ([#2297](https://github.com/badlogic/pi-mono/issues/2297))

### Fixed

- Fixed session title handling in `/tree`, compaction, and branch summarization so empty title clears render correctly and `session_info` entries stay out of summaries ([#2304](https://github.com/badlogic/pi-mono/pull/2304) by [@aliou](https://github.com/aliou))
- Fixed footer branch detection for Git repositories using reftable storage so branch names still appear correctly in the footer ([#2300](https://github.com/badlogic/pi-mono/issues/2300))
- Fixed rendered user messages to emit an OSC 133 command-executed marker after command output, improving terminal prompt integration ([#2242](https://github.com/badlogic/pi-mono/issues/2242))
- Fixed provider retry handling to treat provider-returned error messages as retryable failures instead of successful responses ([#2264](https://github.com/badlogic/pi-mono/issues/2264))
- Fixed Claude 4.6 context window overrides in bundled model metadata so coding-agent sees the intended model limits after generated catalogs are rebuilt ([#2286](https://github.com/badlogic/pi-mono/issues/2286))

## [0.58.4] - 2026-03-16

### Fixed

- Fixed steering messages to wait until the current assistant message's tool-call batch fully finishes instead of skipping pending tool calls.

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

### Added

- Improved settings, theme, thinking, and show-images selector layouts by using configurable select-list primary column sizing ([#2154](https://github.com/badlogic/pi-mono/pull/2154) by [@markusylisiurunen](https://github.com/markusylisiurunen))

### Fixed

- Fixed fuzzy `edit` matching to normalize Unicode compatibility variants before comparison, reducing false "oldText not found" failures for text such as CJK and full-width characters ([#2044](https://github.com/badlogic/pi-mono/issues/2044))
- Fixed `/model <ref>` exact matching and picker search to recognize canonical `provider/model` references when model IDs themselves contain `/`, such as LM Studio models like `unsloth/qwen3.5-35b-a3b` ([#2174](https://github.com/badlogic/pi-mono/issues/2174))
- Fixed Anthropic OAuth manual login and token refresh by using the localhost callback URI for pasted redirect/code flows and omitting `scope` from refresh-token requests ([#2169](https://github.com/badlogic/pi-mono/issues/2169))
- Fixed stale scrollback remaining after session switches by clearing the screen before wiping scrollback ([#2155](https://github.com/badlogic/pi-mono/pull/2155) by [@Perlence](https://github.com/Perlence))
- Fixed extra blank lines after markdown block elements in rendered output ([#2152](https://github.com/badlogic/pi-mono/pull/2152) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.58.1] - 2026-03-14

### Added

- Added `pi uninstall` alias for `pi install --uninstall` convenience

### Fixed

- Fixed OpenAI Codex websocket protocol to include required headers and properly terminate SSE streams on connection close ([#1961](https://github.com/badlogic/pi-mono/issues/1961))
- Fixed WSL clipboard image fallback to properly handle missing clipboard utilities and permission errors ([#1722](https://github.com/badlogic/pi-mono/issues/1722))
- Fixed extension `session_start` hook firing before TUI was ready, causing UI operations in `session_start` handlers to fail ([#2035](https://github.com/badlogic/pi-mono/issues/2035))
- Fixed Windows shell and path handling for package manager operations and autocomplete to properly handle drive letters and mixed path separators
- Fixed Bedrock prompt caching being enabled for non-Claude models, causing API errors ([#2053](https://github.com/badlogic/pi-mono/issues/2053))
- Fixed Qwen models via OpenAI-compatible providers by adding `qwen-chat-template` compat mode that uses Qwen's native chat template format ([#2020](https://github.com/badlogic/pi-mono/issues/2020))
- Fixed Bedrock unsigned thinking replay to handle edge cases with empty or malformed thinking blocks ([#2063](https://github.com/badlogic/pi-mono/issues/2063))
- Fixed headless clipboard fallback logging spurious errors in non-interactive environments ([#2056](https://github.com/badlogic/pi-mono/issues/2056))
- Fixed `models.json` provider compat flags not being honored when loading custom model definitions ([#2062](https://github.com/badlogic/pi-mono/issues/2062))
- Fixed xhigh reasoning effort detection for Claude Opus 4.6 to match by model ID instead of requiring explicit capability flag ([#2040](https://github.com/badlogic/pi-mono/issues/2040))
- Fixed prompt cwd containing Windows backslashes breaking bash tool execution by normalizing to forward slashes ([#2080](https://github.com/badlogic/pi-mono/issues/2080))
- Fixed editor paste to preserve literal content instead of normalizing newlines, preventing content corruption for text with embedded escape sequences ([#2064](https://github.com/badlogic/pi-mono/issues/2064))
- Fixed skill discovery recursing past skill root directories when nested SKILL.md files exist ([#2075](https://github.com/badlogic/pi-mono/issues/2075))
- Fixed tab completion to preserve `./` prefix when completing relative paths ([#2087](https://github.com/badlogic/pi-mono/issues/2087))
- Fixed npm package installs and lookups being tied to the active repository Node version by adding `npmCommand` as an argv-style settings override for package manager operations ([#2072](https://github.com/badlogic/pi-mono/issues/2072))
- Fixed `ctx.ui.getEditorText()` in the extension API returning paste markers (e.g., `[paste #1 +24 lines]`) instead of the actual pasted content ([#2084](https://github.com/badlogic/pi-mono/issues/2084))
- Fixed startup crash when downloading `fd`/`ripgrep` on first run by using `pipeline()` instead of `finished(readable.pipe(writable))` so stream errors from timeouts are caught properly, and increased the download timeout from 10s to 120s ([#2066](https://github.com/badlogic/pi-mono/issues/2066))

## [0.58.0] - 2026-03-14

### New Features

- Claude Opus 4.6, Sonnet 4.6, and related Bedrock models now use a 1M token context window (up from 200K) ([#2135](https://github.com/badlogic/pi-mono/pull/2135) by [@mitsuhiko](https://github.com/mitsuhiko)).
- Extension tool calls now execute in parallel by default, with sequential `tool_call` preflight preserved for extension interception.
- `GOOGLE_CLOUD_API_KEY` environment variable support for the `google-vertex` provider as an alternative to Application Default Credentials ([#1976](https://github.com/badlogic/pi-mono/pull/1976) by [@gordonhwc](https://github.com/gordonhwc)).
- Extensions can supply deterministic session IDs via `newSession()` ([#2130](https://github.com/badlogic/pi-mono/pull/2130) by [@zhahaoyu](https://github.com/zhahaoyu)).

### Added

- Added `GOOGLE_CLOUD_API_KEY` environment variable support for the `google-vertex` provider as an alternative to Application Default Credentials ([#1976](https://github.com/badlogic/pi-mono/pull/1976) by [@gordonhwc](https://github.com/gordonhwc))
- Added custom session ID support in `newSession()` for extensions that need deterministic session paths ([#2130](https://github.com/badlogic/pi-mono/pull/2130) by [@zhahaoyu](https://github.com/zhahaoyu))

### Changed

- Changed extension tool interception to use agent-core `beforeToolCall` and `afterToolCall` hooks instead of wrapper-based interception. Tool calls now execute in parallel by default, extension `tool_call` preflight still runs sequentially, and final tool results are emitted in assistant source order.
- Raised Claude Opus 4.6, Sonnet 4.6, and related Bedrock model context windows from 200K to 1M tokens ([#2135](https://github.com/badlogic/pi-mono/pull/2135) by [@mitsuhiko](https://github.com/mitsuhiko))

### Fixed

- Fixed `tool_call` extension handlers observing stale `sessionManager` state during multi-tool turns by draining queued agent events before each `tool_call` preflight. In parallel tool mode this guarantees state through the current assistant tool-calling message, but not sibling tool results from the same assistant message.
- Fixed interactive input fields backed by the TUI `Input` component to scroll by visual column width for wide Unicode text (CJK, fullwidth characters), preventing rendered line overflow and TUI crashes in places like search and filter inputs ([#1982](https://github.com/badlogic/pi-mono/issues/1982))
- Fixed `shift+tab` and other modified Tab bindings in tmux when `extended-keys-format` is left at the default `xterm`
- Fixed EXIF orientation not being applied during image convert and resize, causing JPEG and WebP images from phone cameras to display rotated or mirrored ([#2105](https://github.com/badlogic/pi-mono/pull/2105) by [@melihmucuk](https://github.com/melihmucuk))
- Fixed the default coding-agent system prompt to include only the current date in ISO format, not the current time, so prompt prefixes stay cacheable across reloads and resumed sessions ([#2131](https://github.com/badlogic/pi-mono/issues/2131))
- Fixed retry regex to match `server_error` and `internal_error` error types from providers, improving automatic retry coverage ([#2117](https://github.com/badlogic/pi-mono/pull/2117) by [@MadKangYu](https://github.com/MadKangYu))
- Fixed example extensions to support `PI_CODING_AGENT_DIR` environment variable for custom agent directory paths ([#2009](https://github.com/badlogic/pi-mono/pull/2009) by [@smithbm2316](https://github.com/smithbm2316))
- Fixed tool result images not being sent in `function_call_output` items for OpenAI Responses API providers, causing image data to be silently dropped in tool results ([#2104](https://github.com/badlogic/pi-mono/issues/2104))
- Fixed assistant content being sent as structured content blocks instead of plain strings in the `openai-completions` provider, causing errors with some OpenAI-compatible backends ([#2008](https://github.com/badlogic/pi-mono/pull/2008) by [@geraldoaax](https://github.com/geraldoaax))
- Fixed error details in OpenAI Responses `response.failed` handler to include status code, error code, and message instead of a generic failure ([#1956](https://github.com/badlogic/pi-mono/pull/1956) by [@drewburr](https://github.com/drewburr))
- Fixed GitHub Copilot device-code login polling to respect OAuth slow-down intervals, wait before the first token poll, and include a clearer clock-drift hint in WSL/VM environments when repeated slow-downs lead to timeout
- Fixed usage statistics not being captured for OpenAI-compatible providers that return usage in `choice.usage` instead of the standard `chunk.usage` (e.g., Moonshot/Kimi) ([#2017](https://github.com/badlogic/pi-mono/issues/2017))
- Fixed editor scroll indicator rendering crash in narrow terminal widths ([#2103](https://github.com/badlogic/pi-mono/pull/2103) by [@haoqixu](https://github.com/haoqixu))
- Fixed tab characters in editor and input paste not being normalized to spaces ([#2027](https://github.com/badlogic/pi-mono/pull/2027), [#1975](https://github.com/badlogic/pi-mono/pull/1975) by [@haoqixu](https://github.com/haoqixu))
- Fixed `wordWrapLine` overflow when wide characters (CJK, fullwidth) fall exactly at the wrap boundary ([#2082](https://github.com/badlogic/pi-mono/pull/2082) by [@haoqixu](https://github.com/haoqixu))
- Fixed paste markers not being treated as atomic segments in editor word wrapping and cursor navigation ([#2111](https://github.com/badlogic/pi-mono/pull/2111) by [@haoqixu](https://github.com/haoqixu))

## [0.57.1] - 2026-03-07

### New Features
- Tree branch folding and segment-jump navigation in `/tree`, with `Ctrl+←`/`Ctrl+→` and `Alt+←`/`Alt+→` shortcuts while `←`/`→` and `Page Up`/`Page Down` remain available for paging. See [docs/tree.md](docs/tree.md) and [docs/keybindings.md](docs/keybindings.md).
- `session_directory` extension event for customizing session directory paths before session manager creation. See [docs/extensions.md](docs/extensions.md).
- Digit keybindings (`0-9`) in the TUI keybinding system, including modified combos like `ctrl+1`. See [docs/keybindings.md](docs/keybindings.md).

### Added
- Added `/tree` branch folding and segment-jump navigation with `Ctrl+←`/`Ctrl+→` and `Alt+←`/`Alt+→`, while keeping `←`/`→` and `Page Up`/`Page Down` for paging ([#1724](https://github.com/badlogic/pi-mono/pull/1724) by [@Perlence](https://github.com/Perlence))
- Added `session_directory` extension event that fires before session manager creation, allowing extensions to customize the session directory path based on cwd and other factors. CLI `--session-dir` flag takes precedence over extension-provided paths ([#1730](https://github.com/badlogic/pi-mono/pull/1730) by [@hjanuschka](https://github.com/hjanuschka)).
- Added digit keys (`0-9`) to the keybinding system, including Kitty CSI-u and xterm `modifyOtherKeys` support for bindings like `ctrl+1` ([#1905](https://github.com/badlogic/pi-mono/issues/1905))

### Fixed
- Fixed custom tool collapsed/expanded rendering in HTML exports. Custom tools that define different collapsed vs expanded displays now render correctly in exported HTML, with expandable sections when both states differ and direct display when only expanded exists ([#1934](https://github.com/badlogic/pi-mono/pull/1934) by [@aliou](https://github.com/aliou))
- Fixed tmux startup guidance and keyboard setup warnings for modified key handling, including Ghostty `shift+enter=text:\n` remap guidance and tmux `extended-keys-format` detection ([#1872](https://github.com/badlogic/pi-mono/issues/1872))
- Fixed z.ai context overflow recovery so `model_context_window_exceeded` errors trigger auto-compaction instead of surfacing as unhandled stop reason failures ([#1937](https://github.com/badlogic/pi-mono/issues/1937))
- Fixed autocomplete selection ignoring typed text: highlight now follows the first prefix match as the user types, and exact matches are always selected on Enter ([#1931](https://github.com/badlogic/pi-mono/pull/1931) by [@aliou](https://github.com/aliou))
- Fixed slash-command Tab completion to immediately open argument completions when available ([#1481](https://github.com/badlogic/pi-mono/pull/1481) by [@barapa](https://github.com/barapa))
- Fixed explicit `pi -e <path>` extensions losing command and tool conflicts to discovered extensions by giving CLI-loaded extensions higher precedence ([#1896](https://github.com/badlogic/pi-mono/issues/1896))
- Fixed Windows external editor launch for `Ctrl+G` and `ctx.ui.editor()` so shell-based commands like `EDITOR="code --wait"` work correctly ([#1925](https://github.com/badlogic/pi-mono/issues/1925))

## [0.57.0] - 2026-03-07

### New Features

- Extensions can intercept and modify provider request payloads via `before_provider_request`. See [docs/extensions.md#before_provider_request](docs/extensions.md#before_provider_request).
- Extension UIs can use non-capturing overlays with explicit focus control via `OverlayOptions.nonCapturing` and `OverlayHandle.focus()` / `unfocus()` / `isFocused()`. See [docs/extensions.md](docs/extensions.md) and [../tui/README.md](../tui/README.md).
- RPC mode now uses strict LF-only JSONL framing for robust payload handling. See [docs/rpc.md](docs/rpc.md).

### Breaking Changes

- RPC mode now uses strict LF-delimited JSONL framing. Clients must split records on `\n` only instead of using generic line readers such as Node `readline`, which also split on Unicode separators inside JSON payloads ([#1911](https://github.com/badlogic/pi-mono/issues/1911))

### Added

- Added `before_provider_request` extension hook so extensions can inspect or replace provider payloads before requests are sent, with an example in `examples/extensions/provider-payload.ts`
- Added non-capturing overlay focus control for extension UIs via `OverlayOptions.nonCapturing` and `OverlayHandle.focus()` / `unfocus()` / `isFocused()` ([#1916](https://github.com/badlogic/pi-mono/pull/1916) by [@nicobailon](https://github.com/nicobailon))

### Changed

- Overlay compositing in extension UIs now uses focus order so focused overlays render on top while preserving stack semantics for show/hide behavior ([#1916](https://github.com/badlogic/pi-mono/pull/1916) by [@nicobailon](https://github.com/nicobailon))

### Fixed

- Fixed RPC mode stdin/stdout framing to use strict LF-delimited JSONL instead of `readline`, so payloads containing `U+2028` or `U+2029` no longer corrupt command or event streams ([#1911](https://github.com/badlogic/pi-mono/issues/1911))
- Fixed automatic overlay focus restoration in extension UIs to skip non-capturing overlays, and fixed overlay hide behavior to only reassign focus when the hidden overlay had focus ([#1916](https://github.com/badlogic/pi-mono/pull/1916) by [@nicobailon](https://github.com/nicobailon))
- Fixed `pi config` misclassifying `~/.agents/skills` as project-scoped in non-git directories under `$HOME`, so toggling those skills no longer writes project overrides to `.pi/settings.json` ([#1915](https://github.com/badlogic/pi-mono/issues/1915))

## [0.56.3] - 2026-03-06

### New Features

- `claude-sonnet-4-6` model available via the `google-antigravity` provider ([#1859](https://github.com/badlogic/pi-mono/issues/1859))
- Custom editors can now define their own `onEscape`/`onCtrlD` handlers without being overwritten by app defaults, enabling vim-mode extensions ([#1838](https://github.com/badlogic/pi-mono/issues/1838))
- Shift+Enter and Ctrl+Enter now work inside tmux via xterm modifyOtherKeys fallback ([docs/tmux.md](docs/tmux.md), [#1872](https://github.com/badlogic/pi-mono/issues/1872))
- Auto-compaction is now resilient to persistent API errors (e.g. 529 overloaded) and no longer retriggers spuriously after compaction ([#1834](https://github.com/badlogic/pi-mono/issues/1834), [#1860](https://github.com/badlogic/pi-mono/issues/1860))

### Added

- Added `claude-sonnet-4-6` model for the `google-antigravity` provider ([#1859](https://github.com/badlogic/pi-mono/issues/1859)).
- Added [tmux setup documentation](docs/tmux.md) for modified enter key support ([#1872](https://github.com/badlogic/pi-mono/issues/1872))

### Fixed

- Fixed custom editors having their `onEscape`/`onCtrlD` handlers unconditionally overwritten by app-level defaults, making vim-style escape handling impossible ([#1838](https://github.com/badlogic/pi-mono/issues/1838))
- Fixed auto-compaction retriggering on the first prompt after compaction due to stale pre-compaction assistant usage ([#1860](https://github.com/badlogic/pi-mono/issues/1860) by [@joelhooks](https://github.com/joelhooks))
- Fixed sessions never auto-compacting when hitting persistent API errors (e.g. 529 overloaded) by estimating context size from the last successful response ([#1834](https://github.com/badlogic/pi-mono/issues/1834))
- Fixed compaction summarization requests exceeding context limits by truncating tool results to 2k chars ([#1796](https://github.com/badlogic/pi-mono/issues/1796))
- Fixed `/new` leaving startup header content, including the changelog, visible after starting a fresh session ([#1880](https://github.com/badlogic/pi-mono/issues/1880))
- Fixed misleading docs and example implying that returning `{ isError: true }` from a tool's `execute` function marks the execution as failed; errors must be signaled by throwing ([#1881](https://github.com/badlogic/pi-mono/issues/1881))
- Fixed model switches through non-reasoning models to preserve the saved default thinking level instead of persisting a capability-forced `off` clamp ([#1864](https://github.com/badlogic/pi-mono/issues/1864))
- Fixed parallel pi processes failing with false "No API key found" errors due to immediate lockfile contention on `auth.json` and `settings.json` ([#1871](https://github.com/badlogic/pi-mono/issues/1871))
- Fixed OpenAI Responses reasoning replay regression that broke multi-turn reasoning continuity ([#1878](https://github.com/badlogic/pi-mono/issues/1878))

## [0.56.2] - 2026-03-05

### New Features

- GPT-5.4 support across `openai`, `openai-codex`, `azure-openai-responses`, and `opencode`, with `gpt-5.4` now the default for `openai` and `openai-codex` ([README.md](README.md), [docs/providers.md](docs/providers.md)).
- `treeFilterMode` setting to choose the default `/tree` filter mode (`default`, `no-tools`, `user-only`, `labeled-only`, `all`) ([docs/settings.md](docs/settings.md), [#1852](https://github.com/badlogic/pi-mono/pull/1852) by [@lajarre](https://github.com/lajarre)).
- Mistral native conversations integration with SDK-backed provider behavior, preserving Mistral-specific thinking and replay semantics ([README.md](README.md), [docs/providers.md](docs/providers.md), [#1716](https://github.com/badlogic/pi-mono/issues/1716)).

### Added

- Added `gpt-5.4` model availability for `openai`, `openai-codex`, `azure-openai-responses`, and `opencode` providers.
- Added `gpt-5.3-codex` fallback model availability for `github-copilot` until upstream model catalogs include it ([#1853](https://github.com/badlogic/pi-mono/issues/1853)).
- Added `treeFilterMode` setting to choose the default `/tree` filter mode (`default`, `no-tools`, `user-only`, `labeled-only`, `all`) ([#1852](https://github.com/badlogic/pi-mono/pull/1852) by [@lajarre](https://github.com/lajarre)).

### Changed

- Updated the default models for the `openai` and `openai-codex` providers to `gpt-5.4`.

### Fixed

- Fixed GPT-5.3 Codex follow-up turns dropping OpenAI Responses assistant `phase` metadata by preserving replayable signatures in session history and forwarding `phase` back to the Responses API ([#1819](https://github.com/badlogic/pi-mono/issues/1819)).
- Fixed OpenAI Responses replay to omit empty thinking blocks, avoiding invalid no-op reasoning items in follow-up turns.
- Updated Mistral integration to use the native SDK-backed provider and conversations API, including coding-agent model/provider wiring and Mistral setup documentation ([#1716](https://github.com/badlogic/pi-mono/issues/1716)).
- Fixed Antigravity reliability: endpoint cascade on 403/404, added autopush sandbox fallback, removed extra fingerprint headers ([#1830](https://github.com/badlogic/pi-mono/issues/1830)).
- Fixed `@mariozechner/pi-ai/oauth` extension imports in published installs by resolving the subpath directly from built `dist` files instead of package-root wrapper shims ([#1856](https://github.com/badlogic/pi-mono/issues/1856)).
- Fixed Gemini 3 multi-turn tool use losing structured context by using `skip_thought_signature_validator` sentinel for unsigned function calls instead of text fallback ([#1829](https://github.com/badlogic/pi-mono/issues/1829)).
- Fixed model selector filter not accepting typed characters in VS Code 1.110+ due to missing Kitty CSI-u printable decoding in the `Input` component ([#1857](https://github.com/badlogic/pi-mono/issues/1857))
- Fixed editor/footer visibility drift during terminal resize by forcing full redraws when terminal width or height changes ([#1844](https://github.com/badlogic/pi-mono/pull/1844) by [@ghoulr](https://github.com/ghoulr)).
- Fixed footer width truncation for wide Unicode text (session name, model, provider) to prevent TUI crashes from rendered lines exceeding terminal width ([#1833](https://github.com/badlogic/pi-mono/issues/1833)).
- Fixed Windows write preview background artifacts by normalizing CRLF content (`\r\n`) to LF for display rendering in tool output previews ([#1854](https://github.com/badlogic/pi-mono/issues/1854)).

## [0.56.1] - 2026-03-05

### Fixed

- Fixed extension alias fallback resolution to use ESM-aware resolution for `jiti` aliases in global installs ([#1821](https://github.com/badlogic/pi-mono/pull/1821) by [@Perlence](https://github.com/Perlence))
- Fixed markdown blockquote rendering to isolate blockquote styling from default text style, preventing style leakage.

## [0.56.0] - 2026-03-04

### New Features

- Added OpenCode Go provider support with `opencode-go` model defaults and `OPENCODE_API_KEY` environment variable support ([docs/providers.md](docs/providers.md), [#1757](https://github.com/badlogic/pi-mono/issues/1757)).
- Added `branchSummary.skipPrompt` setting to skip branch summarization prompts during tree navigation ([docs/settings.md](docs/settings.md), [#1792](https://github.com/badlogic/pi-mono/issues/1792)).
- Added `gemini-3.1-flash-lite-preview` fallback model availability for Google provider catalogs when upstream model metadata lags ([README.md](README.md), [#1785](https://github.com/badlogic/pi-mono/issues/1785)).

### Breaking Changes

- Changed scoped model thinking semantics. Scoped entries without an explicit `:<thinking>` suffix now inherit the current session thinking level when selected, instead of applying a startup-captured default.
- Moved Node OAuth runtime exports off the top-level `@mariozechner/pi-ai` entry. OAuth login and refresh must be imported from `@mariozechner/pi-ai/oauth` ([#1814](https://github.com/badlogic/pi-mono/issues/1814)).

### Added

- Added `branchSummary.skipPrompt` setting to skip the summary prompt when navigating branches ([#1792](https://github.com/badlogic/pi-mono/issues/1792)).
- Added OpenCode Go provider support with `opencode-go` model defaults and `OPENCODE_API_KEY` environment variable support ([#1757](https://github.com/badlogic/pi-mono/issues/1757)).
- Added `gemini-3.1-flash-lite-preview` fallback model availability in provider catalogs when upstream catalogs lag ([#1785](https://github.com/badlogic/pi-mono/issues/1785)).

### Changed

- Updated Antigravity Gemini 3.1 model metadata and request headers to match upstream behavior.

### Fixed

- Fixed IME hardware cursor positioning in the custom extension editor (`ctx.ui.editor()` / extension editor dialog) by propagating focus to the internal `Editor`, preventing the terminal cursor from getting stuck at the bottom-right during composition.
- Added OSC 133 semantic zone markers around rendered user messages to support terminal navigation between prompts in iTerm2, WezTerm, Kitty, Ghostty, and other compatible terminals ([#1805](https://github.com/badlogic/pi-mono/issues/1805)).
- Fixed markdown blockquotes dropping nested list content in the TUI renderer ([#1787](https://github.com/badlogic/pi-mono/issues/1787)).
- Fixed TUI width handling for regional indicator symbols to prevent wrap drift and stale characters during streaming ([#1783](https://github.com/badlogic/pi-mono/issues/1783)).
- Fixed Kitty CSI-u handling to ignore unsupported modifiers so modifier-only events do not insert printable characters ([#1807](https://github.com/badlogic/pi-mono/issues/1807)).
- Fixed single-line paste handling to insert text atomically and avoid repeated `@` autocomplete scans on large pastes ([#1812](https://github.com/badlogic/pi-mono/issues/1812)).
- Fixed extension loading with the new `@mariozechner/pi-ai/oauth` export path by aliasing the oauth subpath in the extension loader and development path mapping ([#1814](https://github.com/badlogic/pi-mono/issues/1814)).
- Fixed browser-safe provider loading regressions by preloading the Bedrock provider module in compiled Bun binaries and rebuilding binaries against fresh workspace dependencies ([#1814](https://github.com/badlogic/pi-mono/issues/1814)).
- Fixed GNU screen terminal detection by downgrading theme output to 256-color mode for `screen*` TERM values ([#1809](https://github.com/badlogic/pi-mono/issues/1809)).
- Fixed branch summarization queue handling so messages typed while summaries are generated are processed correctly ([#1803](https://github.com/badlogic/pi-mono/issues/1803)).
- Fixed compaction summary requests to avoid reasoning output for non-reasoning models ([#1793](https://github.com/badlogic/pi-mono/issues/1793)).
- Fixed overflow auto-compaction cascades so a single overflow does not trigger repeated compaction loops.
- Fixed `models.json` to allow provider-scoped custom model ids and model-level `baseUrl` overrides ([#1759](https://github.com/badlogic/pi-mono/issues/1759), [#1777](https://github.com/badlogic/pi-mono/issues/1777)).
- Fixed session selector display sanitization by stripping control characters from session display text ([#1747](https://github.com/badlogic/pi-mono/issues/1747)).
- Fixed Groq Qwen3 reasoning effort mapping for OpenAI-compatible models ([#1745](https://github.com/badlogic/pi-mono/issues/1745)).
- Fixed Bedrock `AWS_PROFILE` region resolution by honoring profile `region` values ([#1800](https://github.com/badlogic/pi-mono/issues/1800)).
- Fixed Gemini 3.1 thinking-level detection for `google` and `google-vertex` providers ([#1785](https://github.com/badlogic/pi-mono/issues/1785)).
- Fixed browser bundling compatibility for `@mariozechner/pi-ai` by removing Node-only side effects from default browser import paths ([#1814](https://github.com/badlogic/pi-mono/issues/1814)).
## [0.55.4] - 2026-03-02

### New Features

- Runtime tool registration now applies immediately in active sessions. Tools registered via `pi.registerTool()` after startup are available to `pi.getAllTools()` and the LLM without `/reload` ([docs/extensions.md](docs/extensions.md), [examples/extensions/dynamic-tools.ts](examples/extensions/dynamic-tools.ts), [#1720](https://github.com/badlogic/pi-mono/issues/1720)).
- Tool definitions can customize the default system prompt with `promptSnippet` (`Available tools`) and `promptGuidelines` (`Guidelines`) while the tool is active ([docs/extensions.md](docs/extensions.md), [#1720](https://github.com/badlogic/pi-mono/issues/1720)).
- Custom tool renderers can suppress transcript output without leaving extra spacing or empty transcript footprint in interactive rendering ([docs/extensions.md](docs/extensions.md), [#1719](https://github.com/badlogic/pi-mono/pull/1719)).

### Added

- Added optional `promptSnippet` to `ToolDefinition` for one-line entries in the default system prompt's `Available tools` section. Active extension tools appear there when registered and active ([#1237](https://github.com/badlogic/pi-mono/pull/1237) by [@semtexzv](https://github.com/semtexzv)).
- Added optional `promptGuidelines` to `ToolDefinition` so active tools can append tool-specific bullets to the default system prompt `Guidelines` section ([#1720](https://github.com/badlogic/pi-mono/issues/1720)).

### Fixed

- Fixed `pi.registerTool()` dynamic registration after session initialization. Tools registered in `session_start` and later handlers now refresh immediately, become active, and are visible to the LLM without `/reload` ([#1720](https://github.com/badlogic/pi-mono/issues/1720))
- Fixed session message persistence ordering by serializing `AgentSession` event processing, preventing `toolResult` entries from being written before their corresponding assistant tool-call messages when extension handlers are asynchronous ([#1717](https://github.com/badlogic/pi-mono/issues/1717))
- Fixed spacing artifacts when custom tool renderers intentionally suppress per-call transcript output, including extra blank rows in interactive streaming and non-zero transcript footprint for empty custom renders ([#1719](https://github.com/badlogic/pi-mono/pull/1719) by [@alasano](https://github.com/alasano))
- Fixed `session.prompt()` returning before retry completion by creating the retry promise synchronously at `agent_end` dispatch, which closes a race when earlier queued event handlers are async ([#1726](https://github.com/badlogic/pi-mono/pull/1726) by [@pasky](https://github.com/pasky))

## [0.55.3] - 2026-02-27

### Fixed

- Changed the default image paste keybinding on Windows to `alt+v` to avoid `ctrl+v` conflicts with terminal paste behavior ([#1682](https://github.com/badlogic/pi-mono/pull/1682) by [@mrexodia](https://github.com/mrexodia)).

## [0.55.2] - 2026-02-27

### New Features

- Extensions can dynamically remove custom providers via `pi.unregisterProvider(name)`, restoring any built-in models that were overridden, without requiring `/reload` ([docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)).
- `pi.registerProvider()` now takes effect immediately when called outside the initial extension load phase (e.g. from a command handler), removing the need for `/reload` after late registrations.

### Added

- `pi.unregisterProvider(name)` removes a dynamically registered provider and its models from the registry without requiring `/reload`. Built-in models that were overridden by the provider are restored ([#1669](https://github.com/badlogic/pi-mono/pull/1669) by [@aliou](https://github.com/aliou)).

### Fixed

- `pi.registerProvider()` now takes effect immediately when called after the initial extension load phase (e.g. from a command handler). Previously the registration sat in a pending queue that was never flushed until the next `/reload` ([#1669](https://github.com/badlogic/pi-mono/pull/1669) by [@aliou](https://github.com/aliou)).
- Fixed duplicate session headers when forking from a point before any assistant message. `createBranchedSession` now defers file creation to `_persist()` when the branched path has no assistant message, matching the `newSession()` contract ([#1672](https://github.com/badlogic/pi-mono/pull/1672) by [@w-winter](https://github.com/w-winter)).
- Fixed SIGINT being delivered to pi while the process is suspended (e.g. via `ctrl+z`), which could corrupt terminal state on resume ([#1668](https://github.com/badlogic/pi-mono/pull/1668) by [@aliou](https://github.com/aliou)).
- Fixed Z.ai thinking control using wrong parameter name, causing thinking to always be enabled and wasting tokens/latency ([#1674](https://github.com/badlogic/pi-mono/pull/1674) by [@okuyam2y](https://github.com/okuyam2y))
- Fixed `redacted_thinking` blocks being silently dropped during Anthropic streaming, and related issues with interleaved-thinking beta headers and temperature being sent alongside extended thinking ([#1665](https://github.com/badlogic/pi-mono/pull/1665) by [@tctev](https://github.com/tctev))
- Fixed `(external, cli)` user-agent flag causing 401 errors on Anthropic setup-token endpoint ([#1677](https://github.com/badlogic/pi-mono/pull/1677) by [@LazerLance777](https://github.com/LazerLance777))
- Fixed crash when OpenAI-compatible provider returns a chunk with no `choices` array ([#1671](https://github.com/badlogic/pi-mono/issues/1671))

## [0.55.1] - 2026-02-26

### New Features

- Added offline startup mode via `--offline` (or `PI_OFFLINE`) to disable startup network operations, with startup network timeouts to avoid hangs in restricted or offline environments.
- Added `gemini-3.1-pro-preview` model support to the `google-gemini-cli` provider ([#1599](https://github.com/badlogic/pi-mono/pull/1599) by [@audichuang](https://github.com/audichuang)).

### Fixed

- Fixed offline startup hangs by adding offline startup behavior and network timeouts during managed tool setup ([#1631](https://github.com/badlogic/pi-mono/pull/1631) by [@mcollina](https://github.com/mcollina))
- Fixed Windows VT input initialization in ESM by loading koffi via createRequire, avoiding runtime and bundling issues in end-user environments ([#1627](https://github.com/badlogic/pi-mono/pull/1627) by [@kaste](https://github.com/kaste))
- Fixed managed `fd`/`rg` bootstrap on Windows in Git Bash by using `extract-zip` for `.zip` archives, searching extracted layouts more robustly, and isolating extraction temp directories to avoid concurrent download races ([#1348](https://github.com/badlogic/pi-mono/issues/1348))
- Fixed extension loading on Windows when resolving `@sinclair/typebox` aliases so subpath imports like `@sinclair/typebox/compiler` resolve correctly.
- Fixed adaptive thinking for Claude Sonnet 4.6 in Anthropic and Bedrock providers, and clamped unsupported `xhigh` effort values to supported levels ([#1548](https://github.com/badlogic/pi-mono/pull/1548) by [@tctev](https://github.com/tctev))
- Fixed Vertex ADC credential detection race by avoiding caching a false negative during async import initialization ([#1550](https://github.com/badlogic/pi-mono/pull/1550) by [@jeremiahgaylord-web](https://github.com/jeremiahgaylord-web))
- Fixed subagent extension example to resolve user agents from the configured agent directory instead of hardcoded paths ([#1559](https://github.com/badlogic/pi-mono/pull/1559) by [@tianshuwang](https://github.com/tianshuwang))

## [0.55.0] - 2026-02-24

### Breaking Changes

- Resource precedence for extensions, skills, prompts, themes, and slash-command name collisions is now project-first (`cwd/.pi`) before user-global (`~/.pi/agent`). If you relied on global resources overriding project resources with the same names, rename or reorder your resources.
- Extension registration conflicts no longer unload the entire later extension. All extensions stay loaded, and conflicting command/tool/flag names are resolved by first registration in load order.

## [0.54.2] - 2026-02-23

### Fixed

- Fixed `.pi` folder being created unnecessarily when only reading settings. The folder is now only created when writing project-specific settings.
- Fixed extension-driven runtime theme changes to persist in settings so `/settings` reflects the active `currentTheme` after `ctx.ui.setTheme(...)` ([#1483](https://github.com/badlogic/pi-mono/pull/1483) by [@ferologics](https://github.com/ferologics))
- Fixed interactive mode freezes during large streaming `write` tool calls by using incremental syntax highlighting while partial arguments stream, with a final full re-highlight after tool-call arguments complete.

## [0.54.1] - 2026-02-22

### Fixed

- Externalized koffi from bun binary builds, reducing archive sizes by ~15MB per platform (e.g. darwin-arm64: 43MB -> 28MB). Koffi's Windows-only `.node` file is now shipped alongside the Windows binary only.

## [0.54.0] - 2026-02-19

### Added

- Added default skill auto-discovery for `.agents/skills` locations. Pi now discovers project skills from `.agents/skills` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo), and global skills from `~/.agents/skills`, in addition to existing `.pi` skill paths.

## [0.53.1] - 2026-02-19

### Changed

- Added Gemini 3.1 model catalog entries for all built-in providers that currently expose it: `google`, `google-vertex`, `opencode`, `openrouter`, and `vercel-ai-gateway`.
- Added Claude Opus 4.6 Thinking to the `google-antigravity` model catalog.

## [0.53.0] - 2026-02-17

### Breaking Changes

- `SettingsManager` persistence semantics changed for SDK consumers. Setters now update in-memory state immediately and queue disk writes. Code that requires durable on-disk settings must call `await settingsManager.flush()`.
- `AuthStorage` constructor is no longer public. Use static factories (`AuthStorage.create(...)`, `AuthStorage.fromStorage(...)`, `AuthStorage.inMemory(...)`). This breaks code that used `new AuthStorage(...)` directly.

### Added

- Added `SettingsManager.drainErrors()` for caller-controlled settings I/O error handling without manager-side console output.
- Added auth storage backends (`FileAuthStorageBackend`, `InMemoryAuthStorageBackend`) and `AuthStorage.fromStorage(...)` for storage-first auth persistence wiring.
- Added Anthropic `claude-sonnet-4-6` model fallback entry to generated model definitions.

### Changed

- `SettingsManager` now uses scoped storage abstraction with per-scope locked read/merge/write persistence for global and project settings.

### Fixed

- Fixed project settings persistence to preserve unrelated external edits via merge-on-write, while still applying in-memory changes for modified keys.
- Fixed auth credential persistence to preserve unrelated external edits to `auth.json` via locked read/merge/write updates.
- Fixed auth load/persist error surfacing by buffering errors and exposing them via `AuthStorage.drainErrors()`.

## [0.52.12] - 2026-02-13

### Added

- Added `transport` setting (`"sse"`, `"websocket"`, `"auto"`) to `/settings` and `settings.json` for providers that support multiple transports (currently `openai-codex` via OpenAI Codex Responses).

### Changed

- Interactive mode now applies transport changes immediately to the active agent session.
- Settings migration now maps legacy `websockets: boolean` to the new `transport` setting.

## [0.52.11] - 2026-02-13

### Added

- Added MiniMax M2.5 model entries for `minimax`, `minimax-cn`, `openrouter`, and `vercel-ai-gateway` providers, plus `minimax-m2.5-free` for `opencode`.

## [0.52.10] - 2026-02-12

### New Features

- Extension terminal input interception via `terminal_input`, allowing extensions to consume or transform raw input before normal TUI handling. See [docs/extensions.md](docs/extensions.md).
- Expanded CLI model selection: `--model` now supports `provider/id`, fuzzy matching, and `:<thinking>` suffixes. See [README.md](README.md) and [docs/models.md](docs/models.md).
- Safer package source handling with stricter git source parsing and improved local path normalization. See [docs/packages.md](docs/packages.md).
- New built-in model definition `gpt-5.3-codex-spark` for OpenAI and OpenAI Codex providers.
- Improved OpenAI stream robustness for malformed trailing tool-call JSON in partial chunks.
- Added built-in GLM-5 model support via z.ai and OpenRouter provider catalogs.

### Breaking Changes

- `ContextUsage.tokens` and `ContextUsage.percent` are now `number | null`. After compaction, context token count is unknown until the next LLM response, so these fields return `null`. Extensions that read `ContextUsage` must handle the `null` case. Removed `usageTokens`, `trailingTokens`, and `lastUsageIndex` fields from `ContextUsage` (implementation details that should not have been public) ([#1382](https://github.com/badlogic/pi-mono/pull/1382) by [@ferologics](https://github.com/ferologics))
- Git source parsing is now strict without `git:` prefix: only protocol URLs are treated as git (`https://`, `http://`, `ssh://`, `git://`). Shorthand sources like `github.com/org/repo` and `git@github.com:org/repo` now require the `git:` prefix. ([#1426](https://github.com/badlogic/pi-mono/issues/1426))

### Added

- Added extension event forwarding for message and tool execution lifecycles (`message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`) ([#1375](https://github.com/badlogic/pi-mono/pull/1375) by [@sumeet](https://github.com/sumeet))
- Added `terminal_input` extension event to intercept, consume, or transform raw terminal input before normal TUI handling.
- Added `gpt-5.3-codex-spark` model definition for OpenAI and OpenAI Codex providers (research preview).

### Changed

- Routed GitHub Copilot Claude 4.x models through Anthropic Messages API, with updated Copilot header handling for Claude model requests.

### Fixed

- Fixed context usage percentage in footer showing stale pre-compaction values. After compaction the footer now shows `?/200k` until the next LLM response provides accurate usage ([#1382](https://github.com/badlogic/pi-mono/pull/1382) by [@ferologics](https://github.com/ferologics))
- Fixed `_checkCompaction()` using the first compaction entry instead of the latest, which could cause incorrect overflow detection with multiple compactions ([#1382](https://github.com/badlogic/pi-mono/pull/1382) by [@ferologics](https://github.com/ferologics))
- `--model` now works without `--provider`, supports `provider/id` syntax, fuzzy matching, and `:<thinking>` suffix (e.g., `--model sonnet:high`, `--model openai/gpt-4o`) ([#1350](https://github.com/badlogic/pi-mono/pull/1350) by [@mitsuhiko](https://github.com/mitsuhiko))
- Fixed local package path normalization for extension sources while tightening git source parsing rules ([#1426](https://github.com/badlogic/pi-mono/issues/1426))
- Fixed extension terminal input listeners not being cleared during session resets, which could leave stale handlers active.
- Fixed Termux bootstrap package name for `fd` installation ([#1433](https://github.com/badlogic/pi-mono/pull/1433))
- Fixed `@` file autocomplete fuzzy matching to prioritize path-prefix and segment matches for nested paths ([#1423](https://github.com/badlogic/pi-mono/issues/1423))
- Fixed OpenAI streaming tool-call parsing to tolerate malformed trailing JSON in partial chunks ([#1424](https://github.com/badlogic/pi-mono/issues/1424))

## [0.52.9] - 2026-02-08

### New Features

- Extensions can trigger a full runtime reload via `ctx.reload()`, useful for hot-reloading configuration or restarting the agent. See [docs/extensions.md](docs/extensions.md) and the [`reload-runtime` example](examples/extensions/reload-runtime.ts) ([#1371](https://github.com/badlogic/pi-mono/issues/1371))
- Short CLI disable aliases: `-ne` (`--no-extensions`), `-ns` (`--no-skills`), and `-np` (`--no-prompt-templates`) for faster interactive usage and scripting.
- `/export` HTML now includes collapsible tool input schemas (parameter names, types, and descriptions), improving session review and sharing workflows ([#1416](https://github.com/badlogic/pi-mono/pull/1416) by [@marchellodev](https://github.com/marchellodev)).
- `pi.getAllTools()` now exposes tool parameters in addition to name and description, enabling richer extension integrations ([#1416](https://github.com/badlogic/pi-mono/pull/1416) by [@marchellodev](https://github.com/marchellodev)).

### Added

- Added `ctx.reload()` to the extension API for programmatic runtime reload ([#1371](https://github.com/badlogic/pi-mono/issues/1371))
- Added short aliases for disable flags: `-ne` for `--no-extensions`, `-ns` for `--no-skills`, `-np` for `--no-prompt-templates`
- `/export` HTML now includes tool input schema (parameter names, types, descriptions) in a collapsible section under each tool ([#1416](https://github.com/badlogic/pi-mono/pull/1416) by [@marchellodev](https://github.com/marchellodev))
- `pi.getAllTools()` now returns tool parameters in addition to name and description ([#1416](https://github.com/badlogic/pi-mono/pull/1416) by [@marchellodev](https://github.com/marchellodev))

### Fixed

- Fixed extension source parsing so dot-prefixed local paths (for example `.pi/extensions/foo.ts`) are treated as local paths instead of git URLs
- Fixed fd/rg download failing on Windows due to `unzip` not being available; now uses `tar` for both `.tar.gz` and `.zip` extraction, with proper error reporting ([#1348](https://github.com/badlogic/pi-mono/issues/1348))
- Fixed RPC mode documentation incorrectly stating `ctx.hasUI` is `false`; it is `true` because dialog and fire-and-forget UI methods work via the RPC sub-protocol. Also documented missing unsupported/degraded methods (`pasteToEditor`, `getAllThemes`, `getTheme`, `setTheme`) ([#1411](https://github.com/badlogic/pi-mono/pull/1411) by [@aliou](https://github.com/aliou))
- Fixed `rg` not available in bash tool by downloading it at startup alongside `fd` ([#1348](https://github.com/badlogic/pi-mono/issues/1348))
- Fixed `custom-compaction` example to use `ModelRegistry` ([#1387](https://github.com/badlogic/pi-mono/issues/1387))
- Google providers now support full JSON Schema in tool declarations (anyOf, oneOf, const, etc.) ([#1398](https://github.com/badlogic/pi-mono/issues/1398) by [@jarib](https://github.com/jarib))
- Reverted incorrect Antigravity model change: `claude-opus-4-6-thinking` back to `claude-opus-4-5-thinking` (model does not exist on Antigravity endpoint)
- Updated the Antigravity system instruction to a more compact version for Google Gemini CLI compatibility
- Corrected opencode context windows for Claude Sonnet 4 and 4.5 ([#1383](https://github.com/badlogic/pi-mono/issues/1383))
- Fixed subagent example unknown-agent errors to include available agent names ([#1414](https://github.com/badlogic/pi-mono/pull/1414) by [@dnouri](https://github.com/dnouri))

## [0.52.8] - 2026-02-07

### New Features

- Emacs-style kill ring (`ctrl+k`/`ctrl+y`/`alt+y`) and undo (`ctrl+z`) in the editor input ([#1373](https://github.com/badlogic/pi-mono/pull/1373) by [@Perlence](https://github.com/Perlence))
- OpenRouter `auto` model alias (`openrouter:auto`) for automatic model routing ([#1361](https://github.com/badlogic/pi-mono/pull/1361) by [@yogasanas](https://github.com/yogasanas))
- Extensions can programmatically paste content into the editor via `pasteToEditor` in the extension UI context. See [docs/extensions.md](docs/extensions.md) ([#1351](https://github.com/badlogic/pi-mono/pull/1351) by [@kaofelix](https://github.com/kaofelix))
- `pi <package> --help` and invalid subcommands now show helpful output instead of failing silently ([#1347](https://github.com/badlogic/pi-mono/pull/1347) by [@ferologics](https://github.com/ferologics))

### Added

- Added `pasteToEditor` to extension UI context for programmatic editor paste ([#1351](https://github.com/badlogic/pi-mono/pull/1351) by [@kaofelix](https://github.com/kaofelix))
- Added package subcommand help and friendly error messages for invalid commands ([#1347](https://github.com/badlogic/pi-mono/pull/1347) by [@ferologics](https://github.com/ferologics))
- Added OpenRouter `auto` model alias for automatic model routing ([#1361](https://github.com/badlogic/pi-mono/pull/1361) by [@yogasanas](https://github.com/yogasanas))
- Added kill ring (ctrl+k/ctrl+y/alt+y) and undo (ctrl+z) support to the editor input ([#1373](https://github.com/badlogic/pi-mono/pull/1373) by [@Perlence](https://github.com/Perlence))

### Changed

- Replaced Claude Opus 4.5 with Opus 4.6 as default model ([#1345](https://github.com/badlogic/pi-mono/pull/1345) by [@calvin-hpnet](https://github.com/calvin-hpnet))

### Fixed

- Fixed temporary git package caches (`-e <git-url>`) to refresh on cache hits for unpinned sources, including detached/no-upstream checkouts
- Fixed aborting retries when an extension customizes the editor ([#1364](https://github.com/badlogic/pi-mono/pull/1364) by [@Perlence](https://github.com/Perlence))
- Fixed autocomplete not propagating to custom editors created by extensions ([#1372](https://github.com/badlogic/pi-mono/pull/1372) by [@Perlence](https://github.com/Perlence))
- Fixed extension shutdown to use clean TUI shutdown path, preventing orphaned processes

## [0.52.7] - 2026-02-06

### New Features

- Per-model overrides in `models.json` via `modelOverrides`, allowing customization of built-in provider models without replacing provider model lists. See [docs/models.md#per-model-overrides](docs/models.md#per-model-overrides).
- `models.json` provider `models` now merge with built-in models by `id`, so custom models can be added or replace matching built-ins without full provider replacement. See [docs/models.md#overriding-built-in-providers](docs/models.md#overriding-built-in-providers).
- Bedrock proxy support for unauthenticated endpoints via `AWS_BEDROCK_SKIP_AUTH` and `AWS_BEDROCK_FORCE_HTTP1`. See [docs/providers.md](docs/providers.md).

### Breaking Changes

- Changed `models.json` provider `models` behavior from full replacement to merge-by-id with built-in models. Built-in models are now kept by default, and custom models upsert by `id`.

### Added

- Added `modelOverrides` in `models.json` to customize individual built-in models per provider without full provider replacement ([#1332](https://github.com/badlogic/pi-mono/pull/1332) by [@charles-cooper](https://github.com/charles-cooper))
- Added `AWS_BEDROCK_SKIP_AUTH` and `AWS_BEDROCK_FORCE_HTTP1` environment variables for connecting to unauthenticated Bedrock proxies ([#1320](https://github.com/badlogic/pi-mono/pull/1320) by [@virtuald](https://github.com/virtuald))

### Fixed

- Fixed extra spacing between thinking-only assistant content and subsequent tool execution blocks when assistant messages contain no text
- Fixed queued steering/follow-up/custom messages remaining stuck after threshold auto-compaction by resuming the agent loop when Agent-level queues still contain pending messages ([#1312](https://github.com/badlogic/pi-mono/pull/1312) by [@ferologics](https://github.com/ferologics))
- Fixed `tool_result` extension handlers to chain result patches across handlers instead of last-handler-wins behavior ([#1280](https://github.com/badlogic/pi-mono/issues/1280))
- Fixed compromised auth lock files being handled gracefully instead of crashing auth storage initialization ([#1322](https://github.com/badlogic/pi-mono/issues/1322))
- Fixed Bedrock adaptive thinking handling for Claude Opus 4.6 with interleaved thinking beta responses ([#1323](https://github.com/badlogic/pi-mono/pull/1323) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Fixed OpenAI Responses API requests to use `store: false` by default to avoid server-side history logging ([#1308](https://github.com/badlogic/pi-mono/issues/1308))
- Fixed interactive mode startup by initializing autocomplete after resources are loaded ([#1328](https://github.com/badlogic/pi-mono/issues/1328))
- Fixed `modelOverrides` merge behavior for nested objects and documented usage details ([#1062](https://github.com/badlogic/pi-mono/issues/1062))

## [0.52.6] - 2026-02-05

### Breaking Changes

- Removed `/exit` command handling. Use `/quit` to exit ([#1303](https://github.com/badlogic/pi-mono/issues/1303))

### Fixed

- Fixed `/quit` being shadowed by fuzzy slash command autocomplete matches from skills by adding `/quit` to built-in command autocomplete ([#1303](https://github.com/badlogic/pi-mono/issues/1303))
- Fixed local package source parsing and settings normalization regression that misclassified relative paths as git URLs and prevented globally installed local packages from loading after restart ([#1304](https://github.com/badlogic/pi-mono/issues/1304))

## [0.52.5] - 2026-02-05

### Fixed

- Fixed thinking level capability detection so Anthropic Opus 4.6 models expose `xhigh` in selectors and cycling

## [0.52.4] - 2026-02-05

### Fixed

- Fixed extensions setting not respecting `package.json` `pi.extensions` manifest when directory is specified directly ([#1302](https://github.com/badlogic/pi-mono/pull/1302) by [@hjanuschka](https://github.com/hjanuschka))

## [0.52.3] - 2026-02-05

### Fixed

- Fixed git package parsing fallback for unknown hosts so enterprise git sources like `git:github.tools.sap/org/repo` are treated as git packages instead of local paths
- Fixed git package `@ref` parsing for shorthand, HTTPS, and SSH source formats, including branch refs with slashes
- Fixed Bedrock default model ID from `us.anthropic.claude-opus-4-6-v1:0` to `us.anthropic.claude-opus-4-6-v1`
- Fixed Bedrock Opus 4.6 model metadata (IDs, cache pricing) and added missing EU profile
- Fixed Claude Opus 4.6 context window metadata to 200000 for Anthropic and OpenCode providers

## [0.52.2] - 2026-02-05

### Changed

- Updated default model for `anthropic` provider to `claude-opus-4-6`
- Updated default model for `openai-codex` provider to `gpt-5.3-codex`
- Updated default model for `amazon-bedrock` provider to `us.anthropic.claude-opus-4-6-v1:0`
- Updated default model for `vercel-ai-gateway` provider to `anthropic/claude-opus-4-6`
- Updated default model for `opencode` provider to `claude-opus-4-6`

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

### New Features

- Claude Opus 4.6 model support.
- GPT-5.3 Codex model support (OpenAI Codex provider only).
- SSH URL support for git packages. See [docs/packages.md](docs/packages.md).
- `auth.json` API keys now support shell command resolution (`!command`) and environment variable lookup. See [docs/providers.md](docs/providers.md).
- Model selectors now display the selected model name.

### Added

- API keys in `auth.json` now support shell command resolution (`!command`) and environment variable lookup, matching the behavior in `models.json`
- Added `minimal-mode.ts` example extension demonstrating how to override built-in tool rendering for a minimal display mode
- Added Claude Opus 4.6 model to the model catalog
- Added GPT-5.3 Codex model to the model catalog (OpenAI Codex provider only)
- Added SSH URL support for git packages ([#1287](https://github.com/badlogic/pi-mono/pull/1287) by [@markusn](https://github.com/markusn))
- Model selectors now display the selected model name ([#1275](https://github.com/badlogic/pi-mono/pull/1275) by [@haoqixu](https://github.com/haoqixu))

### Fixed

- Fixed HTML export losing indentation in ANSI-rendered tool output (e.g. JSON code blocks in custom tool results) ([#1269](https://github.com/badlogic/pi-mono/pull/1269) by [@aliou](https://github.com/aliou))
- Fixed images being silently dropped when `prompt()` is called with both `images` and `streamingBehavior` during streaming. `steer()`, `followUp()`, and the corresponding RPC commands now accept optional images. ([#1271](https://github.com/badlogic/pi-mono/pull/1271) by [@aliou](https://github.com/aliou))
- CLI `--help`, `--version`, `--list-models`, and `--export` now exit even if extensions keep the event loop alive ([#1285](https://github.com/badlogic/pi-mono/pull/1285) by [@ferologics](https://github.com/ferologics))
- Fixed crash when models send malformed tool arguments (objects instead of strings) ([#1259](https://github.com/badlogic/pi-mono/issues/1259))
- Fixed custom message expand state not being respected ([#1258](https://github.com/badlogic/pi-mono/pull/1258) by [@Gurpartap](https://github.com/Gurpartap))
- Fixed skill loader to respect .gitignore, .ignore, and .fdignore when scanning directories

## [0.51.6] - 2026-02-04

### New Features

- Configurable resume keybinding action for opening the session resume selector. See [docs/keybindings.md](docs/keybindings.md). ([#1249](https://github.com/badlogic/pi-mono/pull/1249) by [@juanibiapina](https://github.com/juanibiapina))

### Added

- Added `resume` as a configurable keybinding action, allowing users to bind a key to open the session resume selector (like `newSession`, `tree`, and `fork`) ([#1249](https://github.com/badlogic/pi-mono/pull/1249) by [@juanibiapina](https://github.com/juanibiapina))

### Changed

- Slash command menu now triggers on the first line even when other lines have content, allowing commands to be prepended to existing text ([#1227](https://github.com/badlogic/pi-mono/pull/1227) by [@aliou](https://github.com/aliou))

### Fixed

- Ignored unknown skill frontmatter fields when loading skills
- Fixed `/reload` not picking up changes in global settings.json ([#1241](https://github.com/badlogic/pi-mono/issues/1241))
- Fixed forked sessions to persist the user message after forking
- Fixed forked sessions to write to new session files instead of the parent ([#1242](https://github.com/badlogic/pi-mono/issues/1242))
- Fixed local package removal to normalize paths before comparison ([#1243](https://github.com/badlogic/pi-mono/issues/1243))
- Fixed OpenAI Codex Responses provider to respect configured baseUrl ([#1244](https://github.com/badlogic/pi-mono/issues/1244))
- Fixed `/settings` crashing in narrow terminals by handling small widths in the settings list ([#1246](https://github.com/badlogic/pi-mono/pull/1246) by [@haoqixu](https://github.com/haoqixu))
- Fixed Unix bash detection to fall back to PATH lookup when `/bin/bash` is unavailable, including Termux setups ([#1230](https://github.com/badlogic/pi-mono/pull/1230) by [@VaclavSynacek](https://github.com/VaclavSynacek))

## [0.51.5] - 2026-02-04

### Changed

- Changed Bedrock model generation to drop legacy workarounds now handled upstream ([#1239](https://github.com/badlogic/pi-mono/pull/1239) by [@unexge](https://github.com/unexge))

### Fixed

- Fixed Windows package installs regression by using shell execution instead of `.cmd` resolution ([#1220](https://github.com/badlogic/pi-mono/issues/1220))

## [0.51.4] - 2026-02-03

### New Features

- Share URLs now default to pi.dev, graciously donated by exe.dev.

### Changed

- Share URLs now use pi.dev by default while pi.dev and buildwithpi.ai continue to work.

### Fixed

- Fixed input scrolling to avoid splitting emoji sequences ([#1228](https://github.com/badlogic/pi-mono/pull/1228) by [@haoqixu](https://github.com/haoqixu))

## [0.51.3] - 2026-02-03

### New Features

- Command discovery for extensions via `ExtensionAPI.getCommands()`, with `commands.ts` example for invocation patterns. See [docs/extensions.md#pigetcommands](docs/extensions.md#pigetcommands) and [examples/extensions/commands.ts](examples/extensions/commands.ts).
- Local path support for `pi install` and `pi remove`, with relative path resolution against the settings file. See [docs/packages.md#local-paths](docs/packages.md#local-paths).

### Breaking Changes

- RPC `get_commands` response and `SlashCommandSource` type: renamed `"template"` to `"prompt"` for consistency with the rest of the codebase

### Added

- Added `ExtensionAPI.getCommands()` to let extensions list available slash commands (extensions, prompt templates, skills) for invocation via `prompt` ([#1210](https://github.com/badlogic/pi-mono/pull/1210) by [@w-winter](https://github.com/w-winter))
- Added `commands.ts` example extension and exported `SlashCommandInfo` types for command discovery integrations ([#1210](https://github.com/badlogic/pi-mono/pull/1210) by [@w-winter](https://github.com/w-winter))
- Added local path support for `pi install` and `pi remove` with relative paths stored against the target settings file ([#1216](https://github.com/badlogic/pi-mono/issues/1216))

### Fixed

- Fixed default thinking level persistence so settings-derived defaults are saved and restored correctly
- Fixed Windows package installs by resolving `npm.cmd` when `npm` is not directly executable ([#1220](https://github.com/badlogic/pi-mono/issues/1220))
- Fixed xhigh thinking level support check to accept gpt-5.2 model IDs ([#1209](https://github.com/badlogic/pi-mono/issues/1209))

## [0.51.2] - 2026-02-03

### New Features

- Extension tool output expansion controls via ExtensionUIContext getToolsExpanded and setToolsExpanded. See [docs/extensions.md](docs/extensions.md) and [docs/rpc.md](docs/rpc.md).

### Added

- Added ExtensionUIContext getToolsExpanded and setToolsExpanded for controlling tool output expansion ([#1199](https://github.com/badlogic/pi-mono/pull/1199) by [@academo](https://github.com/academo))
- Added install method detection to show package manager specific update instructions ([#1203](https://github.com/badlogic/pi-mono/pull/1203) by [@Itsnotaka](https://github.com/Itsnotaka))

### Fixed

- Fixed Kitty key release events leaking to parent shell over slow SSH connections by draining stdin for up to 1s on exit ([#1204](https://github.com/badlogic/pi-mono/issues/1204))
- Fixed legacy newline handling in the editor to preserve previous newline behavior
- Fixed @ autocomplete to include hidden paths
- Fixed submit fallback to honor configured keybindings
- Fixed extension commands conflicting with built-in commands by skipping them ([#1196](https://github.com/badlogic/pi-mono/pull/1196) by [@haoqixu](https://github.com/haoqixu))
- Fixed @-prefixed tool paths failing to resolve by stripping the prefix ([#1206](https://github.com/badlogic/pi-mono/issues/1206))
- Fixed install method detection to avoid stale cached results

## [0.51.1] - 2026-02-02

### New Features

- **Extension API switchSession**: Extensions can now programmatically switch sessions via `ctx.switchSession(sessionPath)`. See [docs/extensions.md](docs/extensions.md). ([#1187](https://github.com/badlogic/pi-mono/issues/1187))
- **Clear on shrink setting**: New `terminal.clearOnShrink` setting keeps the editor and footer pinned to the bottom of the terminal when content shrinks. May cause some flicker due to redraws. Disabled by default. Enable via `/settings` or `PI_CLEAR_ON_SHRINK=1` env var.

### Fixed

- Fixed scoped models not finding valid credentials after logout ([#1194](https://github.com/badlogic/pi-mono/pull/1194) by [@terrorobe](https://github.com/terrorobe))
- Fixed Ctrl+D exit closing the parent SSH session due to stdin buffer race condition ([#1185](https://github.com/badlogic/pi-mono/issues/1185))
- Fixed emoji cursor positioning in editor input ([#1183](https://github.com/badlogic/pi-mono/pull/1183) by [@haoqixu](https://github.com/haoqixu))

## [0.51.0] - 2026-02-01

### Breaking Changes

- **Extension tool signature change**: `ToolDefinition.execute` now uses `(toolCallId, params, signal, onUpdate, ctx)` parameter order to match `AgentTool.execute`. Previously it was `(toolCallId, params, onUpdate, ctx, signal)`. This makes wrapping built-in tools trivial since the first four parameters now align. Update your extensions by swapping the `signal` and `onUpdate` parameters:
  ```ts
  // Before
  async execute(toolCallId, params, onUpdate, ctx, signal) { ... }

  // After
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... }
  ```

### New Features

- **Android/Termux support**: Pi now runs on Android via Termux. Install with:
  ```bash
  pkg install nodejs termux-api git
  npm install -g @mariozechner/pi-coding-agent
  mkdir -p ~/.pi/agent
  echo "You are running on Android in Termux." > ~/.pi/agent/AGENTS.md
  ```
  Clipboard operations fall back gracefully when `termux-api` is unavailable. ([#1164](https://github.com/badlogic/pi-mono/issues/1164))
- **Bash spawn hook**: Extensions can now intercept and modify bash commands before execution via `pi.setBashSpawnHook()`. Adjust the command string, working directory, or environment variables. See [docs/extensions.md](docs/extensions.md). ([#1160](https://github.com/badlogic/pi-mono/pull/1160) by [@mitsuhiko](https://github.com/mitsuhiko))
- **Linux ARM64 musl support**: Pi now runs on Alpine Linux ARM64 (linux-arm64-musl) via updated clipboard dependency.
- **Nix/Guix support**: `PI_PACKAGE_DIR` environment variable overrides the package path for content-addressed package managers where store paths tokenize poorly. See [README.md#environment-variables](README.md#environment-variables). ([#1153](https://github.com/badlogic/pi-mono/pull/1153) by [@odysseus0](https://github.com/odysseus0))
- **Named session filter**: `/resume` picker now supports filtering to show only named sessions via Ctrl+N. Configurable via `toggleSessionNamedFilter` keybinding. See [docs/keybindings.md](docs/keybindings.md). ([#1128](https://github.com/badlogic/pi-mono/pull/1128) by [@w-winter](https://github.com/w-winter))
- **Typed tool call events**: Extension developers can narrow `ToolCallEvent` types using `isToolCallEventType()` for better TypeScript support. See [docs/extensions.md#tool-call-events](docs/extensions.md#tool-call-events). ([#1147](https://github.com/badlogic/pi-mono/pull/1147) by [@giuseppeg](https://github.com/giuseppeg))
- **Extension UI Protocol**: Full RPC documentation and examples for extension dialogs and notifications, enabling headless clients to support interactive extensions. See [docs/rpc.md#extension-ui-protocol](docs/rpc.md#extension-ui-protocol). ([#1144](https://github.com/badlogic/pi-mono/pull/1144) by [@aliou](https://github.com/aliou))

### Added

- Added Linux ARM64 musl (Alpine Linux) support via clipboard dependency update
- Added Android/Termux support with graceful clipboard fallback ([#1164](https://github.com/badlogic/pi-mono/issues/1164))
- Added bash tool spawn hook support for adjusting command, cwd, and env before execution ([#1160](https://github.com/badlogic/pi-mono/pull/1160) by [@mitsuhiko](https://github.com/mitsuhiko))
- Added typed `ToolCallEvent.input` per tool with `isToolCallEventType()` type guard for narrowing built-in tool events ([#1147](https://github.com/badlogic/pi-mono/pull/1147) by [@giuseppeg](https://github.com/giuseppeg))
- Exported `discoverAndLoadExtensions` from package to enable extension testing without a local repo clone ([#1148](https://github.com/badlogic/pi-mono/issues/1148))
- Added Extension UI Protocol documentation to RPC docs covering all request/response types for extension dialogs and notifications ([#1144](https://github.com/badlogic/pi-mono/pull/1144) by [@aliou](https://github.com/aliou))
- Added `rpc-demo.ts` example extension exercising all RPC-supported extension UI methods ([#1144](https://github.com/badlogic/pi-mono/pull/1144) by [@aliou](https://github.com/aliou))
- Added `rpc-extension-ui.ts` TUI example client demonstrating the extension UI protocol with interactive dialogs ([#1144](https://github.com/badlogic/pi-mono/pull/1144) by [@aliou](https://github.com/aliou))
- Added `PI_PACKAGE_DIR` environment variable to override package path for content-addressed package managers (Nix, Guix) where store paths tokenize poorly ([#1153](https://github.com/badlogic/pi-mono/pull/1153) by [@odysseus0](https://github.com/odysseus0))
- `/resume` session picker now supports named-only filter toggle (default Ctrl+N, configurable via `toggleSessionNamedFilter`) to show only named sessions ([#1128](https://github.com/badlogic/pi-mono/pull/1128) by [@w-winter](https://github.com/w-winter))

### Fixed

- Fixed `pi update` not updating npm/git packages when called without arguments ([#1151](https://github.com/badlogic/pi-mono/issues/1151))
- Fixed `models.json` validation requiring fields documented as optional. Model definitions now only require `id`; all other fields (`name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`) have sensible defaults. ([#1146](https://github.com/badlogic/pi-mono/issues/1146))
- Fixed models resolving relative paths in skill files from cwd instead of skill directory by adding explicit guidance to skills preamble ([#1136](https://github.com/badlogic/pi-mono/issues/1136))
- Fixed tree selector losing focus state when navigating entries ([#1142](https://github.com/badlogic/pi-mono/pull/1142) by [@Perlence](https://github.com/Perlence))
- Fixed `cacheRetention` option not being passed through in `buildBaseOptions` ([#1154](https://github.com/badlogic/pi-mono/issues/1154))
- Fixed OAuth login/refresh not using HTTP proxy settings (`HTTP_PROXY`, `HTTPS_PROXY` env vars) ([#1132](https://github.com/badlogic/pi-mono/issues/1132))
- Fixed `pi update <source>` installing packages locally when the source is only registered globally ([#1163](https://github.com/badlogic/pi-mono/pull/1163) by [@aliou](https://github.com/aliou))
- Fixed tree navigation with summarization overwriting editor content typed during the summarization wait ([#1169](https://github.com/badlogic/pi-mono/pull/1169) by [@aliou](https://github.com/aliou))

## [0.50.9] - 2026-02-01

### Added

- Added `titlebar-spinner.ts` example extension that shows a braille spinner animation in the terminal title while the agent is working.
- Added `PI_AI_ANTIGRAVITY_VERSION` environment variable documentation to help text ([#1129](https://github.com/badlogic/pi-mono/issues/1129))
- Added `cacheRetention` stream option with provider-specific mappings for prompt cache controls, defaulting to short retention ([#1134](https://github.com/badlogic/pi-mono/issues/1134))

## [0.50.8] - 2026-02-01

### Added

- Added `newSession`, `tree`, and `fork` keybinding actions for `/new`, `/tree`, and `/fork` commands. All unbound by default. ([#1114](https://github.com/badlogic/pi-mono/pull/1114) by [@juanibiapina](https://github.com/juanibiapina))
- Added `retry.maxDelayMs` setting to cap maximum server-requested retry delay. When a provider requests a longer delay (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Default: 60000ms (60 seconds). ([#1123](https://github.com/badlogic/pi-mono/issues/1123))
- `/resume` session picker: new "Threaded" sort mode (now default) displays sessions in a tree structure based on fork relationships. Compact one-line format with message count and age on the right. ([#1124](https://github.com/badlogic/pi-mono/pull/1124) by [@pasky](https://github.com/pasky))
- Added Qwen CLI OAuth provider extension example. ([#940](https://github.com/badlogic/pi-mono/pull/940) by [@4h9fbZ](https://github.com/4h9fbZ))
- Added OAuth `modifyModels` hook support for extension-registered providers at registration time. ([#940](https://github.com/badlogic/pi-mono/pull/940) by [@4h9fbZ](https://github.com/4h9fbZ))
- Added Qwen thinking format support for OpenAI-compatible completions via `enable_thinking`. ([#940](https://github.com/badlogic/pi-mono/pull/940) by [@4h9fbZ](https://github.com/4h9fbZ))
- Added sticky column tracking for vertical cursor navigation so the editor restores the preferred column when moving across short lines. ([#1120](https://github.com/badlogic/pi-mono/pull/1120) by [@Perlence](https://github.com/Perlence))
- Added `resources_discover` extension hook to supply additional skills, prompts, and themes on startup and reload.

### Fixed

- Fixed `switchSession()` appending spurious `thinking_level_change` entry to session log on resume. `setThinkingLevel()` is now idempotent. ([#1118](https://github.com/badlogic/pi-mono/issues/1118))
- Fixed clipboard image paste on WSL2/WSLg writing invalid PNG files when clipboard provides `image/bmp` format. BMP images are now converted to PNG before saving. ([#1112](https://github.com/badlogic/pi-mono/pull/1112) by [@lightningRalf](https://github.com/lightningRalf))
- Fixed Kitty keyboard protocol base layout fallback so non-QWERTY layouts do not trigger wrong shortcuts ([#1096](https://github.com/badlogic/pi-mono/pull/1096) by [@rytswd](https://github.com/rytswd))

## [0.50.7] - 2026-01-31

### Fixed

- Multi-file extensions in packages now work correctly. Package resolution now uses the same discovery logic as local extensions: only `index.ts` (or manifest-declared entries) are loaded from subdirectories, not helper modules. ([#1102](https://github.com/badlogic/pi-mono/issues/1102))

## [0.50.6] - 2026-01-30

### Added

- Added `ctx.getSystemPrompt()` to extension context for accessing the current effective system prompt ([#1098](https://github.com/badlogic/pi-mono/pull/1098) by [@kaofelix](https://github.com/kaofelix))

### Fixed

- Fixed empty rows appearing below footer when content shrinks (e.g., closing `/tree`, clearing multi-line editor) ([#1095](https://github.com/badlogic/pi-mono/pull/1095) by [@marckrenn](https://github.com/marckrenn))
- Fixed terminal cursor remaining hidden after exiting TUI via `stop()` when a render was pending ([#1099](https://github.com/badlogic/pi-mono/pull/1099) by [@haoqixu](https://github.com/haoqixu))

## [0.50.5] - 2026-01-30

## [0.50.4] - 2026-01-30

### New Features

- **OSC 52 clipboard support for SSH/mosh** - The `/copy` command now works over remote connections using the OSC 52 terminal escape sequence. No more clipboard frustration when using pi over SSH. ([#1069](https://github.com/badlogic/pi-mono/issues/1069) by [@gturkoglu](https://github.com/gturkoglu))
- **Vercel AI Gateway routing** - Route requests through Vercel's AI Gateway with provider failover and load balancing. Configure via `vercelGatewayRouting` in models.json. ([#1051](https://github.com/badlogic/pi-mono/pull/1051) by [@ben-vargas](https://github.com/ben-vargas))
- **Character jump navigation** - Bash/Readline-style character search: Ctrl+] jumps forward to the next occurrence of a character, Ctrl+Alt+] jumps backward. ([#1074](https://github.com/badlogic/pi-mono/pull/1074) by [@Perlence](https://github.com/Perlence))
- **Emacs-style Ctrl+B/Ctrl+F navigation** - Alternative keybindings for word navigation (cursor word left/right) in the editor. ([#1053](https://github.com/badlogic/pi-mono/pull/1053) by [@ninlds](https://github.com/ninlds))
- **Line boundary navigation** - Editor jumps to line start when pressing Up at first visual line, and line end when pressing Down at last visual line. ([#1050](https://github.com/badlogic/pi-mono/pull/1050) by [@4h9fbZ](https://github.com/4h9fbZ))
- **Performance improvements** - Optimized image line detection and box rendering cache in the TUI for better rendering performance. ([#1084](https://github.com/badlogic/pi-mono/pull/1084) by [@can1357](https://github.com/can1357))
- **`set_session_name` RPC command** - Headless clients can now set the session display name programmatically. ([#1075](https://github.com/badlogic/pi-mono/pull/1075) by [@dnouri](https://github.com/dnouri))
- **Disable double-escape behavior** - New `"none"` option for `doubleEscapeAction` setting completely disables the double-escape shortcut. ([#973](https://github.com/badlogic/pi-mono/issues/973) by [@juanibiapina](https://github.com/juanibiapina))

### Added

- Added "none" option to `doubleEscapeAction` setting to disable double-escape behavior entirely ([#973](https://github.com/badlogic/pi-mono/issues/973) by [@juanibiapina](https://github.com/juanibiapina))
- Added OSC 52 clipboard support for SSH/mosh sessions. `/copy` now works over remote connections. ([#1069](https://github.com/badlogic/pi-mono/issues/1069) by [@gturkoglu](https://github.com/gturkoglu))
- Added Vercel AI Gateway routing support via `vercelGatewayRouting` in models.json ([#1051](https://github.com/badlogic/pi-mono/pull/1051) by [@ben-vargas](https://github.com/ben-vargas))
- Added Ctrl+B and Ctrl+F keybindings for cursor word left/right navigation in the editor ([#1053](https://github.com/badlogic/pi-mono/pull/1053) by [@ninlds](https://github.com/ninlds))
- Added character jump navigation: Ctrl+] jumps forward to next character, Ctrl+Alt+] jumps backward ([#1074](https://github.com/badlogic/pi-mono/pull/1074) by [@Perlence](https://github.com/Perlence))
- Editor now jumps to line start when pressing Up at first visual line, and line end when pressing Down at last visual line ([#1050](https://github.com/badlogic/pi-mono/pull/1050) by [@4h9fbZ](https://github.com/4h9fbZ))
- Optimized image line detection and box rendering cache for better TUI performance ([#1084](https://github.com/badlogic/pi-mono/pull/1084) by [@can1357](https://github.com/can1357))
- Added `set_session_name` RPC command for headless clients to set session display name ([#1075](https://github.com/badlogic/pi-mono/pull/1075) by [@dnouri](https://github.com/dnouri))

### Fixed

- Read tool now handles macOS filenames with curly quotes (U+2019) and NFD Unicode normalization ([#1078](https://github.com/badlogic/pi-mono/issues/1078))
- Respect .gitignore, .ignore, and .fdignore files when scanning package resources for skills, prompts, themes, and extensions ([#1072](https://github.com/badlogic/pi-mono/issues/1072))
- Fixed tool call argument defaults when providers omit inputs ([#1065](https://github.com/badlogic/pi-mono/issues/1065))
- Invalid JSON in settings.json no longer causes the file to be overwritten with empty settings ([#1054](https://github.com/badlogic/pi-mono/issues/1054))
- Config selector now shows folder name for extensions with duplicate display names ([#1064](https://github.com/badlogic/pi-mono/pull/1064) by [@Graffioh](https://github.com/Graffioh))

## [0.50.3] - 2026-01-29

### New Features

- **Kimi For Coding provider**: Access Moonshot AI's Anthropic-compatible coding API. Set `KIMI_API_KEY` environment variable. See [README.md#kimi-for-coding](README.md#kimi-for-coding).

### Added

- Added Kimi For Coding provider support (Moonshot AI's Anthropic-compatible coding API). Set `KIMI_API_KEY` environment variable. See [README.md#kimi-for-coding](README.md#kimi-for-coding).

### Fixed

- Resources now appear before messages when resuming a session, preventing loaded context from appearing at the bottom of the chat.

## [0.50.2] - 2026-01-29

### New Features

- **Hugging Face provider**: Access Hugging Face models via OpenAI-compatible Inference Router. Set `HF_TOKEN` environment variable. See [README.md#hugging-face](README.md#hugging-face).
- **Extended prompt caching**: `PI_CACHE_RETENTION=long` enables 1-hour caching for Anthropic (vs 5min default) and 24-hour for OpenAI (vs in-memory default). Only applies to direct API calls. See [README.md#prompt-caching](README.md#prompt-caching).
- **Configurable autocomplete height**: `autocompleteMaxVisible` setting (3-20 items, default 5) controls dropdown size. Adjust via `/settings` or `settings.json`.
- **Shell-style keybindings**: `alt+b`/`alt+f` for word navigation, `ctrl+d` for delete character forward. See [docs/keybindings.md](docs/keybindings.md).
- **RPC `get_commands`**: Headless clients can now list available commands programmatically. See [docs/rpc.md](docs/rpc.md).

### Added

- Added Hugging Face provider support via OpenAI-compatible Inference Router ([#994](https://github.com/badlogic/pi-mono/issues/994))
- Added `PI_CACHE_RETENTION` environment variable to control cache TTL for Anthropic (5m vs 1h) and OpenAI (in-memory vs 24h). Set to `long` for extended retention. ([#967](https://github.com/badlogic/pi-mono/issues/967))
- Added `autocompleteMaxVisible` setting for configurable autocomplete dropdown height (3-20 items, default 5) ([#972](https://github.com/badlogic/pi-mono/pull/972) by [@masonc15](https://github.com/masonc15))
- Added `/files` command to list all file operations (read, write, edit) in the current session
- Added shell-style keybindings: `alt+b`/`alt+f` for word navigation, `ctrl+d` for delete character forward (when editor has text) ([#1043](https://github.com/badlogic/pi-mono/issues/1043) by [@jasonish](https://github.com/jasonish))
- Added `get_commands` RPC method for headless clients to list available commands ([#995](https://github.com/badlogic/pi-mono/pull/995) by [@dnouri](https://github.com/dnouri))

### Changed

- Improved `extractCursorPosition` performance in TUI: scans lines in reverse order, early-outs when cursor is above viewport ([#1004](https://github.com/badlogic/pi-mono/pull/1004) by [@can1357](https://github.com/can1357))
- Autocomplete improvements: better handling of partial matches and edge cases ([#1024](https://github.com/badlogic/pi-mono/pull/1024) by [@Perlence](https://github.com/Perlence))

### Fixed

- External edits to `settings.json` are now preserved when pi reloads or saves unrelated settings. Previously, editing settings.json directly (e.g., removing a package from `packages` array) would be silently reverted on next pi startup when automatic setters like `setLastChangelogVersion()` triggered a save.
- Fixed custom header not displaying correctly with `quietStartup` enabled ([#1039](https://github.com/badlogic/pi-mono/pull/1039) by [@tudoroancea](https://github.com/tudoroancea))
- Empty array in package filter now disables all resources instead of falling back to manifest defaults ([#1044](https://github.com/badlogic/pi-mono/issues/1044))
- Auto-retry counter now resets after each successful LLM response instead of accumulating across tool-use turns ([#1019](https://github.com/badlogic/pi-mono/issues/1019))
- Fixed incorrect `.md` file names in warning messages ([#1041](https://github.com/badlogic/pi-mono/issues/1041) by [@llimllib](https://github.com/llimllib))
- Fixed provider name hidden in footer when terminal is narrow ([#981](https://github.com/badlogic/pi-mono/pull/981) by [@Perlence](https://github.com/Perlence))
- Fixed backslash input buffering causing delayed character display in editor ([#1037](https://github.com/badlogic/pi-mono/pull/1037) by [@Perlence](https://github.com/Perlence))
- Fixed markdown table rendering with proper row dividers and minimum column width ([#997](https://github.com/badlogic/pi-mono/pull/997) by [@tmustier](https://github.com/tmustier))
- Fixed OpenAI completions `toolChoice` handling ([#998](https://github.com/badlogic/pi-mono/pull/998) by [@williamtwomey](https://github.com/williamtwomey))
- Fixed cross-provider handoff failing when switching from OpenAI Responses API providers due to pipe-separated tool call IDs ([#1022](https://github.com/badlogic/pi-mono/issues/1022))
- Fixed 429 rate limit errors incorrectly triggering auto-compaction instead of retry with backoff ([#1038](https://github.com/badlogic/pi-mono/issues/1038))
- Fixed Anthropic provider to handle `sensitive` stop_reason returned by API ([#978](https://github.com/badlogic/pi-mono/issues/978))
- Fixed DeepSeek API compatibility by detecting `deepseek.com` URLs and disabling unsupported `developer` role ([#1048](https://github.com/badlogic/pi-mono/issues/1048))
- Fixed Anthropic provider to preserve input token counts when proxies omit them in `message_delta` events ([#1045](https://github.com/badlogic/pi-mono/issues/1045))
- Fixed `autocompleteMaxVisible` setting not persisting to `settings.json`

## [0.50.1] - 2026-01-26

### Fixed

- Git extension updates now handle force-pushed remotes gracefully instead of failing ([#961](https://github.com/badlogic/pi-mono/pull/961) by [@aliou](https://github.com/aliou))
- Extension `ctx.newSession({ setup })` now properly syncs agent state and renders messages after setup callback runs ([#968](https://github.com/badlogic/pi-mono/issues/968))
- Fixed extension UI bindings not initializing when starting with no extensions, which broke UI methods after `/reload`
- Fixed `/hotkeys` output to title-case extension hotkeys ([#969](https://github.com/badlogic/pi-mono/pull/969) by [@Perlence](https://github.com/Perlence))
- Fixed model catalog generation to exclude deprecated OpenCode Zen models ([#970](https://github.com/badlogic/pi-mono/pull/970) by [@DanielTatarkin](https://github.com/DanielTatarkin))
- Fixed git extension removal to prune empty directories

## [0.50.0] - 2026-01-26

### New Features

- Pi packages for bundling and installing extensions, skills, prompts, and themes. See [docs/packages.md](docs/packages.md).
- Hot reload (`/reload`) of resources including AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md, prompt templates, skills, themes, and extensions. See [README.md#commands](README.md#commands) and [README.md#context-files](README.md#context-files).
- Custom providers via `pi.registerProvider()` for proxies, custom endpoints, OAuth or SSO flows, and non-standard streaming APIs. See [docs/custom-provider.md](docs/custom-provider.md).
- Azure OpenAI Responses provider support with deployment-aware model mapping. See [docs/providers.md#azure-openai](docs/providers.md#azure-openai).
- OpenRouter routing support for custom models via `openRouterRouting`. See [docs/providers.md#api-keys](docs/providers.md#api-keys) and [docs/models.md](docs/models.md).
- Skill invocation messages are now collapsible and skills can opt out of model invocation via `disable-model-invocation`. See [docs/skills.md#frontmatter](docs/skills.md#frontmatter).
- Session selector renaming and configurable keybindings. See [README.md#commands](README.md#commands) and [docs/keybindings.md](docs/keybindings.md).
- `models.json` headers can resolve environment variables and shell commands. See [docs/models.md#value-resolution](docs/models.md#value-resolution).
- `--verbose` CLI flag to override quiet startup. See [README.md#cli-reference](README.md#cli-reference).

Read the fully revamped docs in `README.md`, or have your clanker read them for you.

### SDK Migration Guide

There are multiple SDK breaking changes since v0.49.3. For the quickest migration, point your agent at `packages/coding-agent/docs/sdk.md`, the SDK examples in `packages/coding-agent/examples/sdk`, and the SDK source in `packages/coding-agent/src/core/sdk.ts` and related modules.

### Breaking Changes

- Header values in `models.json` now resolve environment variables (if a header value matches an env var name, the env var value is used). This may change behavior if a literal header value accidentally matches an env var name. ([#909](https://github.com/badlogic/pi-mono/issues/909))
- External packages (npm/git) are now configured via `packages` array in settings.json instead of `extensions`. Existing npm:/git: entries in `extensions` are auto-migrated. ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Resource loading now uses `ResourceLoader` only and settings.json uses arrays for extensions, skills, prompts, and themes ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Removed `discoverAuthStorage` and `discoverModels` from the SDK. `AuthStorage` and `ModelRegistry` now default to `~/.pi/agent` paths unless you pass an `agentDir` ([#645](https://github.com/badlogic/pi-mono/issues/645))

### Added

- Session renaming in `/resume` picker via `Ctrl+R` without opening the session ([#863](https://github.com/badlogic/pi-mono/pull/863) by [@svkozak](https://github.com/svkozak))
- Session selector keybindings are now configurable ([#948](https://github.com/badlogic/pi-mono/pull/948) by [@aos](https://github.com/aos))
- `disable-model-invocation` frontmatter field for skills to prevent agentic invocation while still allowing explicit `/skill:name` commands ([#927](https://github.com/badlogic/pi-mono/issues/927))
- Exposed `copyToClipboard` utility for extensions ([#926](https://github.com/badlogic/pi-mono/issues/926) by [@mitsuhiko](https://github.com/mitsuhiko))
- Skill invocation messages are now collapsible in chat output, showing collapsed by default with skill name and expand hint ([#894](https://github.com/badlogic/pi-mono/issues/894))
- Header values in `models.json` now support environment variables and shell commands, matching `apiKey` resolution ([#909](https://github.com/badlogic/pi-mono/issues/909))
- Added HTTP proxy environment variable support for API requests ([#942](https://github.com/badlogic/pi-mono/pull/942) by [@haoqixu](https://github.com/haoqixu))
- Added OpenRouter provider routing support for custom models via `openRouterRouting` compat field ([#859](https://github.com/badlogic/pi-mono/pull/859) by [@v01dpr1mr0s3](https://github.com/v01dpr1mr0s3))
- Added `azure-openai-responses` provider support for Azure OpenAI Responses API. ([#890](https://github.com/badlogic/pi-mono/pull/890) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Added changelog link to update notifications ([#925](https://github.com/badlogic/pi-mono/pull/925) by [@dannote](https://github.com/dannote))
- Added `--verbose` CLI flag to override quietStartup setting ([#906](https://github.com/badlogic/pi-mono/pull/906) by [@Perlence](https://github.com/Perlence))
- `markdown.codeBlockIndent` setting to customize code block indentation in rendered output
- Extension package management with `pi install`, `pi remove`, `pi update`, and `pi list` commands ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Package filtering: selectively load resources from packages using object form in `packages` array ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Glob pattern support with minimatch in package filters, top-level settings arrays, and pi manifest (e.g., `"!funky.json"`, `"*.ts"`) ([#645](https://github.com/badlogic/pi-mono/issues/645))
- `/reload` command to reload extensions, skills, prompts, and themes ([#645](https://github.com/badlogic/pi-mono/issues/645))
- `pi config` command with TUI to enable/disable package and top-level resources via patterns ([#938](https://github.com/badlogic/pi-mono/issues/938))
- CLI flags for `--skill`, `--prompt-template`, `--theme`, `--no-prompt-templates`, and `--no-themes` ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Package deduplication: if same package appears in global and project settings, project wins ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Unified collision reporting with `ResourceDiagnostic` type for all resource types ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Show provider alongside the model in the footer if multiple providers are available
- Custom provider support via `pi.registerProvider()` with `streamSimple` for custom API implementations
- Added `custom-provider.ts` example extension demonstrating custom Anthropic provider with OAuth

### Changed

- `/resume` picker sort toggle moved to `Ctrl+S` to free `Ctrl+R` for rename ([#863](https://github.com/badlogic/pi-mono/pull/863) by [@svkozak](https://github.com/svkozak))
- HTML export: clicking a sidebar message now navigates to its newest leaf and scrolls to it, instead of truncating the branch ([#853](https://github.com/badlogic/pi-mono/pull/853) by [@mitsuhiko](https://github.com/mitsuhiko))
- HTML export: active path is now visually highlighted with dimmed off-path nodes ([#929](https://github.com/badlogic/pi-mono/pull/929) by [@hewliyang](https://github.com/hewliyang))
- Azure OpenAI Responses provider now uses base URL configuration with deployment-aware model mapping and no longer includes service tier handling
- `/reload` now re-renders the entire scrollback so updated extension components are visible immediately ([#928](https://github.com/badlogic/pi-mono/pull/928) by [@ferologics](https://github.com/ferologics))
- Skill, prompt template, and theme discovery now use settings and CLI path arrays instead of legacy filters ([#645](https://github.com/badlogic/pi-mono/issues/645))

### Fixed

- Extension `setWorkingMessage()` calls in `agent_start` handlers now work correctly; previously the message was silently ignored because the loading animation didn't exist yet ([#935](https://github.com/badlogic/pi-mono/issues/935))
- Fixed package auto-discovery to respect loader rules, config overrides, and force-exclude patterns
- Fixed /reload restoring the correct editor after reload ([#949](https://github.com/badlogic/pi-mono/pull/949) by [@Perlence](https://github.com/Perlence))
- Fixed distributed themes breaking `/export` ([#946](https://github.com/badlogic/pi-mono/pull/946) by [@mitsuhiko](https://github.com/mitsuhiko))
- Fixed startup hints to clarify thinking level selection and expanded thinking guidance
- Fixed SDK initial model resolution to use `findInitialModel` and default to Claude Opus 4.5 for Anthropic models
- Fixed no-models warning to include the `/model` instruction
- Fixed authentication error messages to point to the authentication documentation
- Fixed bash output hint lines to truncate to terminal width
- Fixed custom editors to honor the `paddingX` setting ([#936](https://github.com/badlogic/pi-mono/pull/936) by [@Perlence](https://github.com/Perlence))
- Fixed system prompt tool list to show only built-in tools
- Fixed package manager to check npm package versions before using cached copies
- Fixed package manager to run `npm install` after cloning git repositories with a package.json
- Fixed extension provider registrations to apply before model resolution
- Fixed editor multi-line insertion handling and lastAction tracking ([#945](https://github.com/badlogic/pi-mono/pull/945) by [@Perlence](https://github.com/Perlence))
- Fixed editor word wrapping to reserve a cursor column ([#934](https://github.com/badlogic/pi-mono/pull/934) by [@Perlence](https://github.com/Perlence))
- Fixed editor word wrapping to use single-pass backtracking for whitespace handling ([#924](https://github.com/badlogic/pi-mono/pull/924) by [@Perlence](https://github.com/Perlence))
- Fixed Kitty image ID allocation and cleanup to prevent image ID collisions
- Fixed overlays staying centered after terminal resizes ([#950](https://github.com/badlogic/pi-mono/pull/950) by [@nicobailon](https://github.com/nicobailon))
- Fixed streaming dispatch to use the model api type instead of hardcoded API defaults
- Fixed Google providers to default tool call arguments to an empty object when omitted
- Fixed OpenAI Responses streaming to handle `arguments.done` events on OpenAI-compatible endpoints ([#917](https://github.com/badlogic/pi-mono/pull/917) by [@williballenthin](https://github.com/williballenthin))
- Fixed OpenAI Codex Responses tool strictness handling after the shared responses refactor
- Fixed Azure OpenAI Responses streaming to guard deltas before content parts and correct metadata and handoff gating
- Fixed OpenAI completions tool-result image batching after consecutive tool results ([#902](https://github.com/badlogic/pi-mono/pull/902) by [@terrorobe](https://github.com/terrorobe))
- Off-by-one error in bash output "earlier lines" count caused by counting spacing newline as hidden content ([#921](https://github.com/badlogic/pi-mono/issues/921))
- User package filters now layer on top of manifest filters instead of replacing them ([#645](https://github.com/badlogic/pi-mono/issues/645))
- Auto-retry now handles "terminated" errors from Codex API mid-stream failures
- Follow-up queue (Alt+Enter) now sends full paste content instead of `[paste #N ...]` markers ([#912](https://github.com/badlogic/pi-mono/issues/912))
- Fixed Alt-Up not restoring messages queued during compaction ([#923](https://github.com/badlogic/pi-mono/pull/923) by [@aliou](https://github.com/aliou))
- Fixed session corruption when loading empty or invalid session files via `--session` flag ([#932](https://github.com/badlogic/pi-mono/issues/932) by [@armanddp](https://github.com/armanddp))
- Fixed extension shortcuts not firing when extension also uses `setEditorComponent()` ([#947](https://github.com/badlogic/pi-mono/pull/947) by [@Perlence](https://github.com/Perlence))
- Session "modified" time now uses last message timestamp instead of file mtime, so renaming doesn't reorder the recent list ([#863](https://github.com/badlogic/pi-mono/pull/863) by [@svkozak](https://github.com/svkozak))

## [0.49.3] - 2026-01-22

### Added

- `markdown.codeBlockIndent` setting to customize code block indentation in rendered output ([#855](https://github.com/badlogic/pi-mono/pull/855) by [@terrorobe](https://github.com/terrorobe))
- Added `inline-bash.ts` example extension for expanding `!{command}` patterns in prompts ([#881](https://github.com/badlogic/pi-mono/pull/881) by [@scutifer](https://github.com/scutifer))
- Added `antigravity-image-gen.ts` example extension for AI image generation via Google Antigravity ([#893](https://github.com/badlogic/pi-mono/pull/893) by [@ben-vargas](https://github.com/ben-vargas))
- Added `PI_SHARE_VIEWER_URL` environment variable for custom share viewer URLs ([#889](https://github.com/badlogic/pi-mono/pull/889) by [@andresaraujo](https://github.com/andresaraujo))
- Added Alt+Delete as hotkey for delete word forwards ([#878](https://github.com/badlogic/pi-mono/pull/878) by [@Perlence](https://github.com/Perlence))

### Changed

- Tree selector: changed label filter shortcut from `l` to `Shift+L` so users can search for entries containing "l" ([#861](https://github.com/badlogic/pi-mono/pull/861) by [@mitsuhiko](https://github.com/mitsuhiko))
- Fuzzy matching now scores consecutive matches higher for better search relevance ([#860](https://github.com/badlogic/pi-mono/pull/860) by [@mitsuhiko](https://github.com/mitsuhiko))

### Fixed

- Fixed error messages showing hardcoded `~/.pi/agent/` paths instead of respecting `PI_CODING_AGENT_DIR` ([#887](https://github.com/badlogic/pi-mono/pull/887) by [@aliou](https://github.com/aliou))
- Fixed `write` tool not displaying errors in the UI when execution fails ([#856](https://github.com/badlogic/pi-mono/issues/856))
- Fixed HTML export using default theme instead of user's active theme ([#870](https://github.com/badlogic/pi-mono/pull/870) by [@scutifer](https://github.com/scutifer))
- Show session name in the footer and terminal / tab title ([#876](https://github.com/badlogic/pi-mono/pull/876) by [@scutifer](https://github.com/scutifer))
- Fixed 256color fallback in Terminal.app to prevent color rendering issues ([#869](https://github.com/badlogic/pi-mono/pull/869) by [@Perlence](https://github.com/Perlence))
- Fixed viewport tracking and cursor positioning for overlays and content shrink scenarios
- Fixed autocomplete to allow searches with `/` characters (e.g., `folder1/folder2`) ([#882](https://github.com/badlogic/pi-mono/pull/882) by [@richardgill](https://github.com/richardgill))
- Fixed autolinked emails displaying redundant `(mailto:...)` suffix ([#888](https://github.com/badlogic/pi-mono/pull/888) by [@terrorobe](https://github.com/terrorobe))
- Fixed `@` file autocomplete adding space after directories, breaking continued autocomplete into subdirectories

## [0.49.2] - 2026-01-19

### Added

- Added widget placement option for extension widgets via `widgetPlacement` in `pi.addWidget()` ([#850](https://github.com/badlogic/pi-mono/pull/850) by [@marckrenn](https://github.com/marckrenn))
- Added AWS credential detection for ECS/Kubernetes environments: `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE` ([#848](https://github.com/badlogic/pi-mono/issues/848))
- Add "quiet startup" setting to `/settings` ([#847](https://github.com/badlogic/pi-mono/pull/847) by [@unexge](https://github.com/unexge))

### Changed

- HTML export now includes JSONL download button, jump-to-last-message on click, and fixed missing labels ([#853](https://github.com/badlogic/pi-mono/pull/853) by [@mitsuhiko](https://github.com/mitsuhiko))
- Improved error message for OAuth authentication failures (expired credentials, offline) instead of generic 'No API key found' ([#849](https://github.com/badlogic/pi-mono/pull/849) by [@zedrdave](https://github.com/zedrdave))

### Fixed
- Fixed `/model` selector scope toggle so you can switch between all and scoped models when scoped models are saved ([#844](https://github.com/badlogic/pi-mono/issues/844))
- Fixed OpenAI Responses 400 error "reasoning without following item" when replaying aborted turns ([#838](https://github.com/badlogic/pi-mono/pull/838))
- Fixed pi exiting with code 0 when cancelling resume session selection

### Removed

- Removed `strictResponsesPairing` compat option from models.json schema (no longer needed)

## [0.49.1] - 2026-01-18

### Added

- Added `strictResponsesPairing` compat option for custom OpenAI Responses models on Azure ([#768](https://github.com/badlogic/pi-mono/pull/768) by [@prateekmedia](https://github.com/prateekmedia))
- Session selector (`/resume`) now supports path display toggle (`Ctrl+P`) and session deletion (`Ctrl+D`) with inline confirmation ([#816](https://github.com/badlogic/pi-mono/pull/816) by [@w-winter](https://github.com/w-winter))
- Added undo support in interactive mode with Ctrl+- hotkey. ([#831](https://github.com/badlogic/pi-mono/pull/831) by [@Perlence](https://github.com/Perlence))

### Changed

- Share URLs now use hash fragments (`#`) instead of query strings (`?`) to prevent session IDs from being sent to buildwithpi.ai ([#829](https://github.com/badlogic/pi-mono/pull/829) by [@terrorobe](https://github.com/terrorobe))
- API keys in `models.json` can now be retrieved via shell command using `!` prefix (e.g., `"apiKey": "!security find-generic-password -ws 'anthropic'"` for macOS Keychain) ([#762](https://github.com/badlogic/pi-mono/pull/762) by [@cv](https://github.com/cv))

### Fixed

- Fixed IME candidate window appearing in wrong position when filtering menus with Input Method Editor (e.g., Chinese IME). Components with search inputs now properly propagate focus state for cursor positioning. ([#827](https://github.com/badlogic/pi-mono/issues/827))
- Fixed extension shortcut conflicts to respect user keybindings when built-in actions are remapped. ([#826](https://github.com/badlogic/pi-mono/pull/826) by [@richardgill](https://github.com/richardgill))
- Fixed photon WASM loading in standalone compiled binaries.
- Fixed tool call ID normalization for cross-provider handoffs (e.g., Codex to Antigravity Claude) ([#821](https://github.com/badlogic/pi-mono/issues/821))

## [0.49.0] - 2026-01-17

### Added

- `pi.setLabel(entryId, label)` in ExtensionAPI for setting per-entry labels from extensions ([#806](https://github.com/badlogic/pi-mono/issues/806))
- Export `keyHint`, `appKeyHint`, `editorKey`, `appKey`, `rawKeyHint` for extensions to format keybinding hints consistently ([#802](https://github.com/badlogic/pi-mono/pull/802) by [@dannote](https://github.com/dannote))
- Exported `VERSION` from the package index and updated the custom-header example. ([#798](https://github.com/badlogic/pi-mono/pull/798) by [@tallshort](https://github.com/tallshort))
- Added `showHardwareCursor` setting to control cursor visibility while still positioning it for IME support. ([#800](https://github.com/badlogic/pi-mono/pull/800) by [@ghoulr](https://github.com/ghoulr))
- Added Emacs-style kill ring editing with yank and yank-pop keybindings, plus legacy Alt+letter handling and Alt+D delete word forward support in the interactive editor. ([#810](https://github.com/badlogic/pi-mono/pull/810) by [@Perlence](https://github.com/Perlence))
- Added `ctx.compact()` and `ctx.getContextUsage()` to extension contexts for programmatic compaction and context usage checks.
- Added documentation for delete word forward and kill ring keybindings in interactive mode. ([#810](https://github.com/badlogic/pi-mono/pull/810) by [@Perlence](https://github.com/Perlence))

### Changed

- Updated the default system prompt wording to clarify the pi harness and documentation scope.
- Simplified Codex system prompt handling to use the default system prompt directly for Codex instructions.

### Fixed

- Fixed photon module failing to load in ESM context with "require is not defined" error ([#795](https://github.com/badlogic/pi-mono/pull/795) by [@dannote](https://github.com/dannote))
- Fixed compaction UI not showing when extensions trigger compaction.
- Fixed orphaned tool results after errored assistant messages causing Codex API errors. When an assistant message has `stopReason: "error"`, its tool calls are now excluded from pending tool tracking, preventing synthetic tool results from being generated for calls that will be dropped by provider-specific converters. ([#812](https://github.com/badlogic/pi-mono/issues/812))
- Fixed Bedrock Claude max_tokens handling to always exceed thinking budget tokens, preventing compaction failures. ([#797](https://github.com/badlogic/pi-mono/pull/797) by [@pjtf93](https://github.com/pjtf93))
- Fixed Claude Code tool name normalization to match the Claude Code tool list case-insensitively and remove invalid mappings.

### Removed

- Removed `pi-internal://` path resolution from the read tool.

## [0.48.0] - 2026-01-16

### Added

- Added `quietStartup` setting to silence startup output (version header, loaded context info, model scope line). Changelog notifications are still shown. ([#777](https://github.com/badlogic/pi-mono/pull/777) by [@ribelo](https://github.com/ribelo))
- Added `editorPaddingX` setting for horizontal padding in input editor (0-3, default: 0)
- Added `shellCommandPrefix` setting to prepend commands to every bash execution, enabling alias expansion in non-interactive shells (e.g., `"shellCommandPrefix": "shopt -s expand_aliases"`) ([#790](https://github.com/badlogic/pi-mono/pull/790) by [@richardgill](https://github.com/richardgill))
- Added bash-style argument slicing for prompt templates ([#770](https://github.com/badlogic/pi-mono/pull/770) by [@airtonix](https://github.com/airtonix))
- Extension commands can provide argument auto-completions via `getArgumentCompletions` in `pi.registerCommand()` ([#775](https://github.com/badlogic/pi-mono/pull/775) by [@ribelo](https://github.com/ribelo))
- Bash tool now displays the timeout value in the UI when a timeout is set ([#780](https://github.com/badlogic/pi-mono/pull/780) by [@dannote](https://github.com/dannote))
- Export `getShellConfig` for extensions to detect user's shell environment ([#766](https://github.com/badlogic/pi-mono/pull/766) by [@dannote](https://github.com/dannote))
- Added `thinkingText` and `selectedBg` to theme schema ([#763](https://github.com/badlogic/pi-mono/pull/763) by [@scutifer](https://github.com/scutifer))
- `navigateTree()` now supports `replaceInstructions` option to replace the default summarization prompt entirely, and `label` option to attach a label to the branch summary entry ([#787](https://github.com/badlogic/pi-mono/pull/787) by [@mitsuhiko](https://github.com/mitsuhiko))

### Fixed

- Fixed crash during auto-compaction when summarization fails (e.g., quota exceeded). Now displays error message instead of crashing ([#792](https://github.com/badlogic/pi-mono/issues/792))
- Fixed `--session <UUID>` to search globally across projects if not found locally, with option to fork sessions from other projects ([#785](https://github.com/badlogic/pi-mono/pull/785) by [@ribelo](https://github.com/ribelo))
- Fixed standalone binary WASM loading on Linux ([#784](https://github.com/badlogic/pi-mono/issues/784))
- Fixed string numbers in tool arguments not being coerced to numbers during validation ([#786](https://github.com/badlogic/pi-mono/pull/786) by [@dannote](https://github.com/dannote))
- Fixed `--no-extensions` flag not preventing extension discovery ([#776](https://github.com/badlogic/pi-mono/issues/776))
- Fixed extension messages rendering twice on startup when `pi.sendMessage({ display: true })` is called during `session_start` ([#765](https://github.com/badlogic/pi-mono/pull/765) by [@dannote](https://github.com/dannote))
- Fixed `PI_CODING_AGENT_DIR` env var not expanding tilde (`~`) to home directory ([#778](https://github.com/badlogic/pi-mono/pull/778) by [@aliou](https://github.com/aliou))
- Fixed session picker hint text overflow ([#764](https://github.com/badlogic/pi-mono/issues/764))
- Fixed Kitty keyboard protocol shifted symbol keys (e.g., `@`, `?`) not working in editor ([#779](https://github.com/badlogic/pi-mono/pull/779) by [@iamd3vil](https://github.com/iamd3vil))
- Fixed Bedrock tool call IDs causing API errors from invalid characters ([#781](https://github.com/badlogic/pi-mono/pull/781) by [@pjtf93](https://github.com/pjtf93))

### Changed

- Hardware cursor is now disabled by default for better terminal compatibility. Set `PI_HARDWARE_CURSOR=1` to enable (replaces `PI_NO_HARDWARE_CURSOR=1` which disabled it).

## [0.47.0] - 2026-01-16

### Breaking Changes

- Extensions using `Editor` directly must now pass `TUI` as the first constructor argument: `new Editor(tui, theme)`. The `tui` parameter is available in extension factory functions. ([#732](https://github.com/badlogic/pi-mono/issues/732))

### Added

- **OpenAI Codex official support**: Full compatibility with OpenAI's Codex CLI models (`gpt-5.1`, `gpt-5.2`, `gpt-5.1-codex-mini`, `gpt-5.2-codex`). Features include static system prompt for OpenAI allowlisting, prompt caching via session ID, and reasoning signature retention across turns. Set `OPENAI_API_KEY` and use `--provider openai-codex` or select a Codex model. ([#737](https://github.com/badlogic/pi-mono/pull/737))
- `pi-internal://` URL scheme in read tool for accessing internal documentation. The model can read files from the coding-agent package (README, docs, examples) to learn about extending pi.
- New `input` event in extension system for intercepting, transforming, or handling user input before the agent processes it. Supports three result types: `continue` (pass through), `transform` (modify text/images), `handled` (respond without LLM). Handlers chain transforms and short-circuit on handled. ([#761](https://github.com/badlogic/pi-mono/pull/761) by [@nicobailon](https://github.com/nicobailon))
- Extension example: `input-transform.ts` demonstrating input interception patterns (quick mode, instant commands, source routing) ([#761](https://github.com/badlogic/pi-mono/pull/761) by [@nicobailon](https://github.com/nicobailon))
- Custom tool HTML export: extensions with `renderCall`/`renderResult` now render in `/share` and `/export` output with ANSI-to-HTML color conversion ([#702](https://github.com/badlogic/pi-mono/pull/702) by [@aliou](https://github.com/aliou))
- Direct filter shortcuts in Tree mode: Ctrl+D (default), Ctrl+T (no-tools), Ctrl+U (user-only), Ctrl+L (labeled-only), Ctrl+A (all) ([#747](https://github.com/badlogic/pi-mono/pull/747) by [@kaofelix](https://github.com/kaofelix))

### Changed

- Skill commands (`/skill:name`) are now expanded in AgentSession instead of interactive mode. This enables skill commands in RPC and print modes, and allows the `input` event to intercept `/skill:name` before expansion.

### Fixed

- Editor no longer corrupts terminal display when loading large prompts via `setEditorText`. Content now scrolls vertically with indicators showing lines above/below the viewport. ([#732](https://github.com/badlogic/pi-mono/issues/732))
- Piped stdin now works correctly: `echo foo | pi` is equivalent to `pi -p foo`. When stdin is piped, print mode is automatically enabled since interactive mode requires a TTY ([#708](https://github.com/badlogic/pi-mono/issues/708))
- Session tree now preserves branch connectors and indentation when filters hide intermediate entries so descendants attach to the nearest visible ancestor and sibling branches align. Fixed in both TUI and HTML export ([#739](https://github.com/badlogic/pi-mono/pull/739) by [@w-winter](https://github.com/w-winter))
- Added `upstream connect`, `connection refused`, and `reset before headers` patterns to auto-retry error detection ([#733](https://github.com/badlogic/pi-mono/issues/733))
- Multi-line YAML frontmatter in skills and prompt templates now parses correctly. Centralized frontmatter parsing using the `yaml` library. ([#728](https://github.com/badlogic/pi-mono/pull/728) by [@richardgill](https://github.com/richardgill))
- `ctx.shutdown()` now waits for pending UI renders to complete before exiting, ensuring notifications and final output are visible ([#756](https://github.com/badlogic/pi-mono/issues/756))
- OpenAI Codex provider now retries on transient errors (429, 5xx, connection failures) with exponential backoff ([#733](https://github.com/badlogic/pi-mono/issues/733))

## [0.46.0] - 2026-01-15

### Fixed

- Scoped models (`--models` or `enabledModels`) now remember the last selected model across sessions instead of always starting with the first model in the scope ([#736](https://github.com/badlogic/pi-mono/pull/736) by [@ogulcancelik](https://github.com/ogulcancelik))
- Show `bun install` instead of `npm install` in update notification when running under Bun ([#714](https://github.com/badlogic/pi-mono/pull/714) by [@dannote](https://github.com/dannote))
- `/skill` prompts now include the skill path ([#711](https://github.com/badlogic/pi-mono/pull/711) by [@jblwilliams](https://github.com/jblwilliams))
- Use configurable `expandTools` keybinding instead of hardcoded Ctrl+O ([#717](https://github.com/badlogic/pi-mono/pull/717) by [@dannote](https://github.com/dannote))
- Compaction turn prefix summaries now merge correctly ([#738](https://github.com/badlogic/pi-mono/pull/738) by [@vsabavat](https://github.com/vsabavat))
- Avoid unsigned Gemini 3 tool calls ([#741](https://github.com/badlogic/pi-mono/pull/741) by [@roshanasingh4](https://github.com/roshanasingh4))
- Fixed signature support for non-Anthropic models in Amazon Bedrock provider ([#727](https://github.com/badlogic/pi-mono/pull/727) by [@unexge](https://github.com/unexge))
- Keyboard shortcuts (Ctrl+C, Ctrl+D, etc.) now work on non-Latin keyboard layouts (Russian, Ukrainian, Bulgarian, etc.) in terminals supporting Kitty keyboard protocol with alternate key reporting ([#718](https://github.com/badlogic/pi-mono/pull/718) by [@dannote](https://github.com/dannote))

### Added

- Edit tool now uses fuzzy matching as fallback when exact match fails, tolerating trailing whitespace, smart quotes, Unicode dashes, and special spaces ([#713](https://github.com/badlogic/pi-mono/pull/713) by [@dannote](https://github.com/dannote))
- Support `APPEND_SYSTEM.md` to append instructions to the system prompt ([#716](https://github.com/badlogic/pi-mono/pull/716) by [@tallshort](https://github.com/tallshort))
- Session picker search: Ctrl+R toggles sorting between fuzzy match (default) and most recent; supports quoted phrase matching and `re:` regex mode ([#731](https://github.com/badlogic/pi-mono/pull/731) by [@ogulcancelik](https://github.com/ogulcancelik))
- Export `getAgentDir` for extensions ([#749](https://github.com/badlogic/pi-mono/pull/749) by [@dannote](https://github.com/dannote))
- Show loaded prompt templates on startup ([#743](https://github.com/badlogic/pi-mono/pull/743) by [@tallshort](https://github.com/tallshort))
- MiniMax China (`minimax-cn`) provider support ([#725](https://github.com/badlogic/pi-mono/pull/725) by [@tallshort](https://github.com/tallshort))
- `gpt-5.2-codex` models for GitHub Copilot and OpenCode Zen providers ([#734](https://github.com/badlogic/pi-mono/pull/734) by [@aadishv](https://github.com/aadishv))

### Changed

- Replaced `wasm-vips` with `@silvia-odwyer/photon-node` for image processing ([#710](https://github.com/badlogic/pi-mono/pull/710) by [@can1357](https://github.com/can1357))
- Extension example: `plan-mode/` shortcut changed from Shift+P to Ctrl+Alt+P to avoid conflict with typing capital P ([#746](https://github.com/badlogic/pi-mono/pull/746) by [@ferologics](https://github.com/ferologics))
- UI keybinding hints now respect configured keybindings across components ([#724](https://github.com/badlogic/pi-mono/pull/724) by [@dannote](https://github.com/dannote))
- CLI process title is now set to `pi` for easier process identification ([#742](https://github.com/badlogic/pi-mono/pull/742) by [@richardgill](https://github.com/richardgill))

## [0.45.7] - 2026-01-13

### Added

- Exported `highlightCode` and `getLanguageFromPath` for extensions ([#703](https://github.com/badlogic/pi-mono/pull/703) by [@dannote](https://github.com/dannote))

## [0.45.6] - 2026-01-13

### Added

- `ctx.ui.custom()` now accepts `overlayOptions` for overlay positioning and sizing (anchor, margins, offsets, percentages, absolute positioning) ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))
- `ctx.ui.custom()` now accepts `onHandle` callback to receive the `OverlayHandle` for controlling overlay visibility ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))
- Extension example: `overlay-qa-tests.ts` with 10 commands for testing overlay positioning, animation, and toggle scenarios ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))
- Extension example: `doom-overlay/` - DOOM game running as an overlay at 35 FPS (auto-downloads WAD on first run) ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))

## [0.45.5] - 2026-01-13

### Fixed

- Skip changelog display on fresh install (only show on upgrades)

## [0.45.4] - 2026-01-13

### Changed

- Light theme colors adjusted for WCAG AA compliance (4.5:1 contrast ratio against white backgrounds)
- Replaced `sharp` with `wasm-vips` for image processing (resize, PNG conversion). Eliminates native build requirements that caused installation failures on some systems. ([#696](https://github.com/badlogic/pi-mono/issues/696))

### Added

- Extension example: `summarize.ts` for summarizing conversations using custom UI and an external model ([#684](https://github.com/badlogic/pi-mono/pull/684) by [@scutifer](https://github.com/scutifer))
- Extension example: `question.ts` enhanced with custom UI for asking user questions ([#693](https://github.com/badlogic/pi-mono/pull/693) by [@ferologics](https://github.com/ferologics))
- Extension example: `plan-mode/` enhanced with explicit step tracking and progress widget ([#694](https://github.com/badlogic/pi-mono/pull/694) by [@ferologics](https://github.com/ferologics))
- Extension example: `questionnaire.ts` for multi-question input with tab bar navigation ([#695](https://github.com/badlogic/pi-mono/pull/695) by [@ferologics](https://github.com/ferologics))
- Experimental Vercel AI Gateway provider support: set `AI_GATEWAY_API_KEY` and use `--provider vercel-ai-gateway`. Token usage is currently reported incorrectly by Anthropic Messages compatible endpoint. ([#689](https://github.com/badlogic/pi-mono/pull/689) by [@timolins](https://github.com/timolins))

### Fixed

- Fix API key resolution after model switches by using provider argument ([#691](https://github.com/badlogic/pi-mono/pull/691) by [@joshp123](https://github.com/joshp123))
- Fixed z.ai thinking/reasoning: thinking toggle now correctly enables/disables thinking for z.ai models ([#688](https://github.com/badlogic/pi-mono/issues/688))
- Fixed extension loading in compiled Bun binary: extensions with local file imports now work correctly. Updated `@mariozechner/jiti` to v2.6.5 which bundles babel for Bun binary compatibility. ([#681](https://github.com/badlogic/pi-mono/issues/681))
- Fixed theme loading when installed via mise: use wrapper directory in release tarballs for compatibility with mise's `strip_components=1` extraction. ([#681](https://github.com/badlogic/pi-mono/issues/681))

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

### Fixed

- Extensions now load correctly in compiled Bun binary using `@mariozechner/jiti` fork with `virtualModules` support. Bundled packages (`@sinclair/typebox`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`) are accessible to extensions without filesystem node_modules.

## [0.45.1] - 2026-01-13

### Changed

- `/share` now outputs `buildwithpi.ai` session preview URLs instead of `pi.dev`

## [0.45.0] - 2026-01-13

### Added

- MiniMax provider support: set `MINIMAX_API_KEY` and use `minimax/MiniMax-M2.1` ([#656](https://github.com/badlogic/pi-mono/pull/656) by [@dannote](https://github.com/dannote))
- `/scoped-models`: Alt+Up/Down to reorder enabled models. Order is preserved when saving with Ctrl+S and determines Ctrl+P cycling order. ([#676](https://github.com/badlogic/pi-mono/pull/676) by [@thomasmhr](https://github.com/thomasmhr))
- Amazon Bedrock provider support (experimental, tested with Anthropic Claude models only) ([#494](https://github.com/badlogic/pi-mono/pull/494) by [@unexge](https://github.com/unexge))
- Extension example: `sandbox/` for OS-level bash sandboxing using `@anthropic-ai/sandbox-runtime` with per-project config ([#673](https://github.com/badlogic/pi-mono/pull/673) by [@dannote](https://github.com/dannote))
- Print mode JSON output now emits the session header as the first line.

## [0.44.0] - 2026-01-12

### Breaking Changes

- `pi.getAllTools()` now returns `ToolInfo[]` (with `name` and `description`) instead of `string[]`. Extensions that only need names can use `.map(t => t.name)`. ([#648](https://github.com/badlogic/pi-mono/pull/648) by [@carsonfarmer](https://github.com/carsonfarmer))

### Added

- Session naming: `/name <name>` command sets a display name shown in the session selector instead of the first message. Useful for distinguishing forked sessions. Extensions can use `pi.setSessionName()` and `pi.getSessionName()`. ([#650](https://github.com/badlogic/pi-mono/pull/650) by [@scutifer](https://github.com/scutifer))
- Extension example: `notify.ts` for desktop notifications via OSC 777 escape sequence ([#658](https://github.com/badlogic/pi-mono/pull/658) by [@ferologics](https://github.com/ferologics))
- Inline hint for queued messages showing the `Alt+Up` restore shortcut ([#657](https://github.com/badlogic/pi-mono/pull/657) by [@tmustier](https://github.com/tmustier))
- Page-up/down navigation in `/resume` session selector to jump by 5 items ([#662](https://github.com/badlogic/pi-mono/pull/662) by [@aliou](https://github.com/aliou))
- Fuzzy search in `/settings` menu: type to filter settings by label ([#643](https://github.com/badlogic/pi-mono/pull/643) by [@ninlds](https://github.com/ninlds))

### Fixed

- Session selector now stays open when current folder has no sessions, allowing Tab to switch to "all" scope ([#661](https://github.com/badlogic/pi-mono/pull/661) by [@aliou](https://github.com/aliou))
- Extensions using theme utilities like `getSettingsListTheme()` now work in dev mode with tsx

## [0.43.0] - 2026-01-11

### Breaking Changes

- Extension editor (`ctx.ui.editor()`) now uses Enter to submit and Shift+Enter for newlines, matching the main editor. Previously used Ctrl+Enter to submit. Extensions with hardcoded "ctrl+enter" hints need updating. ([#642](https://github.com/badlogic/pi-mono/pull/642) by [@mitsuhiko](https://github.com/mitsuhiko))
- Renamed `/branch` command to `/fork` ([#641](https://github.com/badlogic/pi-mono/issues/641))
  - RPC: `branch` → `fork`, `get_branch_messages` → `get_fork_messages`
  - SDK: `branch()` → `fork()`, `getBranchMessages()` → `getForkMessages()`
  - AgentSession: `branch()` → `fork()`, `getUserMessagesForBranching()` → `getUserMessagesForForking()`
  - Extension events: `session_before_branch` → `session_before_fork`, `session_branch` → `session_fork`
  - Settings: `doubleEscapeAction: "branch" | "tree"` → `"fork" | "tree"`
- `SessionManager.list()` and `SessionManager.listAll()` are now async, returning `Promise<SessionInfo[]>`. Callers must await them. ([#620](https://github.com/badlogic/pi-mono/pull/620) by [@tmustier](https://github.com/tmustier))

### Added
- `/resume` selector now toggles between current-folder and all sessions with Tab, showing the session cwd in the All view and loading progress. ([#620](https://github.com/badlogic/pi-mono/pull/620) by [@tmustier](https://github.com/tmustier))
- `SessionManager.list()` and `SessionManager.listAll()` accept optional `onProgress` callback for progress updates
- `SessionInfo.cwd` field containing the session's working directory (empty string for old sessions)
- `SessionListProgress` type export for progress callbacks
- `/scoped-models` command to enable/disable models for Ctrl+P cycling. Changes are session-only by default; press Ctrl+S to persist to settings.json. ([#626](https://github.com/badlogic/pi-mono/pull/626) by [@CarlosGtrz](https://github.com/CarlosGtrz))
- `model_select` extension hook fires when model changes via `/model`, model cycling, or session restore with `source` field and `previousModel` ([#628](https://github.com/badlogic/pi-mono/pull/628) by [@marckrenn](https://github.com/marckrenn))
- `ctx.ui.setWorkingMessage()` extension API to customize the "Working..." message during streaming ([#625](https://github.com/badlogic/pi-mono/pull/625) by [@nicobailon](https://github.com/nicobailon))
- Skill slash commands: loaded skills are registered as `/skill:name` commands for quick access. Toggle via `/settings` or `skills.enableSkillCommands` in settings.json. ([#630](https://github.com/badlogic/pi-mono/pull/630) by [@Dwsy](https://github.com/Dwsy))
- Slash command autocomplete now uses fuzzy matching (type `/skbra` to match `/skill:brave-search`)
- `/tree` branch summarization now offers three options: "No summary", "Summarize", and "Summarize with custom prompt". Custom prompts are appended as additional focus to the default summarization instructions. ([#642](https://github.com/badlogic/pi-mono/pull/642) by [@mitsuhiko](https://github.com/mitsuhiko))

### Fixed

- Missing spacer between assistant message and text editor ([#655](https://github.com/badlogic/pi-mono/issues/655))
- Session picker respects custom keybindings when using `--resume` ([#633](https://github.com/badlogic/pi-mono/pull/633) by [@aos](https://github.com/aos))
- Custom footer extensions now see model changes: `ctx.model` is now a getter that returns the current model instead of a snapshot from when the context was created ([#634](https://github.com/badlogic/pi-mono/pull/634) by [@ogulcancelik](https://github.com/ogulcancelik))
- Footer git branch not updating after external branch switches. Git uses atomic writes (temp file + rename), which changes the inode and breaks `fs.watch` on the file. Now watches the directory instead.
- Extension loading errors are now displayed to the user instead of being silently ignored ([#639](https://github.com/badlogic/pi-mono/pull/639) by [@aliou](https://github.com/aliou))

## [0.42.5] - 2026-01-11

### Fixed

- Reduced flicker by only re-rendering changed lines ([#617](https://github.com/badlogic/pi-mono/pull/617) by [@ogulcancelik](https://github.com/ogulcancelik)). No worries tho, there's still a little flicker in the VS Code Terminal. Praise the flicker.
- Cursor position tracking when content shrinks with unchanged remaining lines
- TUI renders with wrong dimensions after suspend/resume if terminal was resized while suspended ([#599](https://github.com/badlogic/pi-mono/issues/599))
- Pasted content containing Kitty key release patterns (e.g., `:3F` in MAC addresses) was incorrectly filtered out ([#623](https://github.com/badlogic/pi-mono/pull/623) by [@ogulcancelik](https://github.com/ogulcancelik))

## [0.42.4] - 2026-01-10

### Fixed

- Bash output expanded hint now says "(ctrl+o to collapse)" ([#610](https://github.com/badlogic/pi-mono/pull/610) by [@tallshort](https://github.com/tallshort))
- Fixed UTF-8 text corruption in remote bash execution (SSH, containers) by using streaming TextDecoder ([#608](https://github.com/badlogic/pi-mono/issues/608))

## [0.42.3] - 2026-01-10

### Changed

- OpenAI Codex: updated to use bundled system prompt from upstream

## [0.42.2] - 2026-01-10

### Added

- `/model <search>` now pre-filters the model selector or auto-selects on exact match. Use `provider/model` syntax to disambiguate (e.g., `/model openai/gpt-4`). ([#587](https://github.com/badlogic/pi-mono/pull/587) by [@zedrdave](https://github.com/zedrdave))
- `FooterDataProvider` for custom footers: `ctx.ui.setFooter()` now receives a third `footerData` parameter providing `getGitBranch()`, `getExtensionStatuses()`, and `onBranchChange()` for reactive updates ([#600](https://github.com/badlogic/pi-mono/pull/600) by [@nicobailon](https://github.com/nicobailon))
- `Alt+Up` hotkey to restore queued steering/follow-up messages back into the editor without aborting the current run ([#604](https://github.com/badlogic/pi-mono/pull/604) by [@tmustier](https://github.com/tmustier))

### Fixed

- Fixed LM Studio compatibility for OpenAI Responses tool strict mapping in the ai provider ([#598](https://github.com/badlogic/pi-mono/pull/598) by [@gnattu](https://github.com/gnattu))

## [0.42.1] - 2026-01-09

### Fixed

- Symlinked directories in `prompts/` folders are now followed when loading prompt templates ([#601](https://github.com/badlogic/pi-mono/pull/601) by [@aliou](https://github.com/aliou))

## [0.42.0] - 2026-01-09

### Added

- Added OpenCode Zen provider support. Set `OPENCODE_API_KEY` env var and use `opencode/<model-id>` (e.g., `opencode/claude-opus-4-5`).

## [0.41.0] - 2026-01-09

### Added

- Anthropic OAuth support is back! Use `/login` to authenticate with your Claude Pro/Max subscription.

## [0.40.1] - 2026-01-09

### Removed

- Anthropic OAuth support (`/login`). Use API keys instead.

## [0.40.0] - 2026-01-08

### Added

- Documentation on component invalidation and theme changes in `docs/tui.md`

### Fixed

- Components now properly rebuild their content on theme change (tool executions, assistant messages, bash executions, custom messages, branch/compaction summaries)

## [0.39.1] - 2026-01-08

### Fixed

- `setTheme()` now triggers a full rerender so previously rendered components update with the new theme colors
- `mac-system-theme.ts` example now polls every 2 seconds and uses `osascript` for real-time macOS appearance detection

## [0.39.0] - 2026-01-08

### Breaking Changes

- `before_agent_start` event now receives `systemPrompt` in the event object and returns `systemPrompt` (full replacement) instead of `systemPromptAppend`. Extensions that were appending must now use `event.systemPrompt + extra` pattern. ([#575](https://github.com/badlogic/pi-mono/issues/575))
- `discoverSkills()` now returns `{ skills: Skill[], warnings: SkillWarning[] }` instead of `Skill[]`. This allows callers to handle skill loading warnings. ([#577](https://github.com/badlogic/pi-mono/pull/577) by [@cv](https://github.com/cv))

### Added

- `ctx.ui.getAllThemes()`, `ctx.ui.getTheme(name)`, and `ctx.ui.setTheme(name | Theme)` methods for extensions to list, load, and switch themes at runtime ([#576](https://github.com/badlogic/pi-mono/pull/576))
- `--no-tools` flag to disable all built-in tools, allowing extension-only tool setups ([#557](https://github.com/badlogic/pi-mono/pull/557) by [@cv](https://github.com/cv))
- Pluggable operations for built-in tools enabling remote execution via SSH or other transports ([#564](https://github.com/badlogic/pi-mono/issues/564)). Interfaces: `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`
- `user_bash` event for intercepting user `!`/`!!` commands, allowing extensions to redirect to remote systems ([#528](https://github.com/badlogic/pi-mono/issues/528))
- `setActiveTools()` in ExtensionAPI for dynamic tool management
- Built-in renderers used automatically for tool overrides without custom `renderCall`/`renderResult`
- `ssh.ts` example: remote tool execution via `--ssh user@host:/path`
- `interactive-shell.ts` example: run interactive commands (vim, git rebase, htop) with full terminal access via `!i` prefix or auto-detection
- Wayland clipboard support for `/copy` command using wl-copy with xclip/xsel fallback ([#570](https://github.com/badlogic/pi-mono/pull/570) by [@OgulcanCelik](https://github.com/OgulcanCelik))
- **Experimental:** `ctx.ui.custom()` now accepts `{ overlay: true }` option for floating modal components that composite over existing content without clearing the screen ([#558](https://github.com/badlogic/pi-mono/pull/558) by [@nicobailon](https://github.com/nicobailon))
- `AgentSession.skills` and `AgentSession.skillWarnings` properties to access loaded skills without rediscovery ([#577](https://github.com/badlogic/pi-mono/pull/577) by [@cv](https://github.com/cv))

### Fixed

- String `systemPrompt` in `createAgentSession()` now works as a full replacement instead of having context files and skills appended, matching documented behavior ([#543](https://github.com/badlogic/pi-mono/issues/543))
- Update notification for bun binary installs now shows release download URL instead of npm command ([#567](https://github.com/badlogic/pi-mono/pull/567) by [@ferologics](https://github.com/ferologics))
- ESC key now works during "Working..." state after auto-retry ([#568](https://github.com/badlogic/pi-mono/pull/568) by [@tmustier](https://github.com/tmustier))
- Abort messages now show correct retry attempt count (e.g., "Aborted after 2 retry attempts") ([#568](https://github.com/badlogic/pi-mono/pull/568) by [@tmustier](https://github.com/tmustier))
- Fixed Antigravity provider returning 429 errors despite available quota ([#571](https://github.com/badlogic/pi-mono/pull/571) by [@ben-vargas](https://github.com/ben-vargas))
- Fixed malformed thinking text in Gemini/Antigravity responses where thinking content appeared as regular text or vice versa. Cross-model conversations now properly convert thinking blocks to plain text. ([#561](https://github.com/badlogic/pi-mono/issues/561))
- `--no-skills` flag now correctly prevents skills from loading in interactive mode ([#577](https://github.com/badlogic/pi-mono/pull/577) by [@cv](https://github.com/cv))

## [0.38.0] - 2026-01-08

### Breaking Changes

- `ctx.ui.custom()` factory signature changed from `(tui, theme, done)` to `(tui, theme, keybindings, done)` for keybinding access in custom components
- `LoadedExtension` type renamed to `Extension`
- `LoadExtensionsResult.setUIContext()` removed, replaced with `runtime: ExtensionRuntime`
- `ExtensionRunner` constructor now requires `runtime: ExtensionRuntime` as second parameter
- `ExtensionRunner.initialize()` signature changed from options object to positional params `(actions, contextActions, commandContextActions?, uiContext?)`
- `ExtensionRunner.getHasUI()` renamed to `hasUI()`
- OpenAI Codex model aliases removed (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `codex-mini-latest`). Use canonical IDs: `gpt-5.1`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))

### Added

- `--no-extensions` flag to disable extension discovery while still allowing explicit `-e` paths ([#524](https://github.com/badlogic/pi-mono/pull/524) by [@cv](https://github.com/cv))
- SDK: `InteractiveMode`, `runPrintMode()`, `runRpcMode()` exported for building custom run modes. See `docs/sdk.md`.
- `PI_SKIP_VERSION_CHECK` environment variable to disable new version notifications at startup ([#549](https://github.com/badlogic/pi-mono/pull/549) by [@aos](https://github.com/aos))
- `thinkingBudgets` setting to customize token budgets per thinking level for token-based providers ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))
- Extension UI dialogs (`ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`) now support a `timeout` option with live countdown display ([#522](https://github.com/badlogic/pi-mono/pull/522) by [@nicobailon](https://github.com/nicobailon))
- Extensions can now provide custom editor components via `ctx.ui.setEditorComponent()`. See `examples/extensions/modal-editor.ts` and `docs/tui.md` Pattern 7.
- Extension factories can now be async, enabling dynamic imports and lazy-loaded dependencies ([#513](https://github.com/badlogic/pi-mono/pull/513) by [@austinm911](https://github.com/austinm911))
- `ctx.shutdown()` is now available in extension contexts for requesting a graceful shutdown. In interactive mode, shutdown is deferred until the agent becomes idle (after processing all queued steering and follow-up messages). In RPC mode, shutdown is deferred until after completing the current command response. In print mode, shutdown is a no-op as the process exits automatically when prompts complete. ([#542](https://github.com/badlogic/pi-mono/pull/542) by [@kaofelix](https://github.com/kaofelix))

### Fixed

- Default thinking level from settings now applies correctly when `enabledModels` is configured ([#540](https://github.com/badlogic/pi-mono/pull/540) by [@ferologics](https://github.com/ferologics))
- External edits to `settings.json` while pi is running are now preserved when pi saves settings ([#527](https://github.com/badlogic/pi-mono/pull/527) by [@ferologics](https://github.com/ferologics))
- Overflow-based compaction now skips if error came from a different model or was already handled by a previous compaction ([#535](https://github.com/badlogic/pi-mono/pull/535) by [@mitsuhiko](https://github.com/mitsuhiko))
- OpenAI Codex context window reduced from 400k to 272k tokens to match Codex CLI defaults and prevent 400 errors ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))
- Context overflow detection now recognizes `context_length_exceeded` errors.
- Key presses no longer dropped when input is batched over SSH ([#538](https://github.com/badlogic/pi-mono/issues/538))
- Clipboard image support now works on Alpine Linux and other musl-based distros ([#533](https://github.com/badlogic/pi-mono/issues/533))

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

### Added

- Extension UI dialogs (`ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`) now accept an optional `AbortSignal` to programmatically dismiss dialogs. Useful for implementing timeouts. See `examples/extensions/timed-confirm.ts`. ([#474](https://github.com/badlogic/pi-mono/issues/474))
- HTML export now shows bridge prompts in model change messages for Codex sessions ([#510](https://github.com/badlogic/pi-mono/pull/510) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.37.5] - 2026-01-06

### Added

- ExtensionAPI: `setModel()`, `getThinkingLevel()`, `setThinkingLevel()` methods for extensions to change model and thinking level at runtime ([#509](https://github.com/badlogic/pi-mono/issues/509))
- Exported truncation utilities for custom tools: `truncateHead`, `truncateTail`, `truncateLine`, `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `TruncationOptions`, `TruncationResult`
- New example `truncated-tool.ts` demonstrating proper output truncation with custom rendering for extensions
- New example `preset.ts` demonstrating preset configurations with model/thinking/tools switching ([#347](https://github.com/badlogic/pi-mono/issues/347))
- Documentation for output truncation best practices in `docs/extensions.md`
- Exported all UI components for extensions: `ArminComponent`, `AssistantMessageComponent`, `BashExecutionComponent`, `BorderedLoader`, `BranchSummaryMessageComponent`, `CompactionSummaryMessageComponent`, `CustomEditor`, `CustomMessageComponent`, `DynamicBorder`, `ExtensionEditorComponent`, `ExtensionInputComponent`, `ExtensionSelectorComponent`, `FooterComponent`, `LoginDialogComponent`, `ModelSelectorComponent`, `OAuthSelectorComponent`, `SessionSelectorComponent`, `SettingsSelectorComponent`, `ShowImagesSelectorComponent`, `ThemeSelectorComponent`, `ThinkingSelectorComponent`, `ToolExecutionComponent`, `TreeSelectorComponent`, `UserMessageComponent`, `UserMessageSelectorComponent`, plus utilities `renderDiff`, `truncateToVisualLines`
- `docs/tui.md`: Common Patterns section with copy-paste code for SelectList, BorderedLoader, SettingsList, setStatus, setWidget, setFooter
- `docs/tui.md`: Key Rules section documenting critical patterns for extension UI development
- `docs/extensions.md`: Exhaustive example links for all ExtensionAPI methods and events
- System prompt now references `docs/tui.md` for TUI component development

## [0.37.4] - 2026-01-06

### Added

- Session picker (`pi -r`) and `--session` flag now support searching/resuming by session ID (UUID prefix) ([#495](https://github.com/badlogic/pi-mono/issues/495) by [@arunsathiya](https://github.com/arunsathiya))
- Extensions can now replace the startup header with `ctx.ui.setHeader()`, see `examples/extensions/custom-header.ts` ([#500](https://github.com/badlogic/pi-mono/pull/500) by [@tudoroancea](https://github.com/tudoroancea))

### Changed

- Startup help text: fixed misleading "ctrl+k to delete line" to "ctrl+k to delete to end"
- Startup help text and `/hotkeys`: added `!!` shortcut for running bash without adding output to context

### Fixed

- Queued steering/follow-up messages no longer wipe unsent editor input ([#503](https://github.com/badlogic/pi-mono/pull/503) by [@tmustier](https://github.com/tmustier))
- OAuth token refresh failure no longer crashes app at startup, allowing user to `/login` to re-authenticate ([#498](https://github.com/badlogic/pi-mono/issues/498))

## [0.37.3] - 2026-01-06

### Added

- Extensions can now replace the footer with `ctx.ui.setFooter()`, see `examples/extensions/custom-footer.ts` ([#481](https://github.com/badlogic/pi-mono/issues/481))
- Session ID is now forwarded to LLM providers for session-based caching (used by OpenAI Codex for prompt caching).
- Added `blockImages` setting to prevent images from being sent to LLM providers ([#492](https://github.com/badlogic/pi-mono/pull/492) by [@jsinge97](https://github.com/jsinge97))
- Extensions can now send user messages via `pi.sendUserMessage()` ([#483](https://github.com/badlogic/pi-mono/issues/483))

### Fixed

- Add `minimatch` as a direct dependency for explicit imports.
- Status bar now shows correct git branch when running in a git worktree ([#490](https://github.com/badlogic/pi-mono/pull/490) by [@kcosr](https://github.com/kcosr))
- Interactive mode: Ctrl+V clipboard image paste now works on Wayland sessions by using `wl-paste` with `xclip` fallback ([#488](https://github.com/badlogic/pi-mono/pull/488) by [@ghoulr](https://github.com/ghoulr))

## [0.37.2] - 2026-01-05

### Fixed

- Extension directories in `settings.json` now respect `package.json` manifests, matching global extension behavior ([#480](https://github.com/badlogic/pi-mono/pull/480) by [@prateekmedia](https://github.com/prateekmedia))
- Share viewer: deep links now scroll to the target message when opened via `/share`
- Bash tool now handles spawn errors gracefully instead of crashing the agent (missing cwd, invalid shell path) ([#479](https://github.com/badlogic/pi-mono/pull/479) by [@robinwander](https://github.com/robinwander))

## [0.37.1] - 2026-01-05

### Fixed

- Share viewer: copy-link buttons now generate correct URLs when session is viewed via `/share` (iframe context)

## [0.37.0] - 2026-01-05

### Added

- Share viewer: copy-link button on messages to share URLs that navigate directly to a specific message ([#477](https://github.com/badlogic/pi-mono/pull/477) by [@lockmeister](https://github.com/lockmeister))
- Extension example: add `claude-rules` to load `.claude/rules/` entries into the system prompt ([#461](https://github.com/badlogic/pi-mono/pull/461) by [@vaayne](https://github.com/vaayne))
- Headless OAuth login: all providers now show paste input for manual URL/code entry, works over SSH without DISPLAY ([#428](https://github.com/badlogic/pi-mono/pull/428) by [@ben-vargas](https://github.com/ben-vargas), [#468](https://github.com/badlogic/pi-mono/pull/468) by [@crcatala](https://github.com/crcatala))

### Changed

- OAuth login UI now uses dedicated dialog component with consistent borders
- Assume truecolor support for all terminals except `dumb`, empty, or `linux` (fixes colors over SSH)
- OpenAI Codex clean-up: removed per-thinking-level model variants, thinking level is now set separately and the provider clamps to what each model supports internally (initial implementation in [#472](https://github.com/badlogic/pi-mono/pull/472) by [@ben-vargas](https://github.com/ben-vargas))

### Fixed

- Messages submitted during compaction are queued and delivered after compaction completes, preserving steering and follow-up behavior. Extension commands execute immediately during compaction. ([#476](https://github.com/badlogic/pi-mono/pull/476) by [@tmustier](https://github.com/tmustier))
- Managed binaries (`fd`, `rg`) now stored in `~/.pi/agent/bin/` instead of `tools/`, eliminating false deprecation warnings ([#470](https://github.com/badlogic/pi-mono/pull/470) by [@mcinteerj](https://github.com/mcinteerj))
- Extensions defined in `settings.json` were not loaded ([#463](https://github.com/badlogic/pi-mono/pull/463) by [@melihmucuk](https://github.com/melihmucuk))
- OAuth refresh no longer logs users out when multiple pi instances are running ([#466](https://github.com/badlogic/pi-mono/pull/466) by [@Cursivez](https://github.com/Cursivez))
- Migration warnings now ignore `fd.exe` and `rg.exe` in `tools/` on Windows ([#458](https://github.com/badlogic/pi-mono/pull/458) by [@carlosgtrz](https://github.com/carlosgtrz))
- CI: add `examples/extensions/with-deps` to workspaces to fix typecheck ([#467](https://github.com/badlogic/pi-mono/pull/467) by [@aliou](https://github.com/aliou))
- SDK: passing `extensions: []` now disables extension discovery as documented ([#465](https://github.com/badlogic/pi-mono/pull/465) by [@aliou](https://github.com/aliou))

## [0.36.0] - 2026-01-05

### Added

- Experimental: OpenAI Codex OAuth provider support: access Codex models via ChatGPT Plus/Pro subscription using `/login openai-codex` ([#451](https://github.com/badlogic/pi-mono/pull/451) by [@kim0](https://github.com/kim0))

## [0.35.0] - 2026-01-05

This release unifies hooks and custom tools into a single "extensions" system and renames "slash commands" to "prompt templates". ([#454](https://github.com/badlogic/pi-mono/issues/454))

**Before migrating, read:**

- [docs/extensions.md](docs/extensions.md) - Full API reference
- [README.md](README.md) - Extensions section with examples
- [examples/extensions/](examples/extensions/) - Working examples

### Extensions Migration

Hooks and custom tools are now unified as **extensions**. Both were TypeScript modules exporting a factory function that receives an API object. Now there's one concept, one discovery location, one CLI flag, one settings.json entry.

**Automatic migration:**

- `commands/` directories are automatically renamed to `prompts/` on startup (both `~/.pi/agent/commands/` and `.pi/commands/`)

**Manual migration required:**

1. Move files from `hooks/` and `tools/` directories to `extensions/` (deprecation warnings shown on startup)
2. Update imports and type names in your extension code
3. Update `settings.json` if you have explicit hook and custom tool paths configured

**Directory changes:**

```
# Before
~/.pi/agent/hooks/*.ts       →  ~/.pi/agent/extensions/*.ts
~/.pi/agent/tools/*.ts       →  ~/.pi/agent/extensions/*.ts
.pi/hooks/*.ts               →  .pi/extensions/*.ts
.pi/tools/*.ts               →  .pi/extensions/*.ts
```

**Extension discovery rules** (in `extensions/` directories):

1. **Direct files:** `extensions/*.ts` or `*.js` → loaded directly
2. **Subdirectory with index:** `extensions/myext/index.ts` → loaded as single extension
3. **Subdirectory with package.json:** `extensions/myext/package.json` with `"pi"` field → loads declared paths

```json
// extensions/my-package/package.json
{
  "name": "my-extension-package",
  "dependencies": { "zod": "^3.0.0" },
  "pi": {
    "extensions": ["./src/main.ts", "./src/tools.ts"]
  }
}
```

No recursion beyond one level. Complex packages must use the `package.json` manifest. Dependencies are resolved via jiti, and extensions can be published to and installed from npm.

**Type renames:**

- `HookAPI` → `ExtensionAPI`
- `HookContext` → `ExtensionContext`
- `HookCommandContext` → `ExtensionCommandContext`
- `HookUIContext` → `ExtensionUIContext`
- `CustomToolAPI` → `ExtensionAPI` (merged)
- `CustomToolContext` → `ExtensionContext` (merged)
- `CustomToolUIContext` → `ExtensionUIContext`
- `CustomTool` → `ToolDefinition`
- `CustomToolFactory` → `ExtensionFactory`
- `HookMessage` → `CustomMessage`

**Import changes:**

```typescript
// Before (hook)
import type { HookAPI, HookContext } from "@mariozechner/pi-coding-agent";
export default function (pi: HookAPI) { ... }

// Before (custom tool)
import type { CustomToolFactory } from "@mariozechner/pi-coding-agent";
const factory: CustomToolFactory = (pi) => ({ name: "my_tool", ... });
export default factory;

// After (both are now extensions)
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => { ... });
  pi.registerTool({ name: "my_tool", ... });
}
```

**Custom tools now have full context access.** Tools registered via `pi.registerTool()` now receive the same `ctx` object that event handlers receive. Previously, custom tools had limited context. Now all extension code shares the same capabilities:

- `pi.registerTool()` - Register tools the LLM can call
- `pi.registerCommand()` - Register commands like `/mycommand`
- `pi.registerShortcut()` - Register keyboard shortcuts (shown in `/hotkeys`)
- `pi.registerFlag()` - Register CLI flags (shown in `--help`)
- `pi.registerMessageRenderer()` - Custom TUI rendering for message types
- `pi.on()` - Subscribe to lifecycle events (tool_call, session_start, etc.)
- `pi.sendMessage()` - Inject messages into the conversation
- `pi.appendEntry()` - Persist custom data in session (survives restart/branch)
- `pi.exec()` - Run shell commands
- `pi.getActiveTools()` / `pi.setActiveTools()` - Dynamic tool enable/disable
- `pi.getAllTools()` - List all available tools
- `pi.events` - Event bus for cross-extension communication
- `ctx.ui.confirm()` / `select()` / `input()` - User prompts
- `ctx.ui.notify()` - Toast notifications
- `ctx.ui.setStatus()` - Persistent status in footer (multiple extensions can set their own)
- `ctx.ui.setWidget()` - Widget display above editor
- `ctx.ui.setTitle()` - Set terminal window title
- `ctx.ui.custom()` - Full TUI component with keyboard handling
- `ctx.ui.editor()` - Multi-line text editor with external editor support
- `ctx.sessionManager` - Read session entries, get branch history

**Settings changes:**

```json
// Before
{
  "hooks": ["./my-hook.ts"],
  "customTools": ["./my-tool.ts"]
}

// After
{
  "extensions": ["./my-extension.ts"]
}
```

**CLI changes:**

```bash
# Before
pi --hook ./safety.ts --tool ./todo.ts

# After
pi --extension ./safety.ts -e ./todo.ts
```

### Prompt Templates Migration

"Slash commands" (markdown files defining reusable prompts invoked via `/name`) are renamed to "prompt templates" to avoid confusion with extension-registered commands.

**Automatic migration:** The `commands/` directory is automatically renamed to `prompts/` on startup (if `prompts/` doesn't exist). Works for both regular directories and symlinks.

**Directory changes:**

```
~/.pi/agent/commands/*.md    →  ~/.pi/agent/prompts/*.md
.pi/commands/*.md            →  .pi/prompts/*.md
```

**SDK type renames:**

- `FileSlashCommand` → `PromptTemplate`
- `LoadSlashCommandsOptions` → `LoadPromptTemplatesOptions`

**SDK function renames:**

- `discoverSlashCommands()` → `discoverPromptTemplates()`
- `loadSlashCommands()` → `loadPromptTemplates()`
- `expandSlashCommand()` → `expandPromptTemplate()`
- `getCommandsDir()` → `getPromptsDir()`

**SDK option renames:**

- `CreateAgentSessionOptions.slashCommands` → `.promptTemplates`
- `AgentSession.fileCommands` → `.promptTemplates`
- `PromptOptions.expandSlashCommands` → `.expandPromptTemplates`

### SDK Migration

**Discovery functions:**

- `discoverAndLoadHooks()` → `discoverAndLoadExtensions()`
- `discoverAndLoadCustomTools()` → merged into `discoverAndLoadExtensions()`
- `loadHooks()` → `loadExtensions()`
- `loadCustomTools()` → merged into `loadExtensions()`

**Runner and wrapper:**

- `HookRunner` → `ExtensionRunner`
- `wrapToolsWithHooks()` → `wrapToolsWithExtensions()`
- `wrapToolWithHooks()` → `wrapToolWithExtensions()`

**CreateAgentSessionOptions:**

- `.hooks` → removed (use `.additionalExtensionPaths` for paths)
- `.additionalHookPaths` → `.additionalExtensionPaths`
- `.preloadedHooks` → `.preloadedExtensions`
- `.customTools` type changed: `Array<{ path?; tool: CustomTool }>` → `ToolDefinition[]`
- `.additionalCustomToolPaths` → merged into `.additionalExtensionPaths`
- `.slashCommands` → `.promptTemplates`

**AgentSession:**

- `.hookRunner` → `.extensionRunner`
- `.fileCommands` → `.promptTemplates`
- `.sendHookMessage()` → `.sendCustomMessage()`

### Session Migration

**Automatic.** Session version bumped from 2 to 3. Existing sessions are migrated on first load:

- Message role `"hookMessage"` → `"custom"`

### Breaking Changes

- **Settings:** `hooks` and `customTools` arrays replaced with single `extensions` array
- **CLI:** `--hook` and `--tool` flags replaced with `--extension` / `-e`
- **Directories:** `hooks/`, `tools/` → `extensions/`; `commands/` → `prompts/`
- **Types:** See type renames above
- **SDK:** See SDK migration above

### Changed

- Extensions can have their own `package.json` with dependencies (resolved via jiti)
- Documentation: `docs/hooks.md` and `docs/custom-tools.md` merged into `docs/extensions.md`
- Examples: `examples/hooks/` and `examples/custom-tools/` merged into `examples/extensions/`
- README: Extensions section expanded with custom tools, commands, events, state persistence, shortcuts, flags, and UI examples
- SDK: `customTools` option now accepts `ToolDefinition[]` directly (simplified from `Array<{ path?, tool }>`)
- SDK: `extensions` option accepts `ExtensionFactory[]` for inline extensions
- SDK: `additionalExtensionPaths` replaces both `additionalHookPaths` and `additionalCustomToolPaths`

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

### Added

- Hook API: `ctx.ui.setTitle(title)` allows hooks to set the terminal window/tab title ([#446](https://github.com/badlogic/pi-mono/pull/446) by [@aliou](https://github.com/aliou))

### Changed

- Expanded keybinding documentation to list all 32 supported symbol keys with notes on ctrl+symbol behavior ([#450](https://github.com/badlogic/pi-mono/pull/450) by [@kaofelix](https://github.com/kaofelix))

## [0.34.0] - 2026-01-04

### Added

- Hook API: `pi.getActiveTools()` and `pi.setActiveTools(toolNames)` for dynamically enabling/disabling tools from hooks
- Hook API: `pi.getAllTools()` to enumerate all configured tools (built-in via --tools or default, plus custom tools)
- Hook API: `pi.registerFlag(name, options)` and `pi.getFlag(name)` for hooks to register custom CLI flags (parsed automatically)
- Hook API: `pi.registerShortcut(shortcut, options)` for hooks to register custom keyboard shortcuts using `KeyId` (e.g., `Key.shift("p")`). Conflicts with built-in shortcuts are skipped, conflicts between hooks logged as warnings.
- Hook API: `ctx.ui.setWidget(key, content)` for status displays above the editor. Accepts either a string array or a component factory function.
- Hook API: `theme.strikethrough(text)` for strikethrough text styling
- Hook API: `before_agent_start` handlers can now return `systemPromptAppend` to dynamically append text to the system prompt for that turn. Multiple hooks' appends are concatenated.
- Hook API: `before_agent_start` handlers can now return multiple messages (all are injected, not just the first)
- `/hotkeys` command now shows hook-registered shortcuts in a separate "Hooks" section
- New example hook: `plan-mode.ts` - Claude Code-style read-only exploration mode:
  - Toggle via `/plan` command, `Shift+P` shortcut, or `--plan` CLI flag
  - Read-only tools: `read`, `bash`, `grep`, `find`, `ls` (no `edit`/`write`)
  - Bash commands restricted to non-destructive operations (blocks `rm`, `mv`, `git commit`, `npm install`, etc.)
  - Interactive prompt after each response: execute plan, stay in plan mode, or refine
  - Todo list widget showing progress with checkboxes and strikethrough for completed items
  - Each todo has a unique ID; agent marks items done by outputting `[DONE:id]`
  - Progress updates via `agent_end` hook (parses completed items from final message)
  - `/todos` command to view current plan progress
  - Shows `⏸ plan` indicator in footer when in plan mode, `📋 2/5` when executing
  - State persists across sessions (including todo progress)
- New example hook: `tools.ts` - Interactive `/tools` command to enable/disable tools with session persistence
- New example hook: `pirate.ts` - Demonstrates `systemPromptAppend` to make the agent speak like a pirate
- Tool registry now contains all built-in tools (read, bash, edit, write, grep, find, ls) even when `--tools` limits the initially active set. Hooks can enable any tool from the registry via `pi.setActiveTools()`.
- System prompt now automatically rebuilds when tools change via `setActiveTools()`, updating tool descriptions and guidelines to match the new tool set
- Hook errors now display full stack traces for easier debugging
- Event bus (`pi.events`) for tool/hook communication: shared pub/sub between custom tools and hooks
- Custom tools now have `pi.sendMessage()` to send messages directly to the agent session without needing the event bus
- `sendMessage()` supports `deliverAs: "nextTurn"` to queue messages for the next user prompt

### Changed

- Removed image placeholders after copy & paste, replaced with inserting image file paths directly. ([#442](https://github.com/badlogic/pi-mono/pull/442) by [@mitsuhiko](https://github.com/mitsuhiko))

### Fixed

- Fixed potential text decoding issues in bash executor by using streaming TextDecoder instead of Buffer.toString()
- External editor (Ctrl-G) now shows full pasted content instead of `[paste #N ...]` placeholders ([#444](https://github.com/badlogic/pi-mono/pull/444) by [@aliou](https://github.com/aliou))

## [0.33.0] - 2026-01-04

### Breaking Changes

- **Key detection functions removed from `@mariozechner/pi-tui`**: All `isXxx()` key detection functions (`isEnter()`, `isEscape()`, `isCtrlC()`, etc.) have been removed. Use `matchesKey(data, keyId)` instead (e.g., `matchesKey(data, "enter")`, `matchesKey(data, "ctrl+c")`). This affects hooks and custom tools that use `ctx.ui.custom()` with keyboard input handling. ([#405](https://github.com/badlogic/pi-mono/pull/405))

### Added

- Clipboard image paste support via `Ctrl+V`. Images are saved to a temp file and attached to the message. Works on macOS, Windows, and Linux (X11). ([#419](https://github.com/badlogic/pi-mono/issues/419))
- Configurable keybindings via `~/.pi/agent/keybindings.json`. All keyboard shortcuts (editor navigation, deletion, app actions like model cycling, etc.) can now be customized. Supports multiple bindings per action. ([#405](https://github.com/badlogic/pi-mono/pull/405) by [@hjanuschka](https://github.com/hjanuschka))
- `/quit` and `/exit` slash commands to gracefully exit the application. Unlike double Ctrl+C, these properly await hook and custom tool cleanup handlers before exiting. ([#426](https://github.com/badlogic/pi-mono/pull/426) by [@ben-vargas](https://github.com/ben-vargas))

### Fixed

- Subagent example README referenced incorrect filename `subagent.ts` instead of `index.ts` ([#427](https://github.com/badlogic/pi-mono/pull/427) by [@Whamp](https://github.com/Whamp))

## [0.32.3] - 2026-01-03

### Fixed

- `--list-models` no longer shows Google Vertex AI models without explicit authentication configured
- JPEG/GIF/WebP images not displaying in terminals using Kitty graphics protocol (Kitty, Ghostty, WezTerm). The protocol requires PNG format, so non-PNG images are now converted before display.
- Version check URL typo preventing update notifications from working ([#423](https://github.com/badlogic/pi-mono/pull/423) by [@skuridin](https://github.com/skuridin))
- Large images exceeding Anthropic's 5MB limit now retry with progressive quality/size reduction ([#424](https://github.com/badlogic/pi-mono/pull/424) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.32.2] - 2026-01-03

### Added

- `$ARGUMENTS` syntax for custom slash commands as alternative to `$@` for all arguments joined. Aligns with patterns used by Claude, Codex, and OpenCode. Both syntaxes remain fully supported. ([#418](https://github.com/badlogic/pi-mono/pull/418) by [@skuridin](https://github.com/skuridin))

### Changed

- **Slash commands and hook commands now work during streaming**: Previously, using a slash command or hook command while the agent was streaming would crash with "Agent is already processing". Now:
  - Hook commands execute immediately (they manage their own LLM interaction via `pi.sendMessage()`)
  - File-based slash commands are expanded and queued via steer/followUp
  - `steer()` and `followUp()` now expand file-based slash commands and error on hook commands (hook commands cannot be queued)
  - `prompt()` accepts new `streamingBehavior` option (`"steer"` or `"followUp"`) to specify queueing behavior during streaming
  - RPC `prompt` command now accepts optional `streamingBehavior` field
    ([#420](https://github.com/badlogic/pi-mono/issues/420))

### Fixed

- Slash command argument substitution now processes positional arguments (`$1`, `$2`, etc.) before all-arguments (`$@`, `$ARGUMENTS`) to prevent recursive substitution when argument values contain dollar-digit patterns like `$100`. ([#418](https://github.com/badlogic/pi-mono/pull/418) by [@skuridin](https://github.com/skuridin))

## [0.32.1] - 2026-01-03

### Added

- Shell commands without context contribution: use `!!command` to execute a bash command that is shown in the TUI and saved to session history but excluded from LLM context. Useful for running commands you don't want the AI to see. ([#414](https://github.com/badlogic/pi-mono/issues/414))

### Fixed

- Edit tool diff not displaying in TUI due to race condition between async preview computation and tool execution

## [0.32.0] - 2026-01-03

### Breaking Changes

- **Queue API replaced with steer/followUp**: The `queueMessage()` method has been split into two methods with different delivery semantics ([#403](https://github.com/badlogic/pi-mono/issues/403)):
  - `steer(text)`: Interrupts the agent mid-run (Enter while streaming). Delivered after current tool execution.
  - `followUp(text)`: Waits until the agent finishes (Alt+Enter while streaming). Delivered only when agent stops.
- **Settings renamed**: `queueMode` setting renamed to `steeringMode`. Added new `followUpMode` setting. Old settings.json files are migrated automatically.
- **AgentSession methods renamed**:
  - `queueMessage()` → `steer()` and `followUp()`
  - `queueMode` getter → `steeringMode` and `followUpMode` getters
  - `setQueueMode()` → `setSteeringMode()` and `setFollowUpMode()`
  - `queuedMessageCount` → `pendingMessageCount`
  - `getQueuedMessages()` → `getSteeringMessages()` and `getFollowUpMessages()`
  - `clearQueue()` now returns `{ steering: string[], followUp: string[] }`
  - `hasQueuedMessages()` → `hasPendingMessages()`
- **Hook API signature changed**: `pi.sendMessage()` second parameter changed from `triggerTurn?: boolean` to `options?: { triggerTurn?, deliverAs? }`. Use `deliverAs: "followUp"` for follow-up delivery. Affects both hooks and internal `sendHookMessage()` method.
- **RPC API changes**:
  - `queue_message` command → `steer` and `follow_up` commands
  - `set_queue_mode` command → `set_steering_mode` and `set_follow_up_mode` commands
  - `RpcSessionState.queueMode` → `steeringMode` and `followUpMode`
- **Settings UI**: "Queue mode" setting split into "Steering mode" and "Follow-up mode"

### Added

- Configurable double-escape action: choose whether double-escape with empty editor opens `/tree` (default) or `/branch`. Configure via `/settings` or `doubleEscapeAction` in settings.json ([#404](https://github.com/badlogic/pi-mono/issues/404))
- Vertex AI provider (`google-vertex`): access Gemini models via Google Cloud Vertex AI using Application Default Credentials ([#300](https://github.com/badlogic/pi-mono/pull/300) by [@default-anton](https://github.com/default-anton))
- Built-in provider overrides in `models.json`: override just `baseUrl` to route a built-in provider through a proxy while keeping all its models, or define `models` to fully replace the provider ([#406](https://github.com/badlogic/pi-mono/pull/406) by [@yevhen](https://github.com/yevhen))
- Automatic image resizing: images larger than 2000x2000 are resized for better model compatibility. Original dimensions are injected into the prompt. Controlled via `/settings` or `images.autoResize` in settings.json. ([#402](https://github.com/badlogic/pi-mono/pull/402) by [@mitsuhiko](https://github.com/mitsuhiko))
- Alt+Enter keybind to queue follow-up messages while agent is streaming
- `Theme` and `ThemeColor` types now exported for hooks using `ctx.ui.custom()`
- Terminal window title now displays "pi - dirname" to identify which project session you're in ([#407](https://github.com/badlogic/pi-mono/pull/407) by [@kaofelix](https://github.com/kaofelix))

### Changed

- Editor component now uses word wrapping instead of character-level wrapping for better readability ([#382](https://github.com/badlogic/pi-mono/pull/382) by [@nickseelert](https://github.com/nickseelert))

### Fixed

- `/model` selector now opens instantly instead of waiting for OAuth token refresh. Token refresh is deferred until a model is actually used.
- Shift+Space, Shift+Backspace, and Shift+Delete now work correctly in Kitty-protocol terminals (Kitty, WezTerm, etc.) instead of being silently ignored ([#411](https://github.com/badlogic/pi-mono/pull/411) by [@nathyong](https://github.com/nathyong))
- `AgentSession.prompt()` now throws if called while the agent is already streaming, preventing race conditions. Use `steer()` or `followUp()` to queue messages during streaming.
- Ctrl+C now works like Escape in selector components, so mashing Ctrl+C will eventually close the program ([#400](https://github.com/badlogic/pi-mono/pull/400) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.31.1] - 2026-01-02

### Fixed

- Model selector no longer allows negative index when pressing arrow keys before models finish loading ([#398](https://github.com/badlogic/pi-mono/pull/398) by [@mitsuhiko](https://github.com/mitsuhiko))
- Type guard functions (`isBashToolResult`, etc.) now exported at runtime, not just in type declarations ([#397](https://github.com/badlogic/pi-mono/issues/397))

## [0.31.0] - 2026-01-02

This release introduces session trees for in-place branching, major API changes to hooks and custom tools, and structured compaction with file tracking.

### Session Tree

Sessions now use a tree structure with `id`/`parentId` fields. This enables in-place branching: navigate to any previous point with `/tree`, continue from there, and switch between branches while preserving all history in a single file.

**Existing sessions are automatically migrated** (v1 → v2) on first load. No manual action required.

New entry types: `BranchSummaryEntry` (context from abandoned branches), `CustomEntry` (hook state), `CustomMessageEntry` (hook-injected messages), `LabelEntry` (bookmarks).

See [docs/session.md](docs/session.md) for the file format and `SessionManager` API.

### Hooks Migration

The hooks API has been restructured with more granular events and better session access.

**Type renames:**

- `HookEventContext` → `HookContext`
- `HookCommandContext` is now a new interface extending `HookContext` with session control methods

**Event changes:**

- The monolithic `session` event is now split into granular events: `session_start`, `session_before_switch`, `session_switch`, `session_before_branch`, `session_branch`, `session_before_compact`, `session_compact`, `session_shutdown`
- `session_before_switch` and `session_switch` events now include `reason: "new" | "resume"` to distinguish between `/new` and `/resume`
- New `session_before_tree` and `session_tree` events for `/tree` navigation (hook can provide custom branch summary)
- New `before_agent_start` event: inject messages before the agent loop starts
- New `context` event: modify messages non-destructively before each LLM call
- Session entries are no longer passed in events. Use `ctx.sessionManager.getEntries()` or `ctx.sessionManager.getBranch()` instead

**API changes:**

- `pi.send(text, attachments?)` → `pi.sendMessage(message, triggerTurn?)` (creates `CustomMessageEntry`)
- New `pi.appendEntry(customType, data?)` for hook state persistence (not in LLM context)
- New `pi.registerCommand(name, options)` for custom slash commands (handler receives `HookCommandContext`)
- New `pi.registerMessageRenderer(customType, renderer)` for custom TUI rendering
- New `ctx.isIdle()`, `ctx.abort()`, `ctx.hasQueuedMessages()` for agent state (available in all events)
- New `ctx.ui.editor(title, prefill?)` for multi-line text editing with Ctrl+G external editor support
- New `ctx.ui.custom(component)` for full TUI component rendering with keyboard focus
- New `ctx.ui.setStatus(key, text)` for persistent status text in footer (multiple hooks can set their own)
- New `ctx.ui.theme` getter for styling text with theme colors
- `ctx.exec()` moved to `pi.exec()`
- `ctx.sessionFile` → `ctx.sessionManager.getSessionFile()`
- New `ctx.modelRegistry` and `ctx.model` for API key resolution

**HookCommandContext (slash commands only):**

- `ctx.waitForIdle()` - wait for agent to finish streaming
- `ctx.newSession(options?)` - create new sessions with optional setup callback
- `ctx.fork(entryId) - fork from a specific entry, creating a new session file
- `ctx.navigateTree(targetId, options?)` - navigate the session tree

These methods are only on `HookCommandContext` (not `HookContext`) because they can deadlock if called from event handlers that run inside the agent loop.

**Removed:**

- `hookTimeout` setting (hooks no longer have timeouts; use Ctrl+C to abort)
- `resolveApiKey` parameter (use `ctx.modelRegistry.getApiKey(model)`)

See [docs/hooks.md](docs/hooks.md) and [examples/hooks/](examples/hooks/) for the current API.

### Custom Tools Migration

The custom tools API has been restructured to mirror the hooks pattern with a context object.

**Type renames:**

- `CustomAgentTool` → `CustomTool`
- `ToolAPI` → `CustomToolAPI`
- `ToolContext` → `CustomToolContext`
- `ToolSessionEvent` → `CustomToolSessionEvent`

**Execute signature changed:**

```typescript
// Before (v0.30.2)
execute(toolCallId, params, signal, onUpdate)

// After
execute(toolCallId, params, onUpdate, ctx, signal?)
```

The new `ctx: CustomToolContext` provides `sessionManager`, `modelRegistry`, `model`, and agent state methods:

- `ctx.isIdle()` - check if agent is streaming
- `ctx.hasQueuedMessages()` - check if user has queued messages (skip interactive prompts)
- `ctx.abort()` - abort current operation (fire-and-forget)

**Session event changes:**

- `CustomToolSessionEvent` now only has `reason` and `previousSessionFile`
- Session entries are no longer in the event. Use `ctx.sessionManager.getBranch()` or `ctx.sessionManager.getEntries()` to reconstruct state
- Reasons: `"start" | "switch" | "branch" | "tree" | "shutdown"` (no separate `"new"` reason; `/new` triggers `"switch"`)
- `dispose()` method removed. Use `onSession` with `reason: "shutdown"` for cleanup

See [docs/custom-tools.md](docs/custom-tools.md) and [examples/custom-tools/](examples/custom-tools/) for the current API.

### SDK Migration

**Type changes:**

- `CustomAgentTool` → `CustomTool`
- `AppMessage` → `AgentMessage`
- `sessionFile` returns `string | undefined` (was `string | null`)
- `model` returns `Model | undefined` (was `Model | null`)
- `Attachment` type removed. Use `ImageContent` from `@mariozechner/pi-ai` instead. Add images directly to message content arrays.

**AgentSession API:**

- `branch(entryIndex: number)` → `branch(entryId: string)`
- `getUserMessagesForBranching()` returns `{ entryId, text }` instead of `{ entryIndex, text }`
- `reset()` → `newSession(options?)` where options has optional `parentSession` for lineage tracking
- `newSession()` and `switchSession()` now return `Promise<boolean>` (false if cancelled by hook)
- New `navigateTree(targetId, options?)` for in-place tree navigation

**Hook integration:**

- New `sendHookMessage(message, triggerTurn?)` for hook message injection

**SessionManager API:**

- Method renames: `saveXXX()` → `appendXXX()` (e.g., `appendMessage`, `appendCompaction`)
- `branchInPlace()` → `branch()`
- `reset()` → `newSession(options?)` with optional `parentSession` for lineage tracking
- `createBranchedSessionFromEntries(entries, index)` → `createBranchedSession(leafId)`
- `SessionHeader.branchedFrom` → `SessionHeader.parentSession`
- `saveCompaction(entry)` → `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?)`
- `getEntries()` now excludes the session header (use `getHeader()` separately)
- `getSessionFile()` returns `string | undefined` (undefined for in-memory sessions)
- New tree methods: `getTree()`, `getBranch()`, `getLeafId()`, `getLeafEntry()`, `getEntry()`, `getChildren()`, `getLabel()`
- New append methods: `appendCustomEntry()`, `appendCustomMessageEntry()`, `appendLabelChange()`
- New branch methods: `branch(entryId)`, `branchWithSummary()`

**ModelRegistry (new):**

`ModelRegistry` is a new class that manages model discovery and API key resolution. It combines built-in models with custom models from `models.json` and resolves API keys via `AuthStorage`.

```typescript
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";

const authStorage = discoverAuthStorage(); // ~/.pi/agent/auth.json
const modelRegistry = discoverModels(authStorage); // + ~/.pi/agent/models.json

// Get all models (built-in + custom)
const allModels = modelRegistry.getAll();

// Get only models with valid API keys
const available = await modelRegistry.getAvailable();

// Find specific model
const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");

// Get API key for a model
const apiKey = await modelRegistry.getApiKey(model);
```

This replaces the old `resolveApiKey` callback pattern. Hooks and custom tools access it via `ctx.modelRegistry`.

**Renamed exports:**

- `messageTransformer` → `convertToLlm`
- `SessionContext` alias `LoadedSession` removed

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/) for the current API.

### RPC Migration

**Session commands:**

- `reset` command → `new_session` command with optional `parentSession` field

**Branching commands:**

- `branch` command: `entryIndex` → `entryId`
- `get_branch_messages` response: `entryIndex` → `entryId`

**Type changes:**

- Messages are now `AgentMessage` (was `AppMessage`)
- `prompt` command: `attachments` field replaced with `images` field using `ImageContent` format

**Compaction events:**

- `auto_compaction_start` now includes `reason` field (`"threshold"` or `"overflow"`)
- `auto_compaction_end` now includes `willRetry` field
- `compact` response includes full `CompactionResult` (`summary`, `firstKeptEntryId`, `tokensBefore`, `details`)

See [docs/rpc.md](docs/rpc.md) for the current protocol.

### Structured Compaction

Compaction and branch summarization now use a structured output format:

- Clear sections: Goal, Progress, Key Information, File Operations
- File tracking: `readFiles` and `modifiedFiles` arrays in `details`, accumulated across compactions
- Conversations are serialized to text before summarization to prevent the model from "continuing" them

The `before_compact` and `before_tree` hook events allow custom compaction implementations. See [docs/compaction.md](docs/compaction.md).

### Interactive Mode

**`/tree` command:**

- Navigate the full session tree in-place
- Search by typing, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press `l` to label entries as bookmarks
- Selecting a branch switches context and optionally injects a summary of the abandoned branch

**Entry labels:**

- Bookmark any entry via `/tree` → select → `l`
- Labels appear in tree view and persist as `LabelEntry`

**Theme changes (breaking for custom themes):**

Custom themes must add these new color tokens or they will fail to load:

- `selectedBg`: background for selected/highlighted items in tree selector and other components
- `customMessageBg`: background for hook-injected messages (`CustomMessageEntry`)
- `customMessageText`: text color for hook messages
- `customMessageLabel`: label color for hook messages (the `[customType]` prefix)

Total color count increased from 46 to 50. See [docs/themes.md](docs/themes.md) for the full color list and copy values from the built-in dark/light themes.

**Settings:**

- `enabledModels`: allowlist models in `settings.json` (same format as `--models` CLI)

### Added

- `ctx.ui.setStatus(key, text)` for hooks to display persistent status text in the footer ([#385](https://github.com/badlogic/pi-mono/pull/385) by [@prateekmedia](https://github.com/prateekmedia))
- `ctx.ui.theme` getter for styling status text and other output with theme colors
- `/share` command to upload session as a secret GitHub gist and get a shareable URL via pi.dev ([#380](https://github.com/badlogic/pi-mono/issues/380))
- HTML export now includes a tree visualization sidebar for navigating session branches ([#375](https://github.com/badlogic/pi-mono/issues/375))
- HTML export supports keyboard shortcuts: Ctrl+T to toggle thinking blocks, Ctrl+O to toggle tool outputs
- HTML export supports theme-configurable background colors via optional `export` section in theme JSON ([#387](https://github.com/badlogic/pi-mono/pull/387) by [@mitsuhiko](https://github.com/mitsuhiko))
- HTML export syntax highlighting now uses theme colors and matches TUI rendering
- **Snake game example hook**: Demonstrates `ui.custom()`, `registerCommand()`, and session persistence. See [examples/hooks/snake.ts](examples/hooks/snake.ts).
- **`thinkingText` theme token**: Configurable color for thinking block text. ([#366](https://github.com/badlogic/pi-mono/pull/366) by [@paulbettner](https://github.com/paulbettner))

### Changed

- **Entry IDs**: Session entries now use short 8-character hex IDs instead of full UUIDs
- **API key priority**: `ANTHROPIC_OAUTH_TOKEN` now takes precedence over `ANTHROPIC_API_KEY`
- HTML export template split into separate files (template.html, template.css, template.js) for easier maintenance

### Fixed

- HTML export now properly sanitizes user messages containing HTML tags like `<style>` that could break DOM rendering
- Crash when displaying bash output containing Unicode format characters like U+0600-U+0604 ([#372](https://github.com/badlogic/pi-mono/pull/372) by [@HACKE-RC](https://github.com/HACKE-RC))
- **Footer shows full session stats**: Token usage and cost now include all messages, not just those after compaction. ([#322](https://github.com/badlogic/pi-mono/issues/322))
- **Status messages spam chat log**: Rapidly changing settings (e.g., thinking level via Shift+Tab) would add multiple status lines. Sequential status updates now coalesce into a single line. ([#365](https://github.com/badlogic/pi-mono/pull/365) by [@paulbettner](https://github.com/paulbettner))
- **Toggling thinking blocks during streaming shows nothing**: Pressing Ctrl+T while streaming would hide the current message until streaming completed.
- **Resuming session resets thinking level to off**: Initial model and thinking level were not saved to session file, causing `--resume`/`--continue` to default to `off`. ([#342](https://github.com/badlogic/pi-mono/issues/342) by [@aliou](https://github.com/aliou))
- **Hook `tool_result` event ignores errors from custom tools**: The `tool_result` hook event was never emitted when tools threw errors, and always had `isError: false` for successful executions. Now emits the event with correct `isError` value in both success and error cases. ([#374](https://github.com/badlogic/pi-mono/issues/374) by [@nicobailon](https://github.com/nicobailon))
- **Edit tool fails on Windows due to CRLF line endings**: Files with CRLF line endings now match correctly when LLMs send LF-only text. Line endings are normalized before matching and restored to original style on write. ([#355](https://github.com/badlogic/pi-mono/issues/355) by [@Pratham-Dubey](https://github.com/Pratham-Dubey))
- **Edit tool fails on files with UTF-8 BOM**: Files with UTF-8 BOM marker could cause "text not found" errors since the LLM doesn't include the invisible BOM character. BOM is now stripped before matching and restored on write. ([#394](https://github.com/badlogic/pi-mono/pull/394) by [@prathamdby](https://github.com/prathamdby))
- **Use bash instead of sh on Unix**: Fixed shell commands using `/bin/sh` instead of `/bin/bash` on Unix systems. ([#328](https://github.com/badlogic/pi-mono/pull/328) by [@dnouri](https://github.com/dnouri))
- **OAuth login URL clickable**: Made OAuth login URLs clickable in terminal. ([#349](https://github.com/badlogic/pi-mono/pull/349) by [@Cursivez](https://github.com/Cursivez))
- **Improved error messages**: Better error messages when `apiKey` or `model` are missing. ([#346](https://github.com/badlogic/pi-mono/pull/346) by [@ronyrus](https://github.com/ronyrus))
- **Session file validation**: `findMostRecentSession()` now validates session headers before returning, preventing non-session JSONL files from being loaded
- **Compaction error handling**: `generateSummary()` and `generateTurnPrefixSummary()` now throw on LLM errors instead of returning empty strings
- **Compaction with branched sessions**: Fixed compaction incorrectly including entries from abandoned branches, causing token overflow errors. Compaction now uses `sessionManager.getPath()` to work only on the current branch path, eliminating 80+ lines of duplicate entry collection logic between `prepareCompaction()` and `compact()`
- **enabledModels glob patterns**: `--models` and `enabledModels` now support glob patterns like `github-copilot/*` or `*sonnet*`. Previously, patterns were only matched literally or via substring search. ([#337](https://github.com/badlogic/pi-mono/issues/337))

## [0.30.2] - 2025-12-26

### Changed

- **Consolidated migrations**: Moved auth migration from `AuthStorage.migrateLegacy()` to new `migrations.ts` module.

## [0.30.1] - 2025-12-26

### Fixed

- **Sessions saved to wrong directory**: In v0.30.0, sessions were being saved to `~/.pi/agent/` instead of `~/.pi/agent/sessions/<encoded-cwd>/`, breaking `--resume` and `/resume`. Misplaced sessions are automatically migrated on startup. ([#320](https://github.com/badlogic/pi-mono/issues/320) by [@aliou](https://github.com/aliou))
- **Custom system prompts missing context**: When using a custom system prompt string, project context files (AGENTS.md), skills, date/time, and working directory were not appended. ([#321](https://github.com/badlogic/pi-mono/issues/321))

## [0.30.0] - 2025-12-25

### Breaking Changes

- **SessionManager API**: The second parameter of `create()`, `continueRecent()`, and `list()` changed from `agentDir` to `sessionDir`. When provided, it specifies the session directory directly (no cwd encoding). When omitted, uses default (`~/.pi/agent/sessions/<encoded-cwd>/`). `open()` no longer takes `agentDir`. ([#313](https://github.com/badlogic/pi-mono/pull/313))

### Added

- **`--session-dir` flag**: Use a custom directory for sessions instead of the default `~/.pi/agent/sessions/<encoded-cwd>/`. Works with `-c` (continue) and `-r` (resume) flags. ([#313](https://github.com/badlogic/pi-mono/pull/313) by [@scutifer](https://github.com/scutifer))
- **Reverse model cycling and model selector**: Shift+Ctrl+P cycles models backward, Ctrl+L opens model selector (retaining text in editor). ([#315](https://github.com/badlogic/pi-mono/pull/315) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.29.1] - 2025-12-25

### Added

- **Automatic custom system prompt loading**: Pi now auto-loads `SYSTEM.md` files to replace the default system prompt. Project-local `.pi/SYSTEM.md` takes precedence over global `~/.pi/agent/SYSTEM.md`. CLI `--system-prompt` flag overrides both. ([#309](https://github.com/badlogic/pi-mono/issues/309))
- **Unified `/settings` command**: New settings menu consolidating thinking level, theme, queue mode, auto-compact, show images, hide thinking, and collapse changelog. Replaces individual `/thinking`, `/queue`, `/theme`, `/autocompact`, and `/show-images` commands. ([#310](https://github.com/badlogic/pi-mono/issues/310))

### Fixed

- **Custom tools/hooks with typebox subpath imports**: Fixed jiti alias for `@sinclair/typebox` to point to package root instead of entry file, allowing imports like `@sinclair/typebox/compiler` to resolve correctly. ([#311](https://github.com/badlogic/pi-mono/issues/311) by [@kim0](https://github.com/kim0))

## [0.29.0] - 2025-12-25

### Breaking Changes

- **Renamed `/clear` to `/new`**: The command to start a fresh session is now `/new`. Hook event reasons `before_clear`/`clear` are now `before_new`/`new`. Merry Christmas [@mitsuhiko](https://github.com/mitsuhiko)! ([#305](https://github.com/badlogic/pi-mono/pull/305))

### Added

- **Auto-space before pasted file paths**: When pasting a file path (starting with `/`, `~`, or `.`) after a word character, a space is automatically prepended. ([#307](https://github.com/badlogic/pi-mono/pull/307) by [@mitsuhiko](https://github.com/mitsuhiko))
- **Word navigation in input fields**: Added Ctrl+Left/Right and Alt+Left/Right for word-by-word cursor movement. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))
- **Full Unicode input**: Input fields now accept Unicode characters beyond ASCII. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

### Fixed

- **Readline-style Ctrl+W**: Now skips trailing whitespace before deleting the preceding word, matching standard readline behavior. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

## [0.28.0] - 2025-12-25

### Changed

- **Credential storage refactored**: API keys and OAuth tokens are now stored in `~/.pi/agent/auth.json` instead of `oauth.json` and `settings.json`. Existing credentials are automatically migrated on first run. ([#296](https://github.com/badlogic/pi-mono/issues/296))

- **SDK API changes** ([#296](https://github.com/badlogic/pi-mono/issues/296)):

  - Added `AuthStorage` class for credential management (API keys and OAuth tokens)
  - Added `ModelRegistry` class for model discovery and API key resolution
  - Added `discoverAuthStorage()` and `discoverModels()` discovery functions
  - `createAgentSession()` now accepts `authStorage` and `modelRegistry` options
  - Removed `configureOAuthStorage()`, `defaultGetApiKey()`, `findModel()`, `discoverAvailableModels()`
  - Removed `getApiKey` callback option (use `AuthStorage.setRuntimeApiKey()` for runtime overrides)
  - Use `getModel()` from `@mariozechner/pi-ai` for built-in models, `modelRegistry.find()` for custom models + built-in models
  - See updated [SDK documentation](docs/sdk.md) and [README](README.md)

- **Settings changes**: Removed `apiKeys` from `settings.json`. Use `auth.json` instead. ([#296](https://github.com/badlogic/pi-mono/issues/296))

### Fixed

- **Duplicate skill warnings for symlinks**: Skills loaded via symlinks pointing to the same file are now silently deduplicated instead of showing name collision warnings. ([#304](https://github.com/badlogic/pi-mono/pull/304) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.27.9] - 2025-12-24

### Fixed

- **Model selector and --list-models with settings.json API keys**: Models with API keys configured in settings.json (but not in environment variables) now properly appear in the /model selector and `--list-models` output. ([#295](https://github.com/badlogic/pi-mono/issues/295))

## [0.27.8] - 2025-12-24

### Fixed

- **API key priority**: OAuth tokens now take priority over settings.json API keys. Previously, an API key in settings.json would trump OAuth, causing users logged in with a plan (unlimited tokens) to be billed via PAYG instead.

## [0.27.7] - 2025-12-24

### Fixed

- **Thinking tag leakage**: Fixed Claude mimicking literal `</thinking>` tags in responses. Unsigned thinking blocks (from aborted streams) are now converted to plain text without `<thinking>` tags. The TUI still displays them as thinking blocks. ([#302](https://github.com/badlogic/pi-mono/pull/302) by [@nicobailon](https://github.com/nicobailon))

## [0.27.6] - 2025-12-24

### Added

- **Compaction hook improvements**: The `before_compact` session event now includes:

  - `previousSummary`: Summary from the last compaction (if any), so hooks can preserve accumulated context
  - `messagesToKeep`: Messages that will be kept after the summary (recent turns), in addition to `messagesToSummarize`
  - `resolveApiKey`: Function to resolve API keys for any model (checks settings, OAuth, env vars)
  - Removed `apiKey` string in favor of `resolveApiKey` for more flexibility

- **SessionManager API cleanup**:
  - Renamed `loadSessionFromEntries()` to `buildSessionContext()` (builds LLM context from entries, handling compaction)
  - Renamed `loadEntries()` to `getEntries()` (returns defensive copy of all session entries)
  - Added `buildSessionContext()` method to SessionManager

## [0.27.5] - 2025-12-24

### Added

- **HTML export syntax highlighting**: Code blocks in markdown and tool outputs (read, write) now have syntax highlighting using highlight.js with theme-aware colors matching the TUI.
- **HTML export improvements**: Render markdown server-side using marked (tables, headings, code blocks, etc.), honor user's chosen theme (light/dark), add image rendering for user messages, and style code blocks with TUI-like language markers. ([@scutifer](https://github.com/scutifer))

### Fixed

- **Ghostty inline images in tmux**: Fixed terminal detection for Ghostty when running inside tmux by checking `GHOSTTY_RESOURCES_DIR` env var. ([#299](https://github.com/badlogic/pi-mono/pull/299) by [@nicobailon](https://github.com/nicobailon))

## [0.27.4] - 2025-12-24

### Fixed

- **Symlinked skill directories**: Skills in symlinked directories (e.g., `~/.pi/agent/skills/my-skills -> /path/to/skills`) are now correctly discovered and loaded.

## [0.27.3] - 2025-12-24

### Added

- **API keys in settings.json**: Store API keys in `~/.pi/agent/settings.json` under the `apiKeys` field (e.g., `{ "apiKeys": { "anthropic": "sk-..." } }`). Settings keys take priority over environment variables. ([#295](https://github.com/badlogic/pi-mono/issues/295))

### Fixed

- **Allow startup without API keys**: Interactive mode no longer throws when no API keys are configured. Users can now start the agent and use `/login` to authenticate. ([#288](https://github.com/badlogic/pi-mono/issues/288))
- **`--system-prompt` file path support**: The `--system-prompt` argument now correctly resolves file paths (like `--append-system-prompt` already did). ([#287](https://github.com/badlogic/pi-mono/pull/287) by [@scutifer](https://github.com/scutifer))

## [0.27.2] - 2025-12-23

### Added

- **Skip conversation restore on branch**: Hooks can return `{ skipConversationRestore: true }` from `before_branch` to create the branched session file without restoring conversation messages. Useful for checkpoint hooks that restore files separately. ([#286](https://github.com/badlogic/pi-mono/pull/286) by [@nicobarray](https://github.com/nicobarray))

## [0.27.1] - 2025-12-22

### Fixed

- **Skill discovery performance**: Skip `node_modules` directories when recursively scanning for skills. Fixes ~60ms startup delay when skill directories contain npm dependencies.

### Added

- **Startup timing instrumentation**: Set `PI_TIMING=1` to see startup performance breakdown (interactive mode only).

## [0.27.0] - 2025-12-22

### Breaking

- **Session hooks API redesign**: Merged `branch` event into `session` event. `BranchEvent`, `BranchEventResult` types and `pi.on("branch", ...)` removed. Use `pi.on("session", ...)` with `reason: "before_branch" | "branch"` instead. `AgentSession.branch()` returns `{ cancelled }` instead of `{ skipped }`. `AgentSession.reset()` and `switchSession()` now return `boolean` (false if cancelled by hook). RPC commands `reset`, `switch_session`, and `branch` now include `cancelled` in response data. ([#278](https://github.com/badlogic/pi-mono/issues/278))

### Added

- **Session lifecycle hooks**: Added `before_*` variants (`before_switch`, `before_clear`, `before_branch`) that fire before actions and can be cancelled with `{ cancel: true }`. Added `shutdown` reason for graceful exit handling. ([#278](https://github.com/badlogic/pi-mono/issues/278))

### Fixed

- **File tab completion display**: File paths no longer get cut off early. Folders now show trailing `/` and removed redundant "directory"/"file" labels to maximize horizontal space. ([#280](https://github.com/badlogic/pi-mono/issues/280))

- **Bash tool visual line truncation**: Fixed bash tool output in collapsed mode to use visual line counting (accounting for line wrapping) instead of logical line counting. Now consistent with bash-execution.ts behavior. Extracted shared `truncateToVisualLines` utility. ([#275](https://github.com/badlogic/pi-mono/issues/275))

## [0.26.1] - 2025-12-22

### Fixed

- **SDK tools respect cwd**: Core tools (bash, read, edit, write, grep, find, ls) now properly use the `cwd` option from `createAgentSession()`. Added tool factory functions (`createBashTool`, `createReadTool`, etc.) for SDK users who specify custom `cwd` with explicit tools. ([#279](https://github.com/badlogic/pi-mono/issues/279))

## [0.26.0] - 2025-12-22

### Added

- **SDK for programmatic usage**: New `createAgentSession()` factory with full control over model, tools, hooks, skills, session persistence, and settings. Philosophy: "omit to discover, provide to override". Includes 12 examples and comprehensive documentation. ([#272](https://github.com/badlogic/pi-mono/issues/272))

- **Project-specific settings**: Settings now load from both `~/.pi/agent/settings.json` (global) and `<cwd>/.pi/settings.json` (project). Project settings override global with deep merge for nested objects. Project settings are read-only (for version control). ([#276](https://github.com/badlogic/pi-mono/pull/276))

- **SettingsManager static factories**: `SettingsManager.create(cwd?, agentDir?)` for file-based settings, `SettingsManager.inMemory(settings?)` for testing. Added `applyOverrides()` for programmatic overrides.

- **SessionManager static factories**: `SessionManager.create()`, `SessionManager.open()`, `SessionManager.continueRecent()`, `SessionManager.inMemory()`, `SessionManager.list()` for flexible session management.

## [0.25.4] - 2025-12-22

### Fixed

- **Syntax highlighting stderr spam**: Fixed cli-highlight logging errors to stderr when markdown contains malformed code fences (e.g., missing newlines around closing backticks). Now validates language identifiers before highlighting and falls back silently to plain text. ([#274](https://github.com/badlogic/pi-mono/issues/274))

## [0.25.3] - 2025-12-21

### Added

- **Gemini 3 preview models**: Added `gemini-3-pro-preview` and `gemini-3-flash-preview` to the google-gemini-cli provider. ([#264](https://github.com/badlogic/pi-mono/pull/264) by [@LukeFost](https://github.com/LukeFost))

- **External editor support**: Press `Ctrl+G` to edit your message in an external editor. Uses `$VISUAL` or `$EDITOR` environment variable. On successful save, the message is replaced; on cancel, the original is kept. ([#266](https://github.com/badlogic/pi-mono/pull/266) by [@aliou](https://github.com/aliou))

- **Process suspension**: Press `Ctrl+Z` to suspend pi and return to the shell. Resume with `fg` as usual. ([#267](https://github.com/badlogic/pi-mono/pull/267) by [@aliou](https://github.com/aliou))

- **Configurable skills directories**: Added granular control over skill sources with `enableCodexUser`, `enableClaudeUser`, `enableClaudeProject`, `enablePiUser`, `enablePiProject` toggles, plus `customDirectories` and `ignoredSkills` settings. ([#269](https://github.com/badlogic/pi-mono/pull/269) by [@nicobailon](https://github.com/nicobailon))

- **Skills CLI filtering**: Added `--skills <patterns>` flag for filtering skills with glob patterns. Also added `includeSkills` setting and glob pattern support for `ignoredSkills`. ([#268](https://github.com/badlogic/pi-mono/issues/268))

## [0.25.2] - 2025-12-21

### Fixed

- **Image shifting in tool output**: Fixed an issue where images in tool output would shift down (due to accumulating spacers) each time the tool output was expanded or collapsed via Ctrl+O.

## [0.25.1] - 2025-12-21

### Fixed

- **Gemini image reading broken**: Fixed the `read` tool returning images causing flaky/broken responses with Gemini models. Images in tool results are now properly formatted per the Gemini API spec.

- **Tab completion for absolute paths**: Fixed tab completion producing `//tmp` instead of `/tmp/`. Also fixed symlinks to directories (like `/tmp`) not getting a trailing slash, which prevented continuing to tab through subdirectories.

## [0.25.0] - 2025-12-20

### Added

- **Interruptible tool execution**: Queuing a message while tools are executing now interrupts the current tool batch. Remaining tools are skipped with an error result, and your queued message is processed immediately. Useful for redirecting the agent mid-task. ([#259](https://github.com/badlogic/pi-mono/pull/259) by [@steipete](https://github.com/steipete))

- **Google Gemini CLI OAuth provider**: Access Gemini 2.0/2.5 models for free via Google Cloud Code Assist. Login with `/login` and select "Google Gemini CLI". Uses your Google account with rate limits.

- **Google Antigravity OAuth provider**: Access Gemini 3, Claude (sonnet/opus thinking models), and GPT-OSS models for free via Google's Antigravity sandbox. Login with `/login` and select "Antigravity". Uses your Google account with rate limits.

### Changed

- **Model selector respects --models scope**: The `/model` command now only shows models specified via `--models` flag when that flag is used, instead of showing all available models. This prevents accidentally selecting models from unintended providers. ([#255](https://github.com/badlogic/pi-mono/issues/255))

### Fixed

- **Connection errors not retried**: Added "connection error" to the list of retryable errors so Anthropic connection drops trigger auto-retry instead of silently failing. ([#252](https://github.com/badlogic/pi-mono/issues/252))

- **Thinking level not clamped on model switch**: Fixed TUI showing xhigh thinking level after switching to a model that doesn't support it. Thinking level is now automatically clamped to model capabilities. ([#253](https://github.com/badlogic/pi-mono/issues/253))

- **Cross-model thinking handoff**: Fixed error when switching between models with different thinking signature formats (e.g., GPT-OSS to Claude thinking models via Antigravity). Thinking blocks without signatures are now converted to text with `<thinking>` delimiters.

## [0.24.5] - 2025-12-20

### Fixed

- **Input buffering in iTerm2**: Fixed Ctrl+C, Ctrl+D, and other keys requiring multiple presses in iTerm2. The cell size query response parser was incorrectly holding back keyboard input.

## [0.24.4] - 2025-12-20

### Fixed

- **Arrow keys and Enter in selector components**: Fixed arrow keys and Enter not working in model selector, session selector, OAuth selector, and other selector components when Caps Lock or Num Lock is enabled. ([#243](https://github.com/badlogic/pi-mono/issues/243))

## [0.24.3] - 2025-12-19

### Fixed

- **Footer overflow on narrow terminals**: Fixed footer path display exceeding terminal width when resizing to very narrow widths, causing rendering crashes. /arminsayshi

## [0.24.2] - 2025-12-20

### Fixed

- **More Kitty keyboard protocol fixes**: Fixed Backspace, Enter, Home, End, and Delete keys not working with Caps Lock enabled. The initial fix in 0.24.1 missed several key handlers that were still using raw byte detection. Now all key handlers use the helper functions that properly mask out lock key bits. ([#243](https://github.com/badlogic/pi-mono/issues/243))

## [0.24.1] - 2025-12-19

### Added

- **OAuth and model config exports**: Scripts using `AgentSession` directly can now import `getAvailableModels`, `getApiKeyForModel`, `findModel`, `login`, `logout`, and `getOAuthProviders` from `@mariozechner/pi-coding-agent` to reuse OAuth token storage and model resolution. ([#245](https://github.com/badlogic/pi-mono/issues/245))

- **xhigh thinking level for gpt-5.2 models**: The thinking level selector and shift+tab cycling now show xhigh option for gpt-5.2 and gpt-5.2-codex models (in addition to gpt-5.1-codex-max). ([#236](https://github.com/badlogic/pi-mono/pull/236) by [@theBucky](https://github.com/theBucky))

### Fixed

- **Hooks wrap custom tools**: Custom tools are now executed through the hook wrapper, so `tool_call`/`tool_result` hooks can observe, block, and modify custom tool executions (consistent with hook type docs). ([#248](https://github.com/badlogic/pi-mono/pull/248) by [@nicobailon](https://github.com/nicobailon))

- **Hook onUpdate callback forwarding**: The `onUpdate` callback is now correctly forwarded through the hook wrapper, fixing custom tool progress updates. ([#238](https://github.com/badlogic/pi-mono/pull/238) by [@nicobailon](https://github.com/nicobailon))

- **Terminal cleanup on Ctrl+C in session selector**: Fixed terminal not being properly restored when pressing Ctrl+C in the session selector. ([#247](https://github.com/badlogic/pi-mono/pull/247) by [@aliou](https://github.com/aliou))

- **OpenRouter models with colons in IDs**: Fixed parsing of OpenRouter model IDs that contain colons (e.g., `openrouter:meta-llama/llama-4-scout:free`). ([#242](https://github.com/badlogic/pi-mono/pull/242) by [@aliou](https://github.com/aliou))

- **Global AGENTS.md loaded twice**: Fixed global AGENTS.md being loaded twice when present in both `~/.pi/agent/` and the current directory. ([#239](https://github.com/badlogic/pi-mono/pull/239) by [@aliou](https://github.com/aliou))

- **Kitty keyboard protocol on Linux**: Fixed keyboard input not working in Ghostty on Linux when Num Lock is enabled. The Kitty protocol includes Caps Lock and Num Lock state in modifier values, which broke key detection. Now correctly masks out lock key bits when matching keyboard shortcuts. ([#243](https://github.com/badlogic/pi-mono/issues/243))

- **Emoji deletion and cursor movement**: Backspace, Delete, and arrow keys now correctly handle multi-codepoint characters like emojis. Previously, deleting an emoji would leave partial bytes, corrupting the editor state. ([#240](https://github.com/badlogic/pi-mono/issues/240))

## [0.24.0] - 2025-12-19

### Added

- **Subagent orchestration example**: Added comprehensive custom tool example for spawning and orchestrating sub-agents with isolated context windows. Includes scout/planner/reviewer/worker agents and workflow commands for multi-agent pipelines. ([#215](https://github.com/badlogic/pi-mono/pull/215) by [@nicobailon](https://github.com/nicobailon))

- **`getMarkdownTheme()` export**: Custom tools can now import `getMarkdownTheme()` from `@mariozechner/pi-coding-agent` to use the same markdown styling as the main UI.

- **`pi.exec()` signal and timeout support**: Custom tools and hooks can now pass `{ signal, timeout }` options to `pi.exec()` for cancellation and timeout handling. The result includes a `killed` flag when the process was terminated.

- **Kitty keyboard protocol support**: Shift+Enter, Alt+Enter, Shift+Tab, Ctrl+D, and all Ctrl+key combinations now work in Ghostty, Kitty, WezTerm, and other modern terminals. ([#225](https://github.com/badlogic/pi-mono/pull/225) by [@kim0](https://github.com/kim0))

- **Dynamic API key refresh**: OAuth tokens (GitHub Copilot, Anthropic OAuth) are now refreshed before each LLM call, preventing failures in long-running agent loops where tokens expire mid-session. ([#223](https://github.com/badlogic/pi-mono/pull/223) by [@kim0](https://github.com/kim0))

- **`/hotkeys` command**: Shows all keyboard shortcuts in a formatted table.

- **Markdown table borders**: Tables now render with proper top and bottom borders.

### Changed

- **Subagent example improvements**: Parallel mode now streams updates from all tasks. Chain mode shows all completed steps during streaming. Expanded view uses proper markdown rendering with syntax highlighting. Usage footer shows turn count.

- **Skills standard compliance**: Skills now adhere to the [Agent Skills standard](https://agentskills.io/specification). Validates name (must match parent directory, lowercase, max 64 chars), description (required, max 1024 chars), and frontmatter fields. Warns on violations but remains lenient. Prompt format changed to XML structure. Removed `{baseDir}` placeholder in favor of relative paths. ([#231](https://github.com/badlogic/pi-mono/issues/231))

### Fixed

- **JSON mode stdout flush**: Fixed race condition where `pi --mode json` could exit before all output was written to stdout, causing consumers to miss final events.

- **Symlinked tools, hooks, and slash commands**: Discovery now correctly follows symlinks when scanning for custom tools, hooks, and slash commands. ([#219](https://github.com/badlogic/pi-mono/pull/219), [#232](https://github.com/badlogic/pi-mono/pull/232) by [@aliou](https://github.com/aliou))

### Breaking Changes

- **Custom tools now require `index.ts` entry point**: Auto-discovered custom tools must be in a subdirectory with an `index.ts` file. The old pattern `~/.pi/agent/tools/mytool.ts` must become `~/.pi/agent/tools/mytool/index.ts`. This allows multi-file tools to import helper modules. Explicit paths via `--tool` or `settings.json` still work with any `.ts` file.

- **Hook `tool_result` event restructured**: The `ToolResultEvent` now exposes full tool result data instead of just text. ([#233](https://github.com/badlogic/pi-mono/pull/233))
  - Removed: `result: string` field
  - Added: `content: (TextContent | ImageContent)[]` - full content array
  - Added: `details: unknown` - tool-specific details (typed per tool via discriminated union on `toolName`)
  - `ToolResultEventResult.result` renamed to `ToolResultEventResult.text` (removed), use `content` instead
  - Hook handlers returning `{ result: "..." }` must change to `{ content: [{ type: "text", text: "..." }] }`
  - Built-in tool details types exported: `BashToolDetails`, `ReadToolDetails`, `GrepToolDetails`, `FindToolDetails`, `LsToolDetails`, `TruncationResult`
  - Type guards exported for narrowing: `isBashToolResult`, `isReadToolResult`, `isEditToolResult`, `isWriteToolResult`, `isGrepToolResult`, `isFindToolResult`, `isLsToolResult`

## [0.23.4] - 2025-12-18

### Added

- **Syntax highlighting**: Added syntax highlighting for markdown code blocks, read tool output, and write tool content. Uses cli-highlight with theme-aware color mapping and VS Code-style syntax colors. ([#214](https://github.com/badlogic/pi-mono/pull/214) by [@svkozak](https://github.com/svkozak))

- **Intra-line diff highlighting**: Edit tool now shows word-level changes with inverse highlighting when a single line is modified. Multi-line changes show all removed lines first, then all added lines.

### Fixed

- **Gemini tool result format**: Fixed tool result format for Gemini 3 Flash Preview which strictly requires `{ output: value }` for success and `{ error: value }` for errors. Previous format using `{ result, isError }` was rejected by newer Gemini models. ([#213](https://github.com/badlogic/pi-mono/issues/213), [#220](https://github.com/badlogic/pi-mono/pull/220))

- **Google baseUrl configuration**: Google provider now respects `baseUrl` configuration for custom endpoints or API proxies. ([#216](https://github.com/badlogic/pi-mono/issues/216), [#221](https://github.com/badlogic/pi-mono/pull/221) by [@theBucky](https://github.com/theBucky))

- **Google provider FinishReason**: Added handling for new `IMAGE_RECITATION` and `IMAGE_OTHER` finish reasons. Upgraded @google/genai to 1.34.0.

## [0.23.3] - 2025-12-17

### Fixed

- Check for compaction before submitting user prompt, not just after agent turn ends. This catches cases where user aborts mid-response and context is already near the limit.

### Changed

- Improved system prompt documentation section with clearer pointers to specific doc files for custom models, themes, skills, hooks, custom tools, and RPC.

- Cleaned up documentation:

  - `theme.md`: Added missing color tokens (`thinkingXhigh`, `bashMode`)
  - `skills.md`: Rewrote with better framing and examples
  - `hooks.md`: Fixed timeout/error handling docs, added import aliases section
  - `custom-tools.md`: Added intro with use cases and comparison table
  - `rpc.md`: Added missing `hook_error` event documentation
  - `README.md`: Complete settings table, condensed philosophy section, standardized OAuth docs

- Hooks loader now supports same import aliases as custom tools (`@sinclair/typebox`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `@mariozechner/pi-coding-agent`).

### Breaking Changes

- **Hooks**: `turn_end` event's `toolResults` type changed from `AppMessage[]` to `ToolResultMessage[]`. If you have hooks that handle `turn_end` events and explicitly type the results, update your type annotations.

## [0.23.2] - 2025-12-17

### Fixed

- Fixed Claude models via GitHub Copilot re-answering all previous prompts in multi-turn conversations. The issue was that assistant message content was sent as an array instead of a string, which Copilot's Claude adapter misinterpreted. Also added missing `Openai-Intent: conversation-edits` header and fixed `X-Initiator` logic to check for any assistant/tool message in history. ([#209](https://github.com/badlogic/pi-mono/issues/209))

- Detect image MIME type via file magic (read tool and `@file` attachments), not filename extension.

- Fixed markdown tables overflowing terminal width. Tables now wrap cell contents to fit available width instead of breaking borders mid-row. ([#206](https://github.com/badlogic/pi-mono/pull/206) by [@kim0](https://github.com/kim0))

## [0.23.1] - 2025-12-17

### Fixed

- Fixed TUI performance regression caused by Box component lacking render caching. Built-in tools now use Text directly (like v0.22.5), and Box has proper caching for custom tool rendering.

- Fixed custom tools failing to load from `~/.pi/agent/tools/` when pi is installed globally. Module imports (`@sinclair/typebox`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`) are now resolved via aliases.

## [0.23.0] - 2025-12-17

### Added

- **Custom tools**: Extend pi with custom tools written in TypeScript. Tools can provide custom TUI rendering, interact with users via `pi.ui` (select, confirm, input, notify), and maintain state across sessions via `onSession` callback. See [docs/custom-tools.md](docs/custom-tools.md) and [examples/custom-tools/](examples/custom-tools/). ([#190](https://github.com/badlogic/pi-mono/issues/190))

- **Hook and tool examples**: Added `examples/hooks/` and `examples/custom-tools/` with working examples. Examples are now bundled in npm and binary releases.

### Breaking Changes

- **Hooks**: Replaced `session_start` and `session_switch` events with unified `session` event. Use `event.reason` (`"start" | "switch" | "clear"`) to distinguish. Event now includes `entries` array for state reconstruction.

## [0.22.5] - 2025-12-17

### Fixed

- Fixed `--session` flag not saving sessions in print mode (`-p`). The session manager was never receiving events because no subscriber was attached.

## [0.22.4] - 2025-12-17

### Added

- `--list-models [search]` CLI flag to list available models with optional fuzzy search. Shows provider, model ID, context window, max output, thinking support, and image support. Only lists models with configured API keys. ([#203](https://github.com/badlogic/pi-mono/issues/203))

### Fixed

- Fixed tool execution showing green (success) background while still running. Now correctly shows gray (pending) background until the tool completes.

## [0.22.3] - 2025-12-16

### Added

- **Streaming bash output**: Bash tool now streams output in real-time during execution. The TUI displays live progress with the last 5 lines visible (expandable with ctrl+o). ([#44](https://github.com/badlogic/pi-mono/issues/44))

### Changed

- **Tool output display**: When collapsed, tool output now shows the last N lines instead of the first N lines, making streaming output more useful.

- Updated `@mariozechner/pi-ai` with X-Initiator header support for GitHub Copilot, ensuring agent calls are not deducted from quota. ([#200](https://github.com/badlogic/pi-mono/pull/200) by [@kim0](https://github.com/kim0))

### Fixed

- Fixed editor text being cleared during compaction. Text typed while compaction is running is now preserved. ([#179](https://github.com/badlogic/pi-mono/issues/179))
- Improved RGB to 256-color mapping for terminals without truecolor support. Now correctly uses grayscale ramp for neutral colors and preserves semantic tints (green for success, red for error, blue for pending) instead of mapping everything to wrong cube colors.
- `/think off` now actually disables thinking for all providers. Previously, providers like Gemini with "dynamic thinking" enabled by default would still use thinking even when turned off. ([#180](https://github.com/badlogic/pi-mono/pull/180) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.22.2] - 2025-12-15

### Changed

- Updated `@mariozechner/pi-ai` with interleaved thinking enabled by default for Anthropic Claude 4 models.

## [0.22.1] - 2025-12-15

_Dedicated to Peter's shoulder ([@steipete](https://twitter.com/steipete))_

### Changed

- Updated `@mariozechner/pi-ai` with interleaved thinking support for Anthropic models.

## [0.22.0] - 2025-12-15

### Added

- **GitHub Copilot support**: Use GitHub Copilot models via OAuth login (`/login` -> "GitHub Copilot"). Supports both github.com and GitHub Enterprise. Models are sourced from models.dev and include Claude, GPT, Gemini, Grok, and more. All models are automatically enabled after login. ([#191](https://github.com/badlogic/pi-mono/pull/191) by [@cau1k](https://github.com/cau1k))

### Fixed

- Model selector fuzzy search now matches against provider name (not just model ID) and supports space-separated tokens where all tokens must match

## [0.21.0] - 2025-12-14

### Added

- **Inline image rendering**: Terminals supporting Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images now render images inline in tool output. Aspect ratio is preserved by querying terminal cell dimensions on startup. Toggle with `/show-images` command or `terminal.showImages` setting. Falls back to text placeholder on unsupported terminals or when disabled. ([#177](https://github.com/badlogic/pi-mono/pull/177) by [@nicobailon](https://github.com/nicobailon))

- **Gemini 3 Pro thinking levels**: Thinking level selector now works with Gemini 3 Pro models. Minimal/low map to Google's LOW, medium/high map to Google's HIGH. ([#176](https://github.com/badlogic/pi-mono/pull/176) by [@markusylisiurunen](https://github.com/markusylisiurunen))

### Fixed

- Fixed read tool failing on macOS screenshot filenames due to Unicode Narrow No-Break Space (U+202F) in timestamp. Added fallback to try macOS variant paths and consolidated duplicate expandPath functions into shared path-utils.ts. ([#181](https://github.com/badlogic/pi-mono/pull/181) by [@nicobailon](https://github.com/nicobailon))

- Fixed double blank lines rendering after markdown code blocks ([#173](https://github.com/badlogic/pi-mono/pull/173) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.20.1] - 2025-12-13

### Added

- **Exported skills API**: `loadSkillsFromDir`, `formatSkillsForPrompt`, and related types are now exported for use by other packages (e.g., mom).

## [0.20.0] - 2025-12-13

### Breaking Changes

- **Pi skills now use `SKILL.md` convention**: Pi skills must now be named `SKILL.md` inside a directory, matching Codex CLI format. Previously any `*.md` file was treated as a skill. Migrate by renaming `~/.pi/agent/skills/foo.md` to `~/.pi/agent/skills/foo/SKILL.md`.

### Added

- Display loaded skills on startup in interactive mode

## [0.19.1] - 2025-12-12

### Fixed

- Documentation: Added skills system documentation to README (setup, usage, CLI flags, settings)

## [0.19.0] - 2025-12-12

### Added

- **Skills system**: Auto-discover and load instruction files on-demand. Supports Claude Code (`~/.claude/skills/*/SKILL.md`), Codex CLI (`~/.codex/skills/`), and Pi-native formats (`~/.pi/agent/skills/`, `.pi/skills/`). Skills are listed in system prompt with descriptions, agent loads them via read tool when needed. Supports `{baseDir}` placeholder. Disable with `--no-skills` or `skills.enabled: false` in settings. ([#169](https://github.com/badlogic/pi-mono/issues/169))

- **Version flag**: Added `--version` / `-v` flag to display the current version and exit. ([#170](https://github.com/badlogic/pi-mono/pull/170))

## [0.18.2] - 2025-12-11

### Added

- **Auto-retry on transient errors**: Automatically retries requests when providers return overloaded, rate limit, or server errors (429, 500, 502, 503, 504). Uses exponential backoff (2s, 4s, 8s). Shows retry status in TUI with option to cancel via Escape. Configurable in `settings.json` via `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`. RPC mode emits `auto_retry_start` and `auto_retry_end` events. ([#157](https://github.com/badlogic/pi-mono/issues/157))

- **HTML export line numbers**: Read tool calls in HTML exports now display line number ranges (e.g., `file.txt:10-20`) when offset/limit parameters are used, matching the TUI display format. Line numbers appear in yellow color for better visibility. ([#166](https://github.com/badlogic/pi-mono/issues/166))

### Fixed

- **Branch selector now works with single message**: Previously the branch selector would not open when there was only one user message. Now it correctly allows branching from any message, including the first one. This is needed for checkpoint hooks to restore state from before the first message. ([#163](https://github.com/badlogic/pi-mono/issues/163))

- **In-memory branching for `--no-session` mode**: Branching now works correctly in `--no-session` mode without creating any session files. The conversation is truncated in memory.

- **Git branch indicator now works in subdirectories**: The footer's git branch detection now walks up the directory hierarchy to find the git root, so it works when running pi from a subdirectory of a repository. ([#156](https://github.com/badlogic/pi-mono/issues/156))

## [0.18.1] - 2025-12-10

### Added

- **Mistral provider**: Added support for Mistral AI models. Set `MISTRAL_API_KEY` environment variable to use.

### Fixed

- Fixed print mode (`-p`) not exiting after output when custom themes are present (theme watcher now properly stops in print mode) ([#161](https://github.com/badlogic/pi-mono/issues/161))

## [0.18.0] - 2025-12-10

### Added

- **Hooks system**: TypeScript modules that extend agent behavior by subscribing to lifecycle events. Hooks can intercept tool calls, prompt for confirmation, modify results, and inject messages from external sources. Auto-discovered from `~/.pi/agent/hooks/*.ts` and `.pi/hooks/*.ts`. Thanks to [@nicobailon](https://github.com/nicobailon) for the collaboration on the design and implementation. ([#145](https://github.com/badlogic/pi-mono/issues/145), supersedes [#158](https://github.com/badlogic/pi-mono/pull/158))

- **`pi.send()` API**: Hooks can inject messages into the agent session from external sources (file watchers, webhooks, CI systems). If streaming, messages are queued; otherwise a new agent loop starts immediately.

- **`--hook <path>` CLI flag**: Load hook files directly for testing without modifying settings.

- **Hook events**: `session_start`, `session_switch`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_call` (can block), `tool_result` (can modify), `branch`.

- **Hook UI primitives**: `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, `ctx.ui.notify()` for interactive prompts from hooks.

- **Hooks documentation**: Full API reference at `docs/hooks.md`, shipped with npm package.

## [0.17.0] - 2025-12-09

### Changed

- **Simplified compaction flow**: Removed proactive compaction (aborting mid-turn when threshold approached). Compaction now triggers in two cases only: (1) overflow error from LLM, which compacts and auto-retries, or (2) threshold crossed after a successful turn, which compacts without retry.

- **Compaction retry uses `Agent.continue()`**: Auto-retry after overflow now uses the new `continue()` API instead of re-sending the user message, preserving exact context state.

- **Merged turn prefix summary**: When a turn is split during compaction, the turn prefix summary is now merged into the main history summary instead of being stored separately.

### Added

- **`isCompacting` property on AgentSession**: Check if auto-compaction is currently running.

- **Session compaction indicator**: When resuming a compacted session, displays "Session compacted N times" status message.

### Fixed

- **Block input during compaction**: User input is now blocked while auto-compaction is running to prevent race conditions.

- **Skip error messages in usage calculation**: Context size estimation now skips both aborted and error messages, as neither have valid usage data.

## [0.16.0] - 2025-12-09

### Breaking Changes

- **New RPC protocol**: The RPC mode (`--mode rpc`) has been completely redesigned with a new JSON protocol. The old protocol is no longer supported. See [`docs/rpc.md`](docs/rpc.md) for the new protocol documentation and [`test/rpc-example.ts`](test/rpc-example.ts) for a working example. Includes `RpcClient` TypeScript class for easy integration. ([#91](https://github.com/badlogic/pi-mono/issues/91))

### Changed

- **README restructured**: Reorganized documentation from 30+ flat sections into 10 logical groups. Converted verbose subsections to scannable tables. Consolidated philosophy sections. Reduced size by ~60% while preserving all information.

## [0.15.0] - 2025-12-09

### Changed

- **Major code refactoring**: Restructured codebase for better maintainability and separation of concerns. Moved files into organized directories (`core/`, `modes/`, `utils/`, `cli/`). Extracted `AgentSession` class as central session management abstraction. Split `main.ts` and `tui-renderer.ts` into focused modules. See `DEVELOPMENT.md` for the new code map. ([#153](https://github.com/badlogic/pi-mono/issues/153))

## [0.14.2] - 2025-12-08

### Added

- `/debug` command now includes agent messages as JSONL in the output

### Fixed

- Fix crash when bash command outputs binary data (e.g., `curl` downloading a video file)

## [0.14.1] - 2025-12-08

### Fixed

- Fix build errors with tsgo 7.0.0-dev.20251208.1 by properly importing `ReasoningEffort` type

## [0.14.0] - 2025-12-08

### Breaking Changes

- **Custom themes require new color tokens**: Themes must now include `thinkingXhigh` and `bashMode` color tokens. The theme loader provides helpful error messages listing missing tokens. See built-in themes (dark.json, light.json) for reference values.

### Added

- **OpenAI compatibility overrides in models.json**: Custom models using `openai-completions` API can now specify a `compat` object to override provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`). Useful for LiteLLM, custom proxies, and other non-standard endpoints. ([#133](https://github.com/badlogic/pi-mono/issues/133), thanks @fink-andreas for the initial idea and PR)

- **xhigh thinking level**: Added `xhigh` thinking level for OpenAI codex-max models. Cycle through thinking levels with Shift+Tab; `xhigh` appears only when using a codex-max model. ([#143](https://github.com/badlogic/pi-mono/issues/143))

- **Collapse changelog setting**: Add `"collapseChangelog": true` to `~/.pi/agent/settings.json` to show a condensed "Updated to vX.Y.Z" message instead of the full changelog after updates. Use `/changelog` to view the full changelog. ([#148](https://github.com/badlogic/pi-mono/issues/148))

- **Bash mode**: Execute shell commands directly from the editor by prefixing with `!` (e.g., `!ls -la`). Output streams in real-time, is added to the LLM context, and persists in session history. Supports multiline commands, cancellation (Escape), truncation for large outputs, and preview/expand toggle (Ctrl+O). Also available in RPC mode via `{"type":"bash","command":"..."}`. ([#112](https://github.com/badlogic/pi-mono/pull/112), original implementation by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.13.2] - 2025-12-07

### Changed

- **Tool output truncation**: All tools now enforce consistent truncation limits with actionable notices for the LLM. ([#134](https://github.com/badlogic/pi-mono/issues/134))
  - **Limits**: 2000 lines OR 50KB (whichever hits first), never partial lines
  - **read**: Shows `[Showing lines X-Y of Z. Use offset=N to continue]`. If first line exceeds 50KB, suggests bash command
  - **bash**: Tail truncation with temp file. Shows `[Showing lines X-Y of Z. Full output: /tmp/...]`
  - **grep**: Pre-truncates match lines to 500 chars. Shows match limit and line truncation notices
  - **find/ls**: Shows result/entry limit notices
  - TUI displays truncation warnings in yellow at bottom of tool output (visible even when collapsed)

## [0.13.1] - 2025-12-06

### Added

- **Flexible Windows shell configuration**: The bash tool now supports multiple shell sources beyond Git Bash. Resolution order: (1) custom `shellPath` in settings.json, (2) Git Bash in standard locations, (3) any bash.exe on PATH. This enables Cygwin, MSYS2, and other bash environments. Configure with `~/.pi/agent/settings.json`: `{"shellPath": "C:\\cygwin64\\bin\\bash.exe"}`.

### Fixed

- **Windows binary detection**: Fixed Bun compiled binary detection on Windows by checking for URL-encoded `%7EBUN` in addition to `$bunfs` and `~BUN` in `import.meta.url`. This ensures the binary correctly locates supporting files (package.json, themes, etc.) next to the executable.

## [0.12.15] - 2025-12-06

### Fixed

- **Editor crash with emojis/CJK characters**: Fixed crash when pasting or typing text containing wide characters (emojis like ✅, CJK characters) that caused line width to exceed terminal width. The editor now uses grapheme-aware text wrapping with proper visible width calculation.

## [0.12.14] - 2025-12-06

### Added

- **Double-Escape Branch Shortcut**: Press Escape twice with an empty editor to quickly open the `/branch` selector for conversation branching.

## [0.12.13] - 2025-12-05

### Changed

- **Faster startup**: Version check now runs in parallel with TUI initialization instead of blocking startup for up to 1 second. Update notifications appear in chat when the check completes.

## [0.12.12] - 2025-12-05

### Changed

- **Footer display**: Token counts now use M suffix for millions (e.g., `10.2M` instead of `10184k`). Context display shortened from `61.3% of 200k` to `61.3%/200k`.

### Fixed

- **Multi-key sequences in inputs**: Inputs like model search now handle multi-key sequences identically to the main prompt editor. ([#122](https://github.com/badlogic/pi-mono/pull/122) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Line wrapping escape codes**: Fixed underline style bleeding into padding when wrapping long URLs. ANSI codes now attach to the correct content, and line-end resets only turn off underline (preserving background colors). ([#109](https://github.com/badlogic/pi-mono/issues/109))

### Added

- **Fuzzy search models and sessions**: Implemented a simple fuzzy search for models and sessions (e.g., `codexmax` now finds `gpt-5.1-codex-max`). ([#122](https://github.com/badlogic/pi-mono/pull/122) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Prompt History Navigation**: Browse previously submitted prompts using Up/Down arrow keys when the editor is empty. Press Up to cycle through older prompts, Down to return to newer ones or clear the editor. Similar to shell history and Claude Code's prompt history feature. History is session-scoped and stores up to 100 entries. ([#121](https://github.com/badlogic/pi-mono/pull/121) by [@nicobailon](https://github.com/nicobailon))
- **`/resume` Command**: Switch to a different session mid-conversation. Opens an interactive selector showing all available sessions. Equivalent to the `--resume` CLI flag but can be used without restarting the agent. ([#117](https://github.com/badlogic/pi-mono/pull/117) by [@hewliyang](https://github.com/hewliyang))

## [0.12.11] - 2025-12-05

### Changed

- **Compaction UI**: Simplified collapsed compaction indicator to show warning-colored text with token count instead of styled banner. Removed redundant success message after compaction. ([#108](https://github.com/badlogic/pi-mono/issues/108))

### Fixed

- **Print mode error handling**: `-p` flag now outputs error messages and exits with code 1 when requests fail, instead of silently producing no output.
- **Branch selector crash**: Fixed TUI crash when user messages contained Unicode characters (like `✔` or `›`) that caused line width to exceed terminal width. Now uses proper `truncateToWidth` instead of `substring`.
- **Bash output escape sequences**: Fixed incomplete stripping of terminal escape sequences in bash tool output. `stripAnsi` misses some sequences like standalone String Terminator (`ESC \`), which could cause rendering issues when displaying captured TUI output.
- **Footer overflow crash**: Fixed TUI crash when terminal width is too narrow for the footer stats line. The footer now truncates gracefully instead of overflowing.

### Added

- **`authHeader` option in models.json**: Custom providers can set `"authHeader": true` to automatically add `Authorization: Bearer <apiKey>` header. Useful for providers that require explicit auth headers. ([#81](https://github.com/badlogic/pi-mono/issues/81))
- **`--append-system-prompt` Flag**: Append additional text or file contents to the system prompt. Supports both inline text and file paths. Complements `--system-prompt` for layering custom instructions without replacing the base system prompt. ([#114](https://github.com/badlogic/pi-mono/pull/114) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Thinking Block Toggle**: Added `Ctrl+T` shortcut to toggle visibility of LLM thinking blocks. When toggled off, shows a static "Thinking..." label instead of full content. Useful for reducing visual clutter during long conversations. ([#113](https://github.com/badlogic/pi-mono/pull/113) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.12.10] - 2025-12-04

### Added

- Added `gpt-5.1-codex-max` model support

## [0.12.9] - 2025-12-04

### Added

- **`/copy` Command**: Copy the last agent message to clipboard. Works cross-platform (macOS, Windows, Linux). Useful for extracting text from rendered Markdown output. ([#105](https://github.com/badlogic/pi-mono/pull/105) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.12.8] - 2025-12-04

- Fix: Use CTRL+O consistently for compaction expand shortcut (not CMD+O on Mac)

## [0.12.7] - 2025-12-04

### Added

- **Context Compaction**: Long sessions can now be compacted to reduce context usage while preserving recent conversation history. ([#92](https://github.com/badlogic/pi-mono/issues/92), [docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#context-compaction))
  - `/compact [instructions]`: Manually compact context with optional custom instructions for the summary
  - `/autocompact`: Toggle automatic compaction when context exceeds threshold
  - Compaction summarizes older messages while keeping recent messages (default 20k tokens) verbatim
  - Auto-compaction triggers when context reaches `contextWindow - reserveTokens` (default 16k reserve)
  - Compacted sessions show a collapsible summary in the TUI (toggle with `o` key)
  - HTML exports include compaction summaries as collapsible sections
  - RPC mode supports `{"type":"compact"}` command and auto-compaction (emits compaction events)
- **Branch Source Tracking**: Branched sessions now store `branchedFrom` in the session header, containing the path to the original session file. Useful for tracing session lineage.

## [0.12.5] - 2025-12-03

### Added

- **Forking/Rebranding Support**: All branding (app name, config directory, environment variable names) is now configurable via `piConfig` in `package.json`. Forks can change `piConfig.name` and `piConfig.configDir` to rebrand the CLI without code changes. Affects CLI banner, help text, config paths, and error messages. ([#95](https://github.com/badlogic/pi-mono/pull/95))

### Fixed

- **Bun Binary Detection**: Fixed Bun compiled binary failing to start after Bun updated its virtual filesystem path format from `%7EBUN` to `$bunfs`. ([#95](https://github.com/badlogic/pi-mono/pull/95))

## [0.12.4] - 2025-12-02

### Added

- **RPC Termination Safeguard**: When running as an RPC worker (stdin pipe detected), the CLI now exits immediately if the parent process terminates unexpectedly. Prevents orphaned RPC workers from persisting indefinitely and consuming system resources.

## [0.12.3] - 2025-12-02

### Fixed

- **Rate limit handling**: Anthropic rate limit errors now trigger automatic retry with exponential backoff (base 10s, max 5 retries). Previously these errors would abort the request immediately.
- **Usage tracking during retries**: Retried requests now correctly accumulate token usage from all attempts, not just the final successful one. Fixes artificially low token counts when requests were retried.

## [0.12.2] - 2025-12-02

### Changed

- Removed support for gpt-4.5-preview and o3 models (not yet available)

## [0.12.1] - 2025-12-02

### Added

- **Models**: Added support for OpenAI's new models:
  - `gpt-4.1` (128K context)
  - `gpt-4.1-mini` (128K context)
  - `gpt-4.1-nano` (128K context)
  - `o3` (200K context, reasoning model)
  - `o4-mini` (200K context, reasoning model)

## [0.12.0] - 2025-12-02

### Added

- **`-p, --print` Flag**: Run in non-interactive batch mode. Processes input message or piped stdin without TUI, prints agent response directly to stdout. Ideal for scripting, piping, and CI/CD integration. Exits after first response.
- **`-P, --print-streaming` Flag**: Like `-p`, but streams response tokens as they arrive. Use `--print-streaming --no-markdown` for raw unformatted output.
- **`--print-turn` Flag**: Continue processing tool calls and agent turns until the agent naturally finishes or requires user input. Combine with `-p` for complete multi-turn conversations.
- **`--no-markdown` Flag**: Output raw text without Markdown formatting. Useful when piping output to tools that expect plain text.
- **Streaming Print Mode**: Added internal `printStreaming` option for streaming output in non-TUI mode.
- **RPC Mode `print` Command**: Send `{"type":"print","content":"text"}` to get formatted print output via `print_output` events.
- **Auto-Save in Print Mode**: Print mode conversations are automatically saved to the session directory, allowing later resumption with `--continue`.
- **Thinking level options**: Added `--thinking-off`, `--thinking-minimal`, `--thinking-low`, `--thinking-medium`, `--thinking-high` flags for directly specifying thinking level without the selector UI.

### Changed

- **Simplified RPC Protocol**: Replaced the `prompt` wrapper command with direct message objects. Send `{"role":"user","content":"text"}` instead of `{"type":"prompt","message":"text"}`. Better aligns with message format throughout the codebase.
- **RPC Message Handling**: Agent now processes raw message objects directly, with `timestamp` auto-populated if missing.

## [0.11.9] - 2025-12-02

### Changed

- Change Ctrl+I to Ctrl+P for model cycling shortcut to avoid collision with Tab key in some terminals

## [0.11.8] - 2025-12-01

### Fixed

- Absolute glob patterns (e.g., `/Users/foo/**/*.ts`) are now handled correctly. Previously the leading `/` was being stripped, causing the pattern to be interpreted relative to the current directory.

## [0.11.7] - 2025-12-01

### Fixed

- Fix read path traversal vulnerability. Paths are now validated to prevent reading outside the working directory or its parents. The `read` tool can read from `cwd`, its ancestors (for config files), and all descendants. Symlinks are resolved before validation.

## [0.11.6] - 2025-12-01

### Fixed

- Fix `--system-prompt <path>` allowing the path argument to be captured by the message collection, causing "file not found" errors.

## [0.11.5] - 2025-11-30

### Fixed

- Fixed fatal error "Cannot set properties of undefined (setting '0')" when editing empty files in the `edit` tool.
- Simplified `edit` tool output: Shows only "Edited file.txt" for successful edits instead of verbose search/replace details.
- Fixed fatal error in footer rendering when token counts contain NaN values due to missing usage data.

## [0.11.4] - 2025-11-30

### Fixed

- Fixed chat rendering crash when messages contain preformatted/styled text (e.g., thinking traces with gray italic styling). The markdown renderer now preserves existing ANSI escape codes when they appear before inline elements.

## [0.11.3] - 2025-11-29

### Fixed

- Fix file drop functionality for absolute paths

## [0.11.2] - 2025-11-29

### Fixed

- Fixed TUI crash when pasting content containing tab characters. Tabs are now converted to 4 spaces before insertion.
- Fixed terminal corruption after exit when shell integration sequences (OSC 133) appeared in bash output. These sequences are now stripped along with other ANSI codes.

## [0.11.1] - 2025-11-29

### Added

- Added `fd` integration for file path autocompletion. Now uses `fd` for faster fuzzy file search

### Fixed

- Fixed keyboard shortcuts Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, Ctrl+W, and word navigation (Option+Arrow) not working in VS Code integrated terminal and some other terminal emulators

## [0.11.0] - 2025-11-29

### Added

- **File-based Slash Commands**: Create custom reusable prompts as `.txt` files in `~/.pi/slash-commands/`. Files become `/filename` commands with first-line descriptions. Supports `{{selection}}` placeholder for referencing selected/attached content.
- **`/branch` Command**: Create conversation branches from any previous user message. Opens a selector to pick a message, then creates a new session file starting from that point. Original message text is placed in the editor for modification.
- **Unified Content References**: Both `@path` in messages and `--file path` CLI arguments now use the same attachment system with consistent MIME type detection.
- **Drag & Drop Files**: Drop files onto the terminal to attach them to your message. Supports multiple files and both text and image content.

### Changed

- **Model Selector with Search**: The `/model` command now opens a searchable list. Type to filter models by name, use arrows to navigate, Enter to select.
- **Improved File Autocomplete**: File path completion after `@` now supports fuzzy matching and shows file/directory indicators.
- **Session Selector with Search**: The `--resume` and `--session` flags now open a searchable session list with fuzzy filtering.
- **Attachment Display**: Files added via `@path` are now shown as "Attached: filename" in the user message, separate from the prompt text.
- **Tab Completion**: Tab key now triggers file path autocompletion anywhere in the editor, not just after `@` symbol.

### Fixed

- Fixed autocomplete z-order issue where dropdown could appear behind chat messages
- Fixed cursor position when navigating through wrapped lines in the editor
- Fixed attachment handling for continued sessions to preserve file references

## [0.10.6] - 2025-11-28

### Changed

- Show base64-truncated indicator for large images in tool output

### Fixed

- Fixed image dimensions not being read correctly from PNG/JPEG/GIF files
- Fixed PDF images being incorrectly base64-truncated in display
- Allow reading files from ancestor directories (needed for monorepo configs)

## [0.10.5] - 2025-11-28

### Added

- Full multimodal support: attach images (PNG, JPEG, GIF, WebP) and PDFs to prompts using `@path` syntax or `--file` flag

### Fixed

- `@`-references now handle special characters in file names (spaces, quotes, unicode)
- Fixed cursor positioning issues with multi-byte unicode characters in editor

## [0.10.4] - 2025-11-28

### Fixed

- Removed padding on first user message in TUI to improve visual consistency.

## [0.10.3] - 2025-11-28

### Added

- Added RPC mode (`--rpc`) for programmatic integration. Accepts JSON commands on stdin, emits JSON events on stdout. See [RPC mode documentation](https://github.com/nicobailon/pi-mono/blob/main/packages/coding-agent/README.md#rpc-mode) for protocol details.

### Changed

- Refactored internal architecture to support multiple frontends (TUI, RPC) with shared agent logic.

## [0.10.2] - 2025-11-26

### Added

- Added thinking level persistence. Default level stored in `~/.pi/settings.json`, restored on startup. Per-session overrides saved in session files.
- Added model cycling shortcut: `Ctrl+I` cycles through available models (or scoped models with `-m` flag).
- Added automatic retry with exponential backoff for transient API errors (network issues, 500s, overload).
- Cumulative token usage now shown in footer (total tokens used across all messages in session).
- Added `--system-prompt` flag to override default system prompt with custom text or file contents.
- Footer now shows estimated total cost in USD based on model pricing.

### Changed

- Replaced `--models` flag with `-m/--model` supporting multiple values. Specify models as `provider/model@thinking` (e.g., `anthropic/claude-sonnet-4-20250514@high`). Multiple `-m` flags scope available models for the session.
- Thinking level border now persists visually after selector closes.
- Improved tool result display with collapsible output (default collapsed, expand with `Ctrl+O`).

## [0.10.1] - 2025-11-25

### Added

- Add custom model configuration via `~/.pi/models.json`

## [0.10.0] - 2025-11-25

Initial public release.

### Added

- Interactive TUI with streaming responses
- Conversation session management with `--continue`, `--resume`, and `--session` flags
- Multi-line input support (Shift+Enter or Option+Enter for new lines)
- Tool execution: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `think`
- Thinking mode support for Claude with visual indicator and `/thinking` selector
- File path autocompletion with `@` prefix
- Slash command autocompletion
- `/export` command for HTML session export
- `/model` command for runtime model switching
- `/session` command for session statistics
- Model provider support: Anthropic (Claude), OpenAI, Google (Gemini)
- Git branch display in footer
- Message queueing during streaming responses
- OAuth integration for Gmail and Google Calendar access
- HTML export with syntax highlighting and collapsible sections
