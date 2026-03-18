# Changelog

## [Unreleased]

### Added

- Added `gpt-5.4-mini` model support for the `openai-codex` provider with Codex pricing metadata and unit coverage.

## [0.60.0] - 2026-03-18

### Fixed

- Fixed Gemini 3 and Antigravity image tool results to stay inline as multimodal tool responses instead of being rerouted through separate follow-up messages ([#2052](https://github.com/badlogic/pi-mono/issues/2052))
- Fixed Bedrock Claude 4.6 model metadata to use the correct 200K context window instead of 1M ([#2305](https://github.com/badlogic/pi-mono/issues/2305))
- Fixed lazy built-in provider registration so compiled Bun binaries can still load providers on first use without eagerly bundling provider SDKs ([#2314](https://github.com/badlogic/pi-mono/issues/2314))
- Fixed built-in OAuth callback flows to share aligned callback handling across Anthropic, Gemini CLI, Antigravity, and OpenAI Codex, and fixed OpenAI Codex login to resolve immediately after callback completion ([#2316](https://github.com/badlogic/pi-mono/issues/2316))
- Fixed OpenAI-compatible z.ai `network_error` responses to surface as errors so callers can retry them instead of treating them as successful assistant messages ([#2313](https://github.com/badlogic/pi-mono/issues/2313))
- Fixed OpenAI Responses replay to normalize oversized resumed tool call IDs before sending them back to Codex and other Responses-compatible targets ([#2328](https://github.com/badlogic/pi-mono/issues/2328))

## [0.59.0] - 2026-03-17

### Added

- Added `client` injection support to `AnthropicOptions`, allowing callers to provide a pre-built Anthropic-compatible client instead of constructing one internally.

### Changed

- Lazy-load built-in provider modules and root provider wrappers so importing `@mariozechner/pi-ai` no longer eagerly loads provider SDKs, significantly reducing base startup cost without changing dependency installation footprint ([#2297](https://github.com/badlogic/pi-mono/issues/2297))

### Fixed

- Added provider-specific `responseId` support on `AssistantMessage` for providers that expose upstream response or message identifiers, including Anthropic, OpenAI, Google, Gemini CLI, and Mistral, and added end-to-end coverage for supported OAuth and API key providers ([#2245](https://github.com/badlogic/pi-mono/issues/2245))
- Fixed Claude 4.6 context window overrides in generated model metadata so build-time catalogs reflect the intended values ([#2286](https://github.com/badlogic/pi-mono/issues/2286))

## [0.58.4] - 2026-03-16

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

### Fixed

- Fixed Anthropic OAuth manual login and token refresh by using the localhost callback URI for pasted redirect/code flows and omitting `scope` from refresh-token requests ([#2169](https://github.com/badlogic/pi-mono/issues/2169))

## [0.58.1] - 2026-03-14

### Fixed

- Fixed OpenAI Codex websocket protocol to include required headers and properly terminate SSE streams on connection close ([#1961](https://github.com/badlogic/pi-mono/issues/1961))
- Fixed Bedrock prompt caching being enabled for non-Claude models, causing API errors ([#2053](https://github.com/badlogic/pi-mono/issues/2053))
- Fixed Qwen models via OpenAI-compatible providers by adding `qwen-chat-template` compat mode that uses Qwen's native chat template format ([#2020](https://github.com/badlogic/pi-mono/issues/2020))
- Fixed Bedrock unsigned thinking replay to handle edge cases with empty or malformed thinking blocks ([#2063](https://github.com/badlogic/pi-mono/issues/2063))
- Fixed xhigh reasoning effort detection for Claude Opus 4.6 to match by model ID instead of requiring explicit capability flag ([#2040](https://github.com/badlogic/pi-mono/issues/2040))
- Handle `finish_reason: "end"` from Ollama/LM Studio by mapping it to `"stop"` instead of throwing ([#2142](https://github.com/badlogic/pi-mono/issues/2142))

## [0.58.0] - 2026-03-14

### Added

- Added `GOOGLE_CLOUD_API_KEY` environment variable support for the `google-vertex` provider as an alternative to Application Default Credentials ([#1976](https://github.com/badlogic/pi-mono/pull/1976) by [@gordonhwc](https://github.com/gordonhwc))

### Changed

- Raised Claude Opus 4.6, Sonnet 4.6, and related Bedrock model context windows from 200K to 1M tokens ([#2135](https://github.com/badlogic/pi-mono/pull/2135) by [@mitsuhiko](https://github.com/mitsuhiko))

### Fixed

- Fixed GitHub Copilot device-code login polling to respect OAuth slow-down intervals, wait before the first token poll, and include a clearer clock-drift hint in WSL/VM environments when repeated slow-downs lead to timeout.
- Fixed usage statistics not being captured for OpenAI-compatible providers that return usage in `choice.usage` instead of the standard `chunk.usage` (e.g., Moonshot/Kimi) ([#2017](https://github.com/badlogic/pi-mono/issues/2017))
- Fixed tool result images not being sent in `function_call_output` items for OpenAI Responses API providers, causing image data to be silently dropped in tool results ([#2104](https://github.com/badlogic/pi-mono/issues/2104))
- Fixed assistant content being sent as structured content blocks instead of plain strings in the `openai-completions` provider, causing errors with some OpenAI-compatible backends ([#2008](https://github.com/badlogic/pi-mono/pull/2008) by [@geraldoaax](https://github.com/geraldoaax))
- Fixed error details in OpenAI Responses `response.failed` handler to include status code, error code, and message instead of a generic failure ([#1956](https://github.com/badlogic/pi-mono/pull/1956) by [@drewburr](https://github.com/drewburr))

## [0.57.1] - 2026-03-07

### Fixed

- Fixed context overflow detection to recognize z.ai `model_context_window_exceeded` errors surfaced through OpenAI-compatible stop reason handling ([#1937](https://github.com/badlogic/pi-mono/issues/1937))

## [0.57.0] - 2026-03-07

### Added

- Added per-request payload inspection and replacement hook support via `beforeProviderRequest`, allowing callers to inspect or replace provider payloads before sending.

## [0.56.3] - 2026-03-06

### Added

- Added `claude-sonnet-4-6` model for the `google-antigravity` provider ([#1859](https://github.com/badlogic/pi-mono/issues/1859)).
- Bumped default Antigravity User-Agent version to `1.18.4` ([#1859](https://github.com/badlogic/pi-mono/issues/1859)).

### Fixed

- Fixed Antigravity Claude thinking beta header detection to use provider and model capability instead of `-thinking` suffix, so models like `claude-sonnet-4-6` receive the header correctly ([#1859](https://github.com/badlogic/pi-mono/issues/1859)).
- Fixed OpenAI Responses reasoning replay regression that dropped reasoning blocks on follow-up turns ([#1878](https://github.com/badlogic/pi-mono/issues/1878))

## [0.56.2] - 2026-03-05

### Added

- Added `gpt-5.4` model support for `openai`, `openai-codex`, `azure-openai-responses`, and `opencode` providers, with GPT-5.4 treated as xhigh-capable and capped to a 272000 context window in built-in metadata.
- Added `gpt-5.3-codex` fallback model availability for `github-copilot` until upstream model catalogs include it ([#1853](https://github.com/badlogic/pi-mono/issues/1853)).

### Fixed

- Preserved OpenAI Responses assistant `phase` metadata (`commentary`, `final_answer`) across turns by encoding `id` and `phase` in `textSignature` for session persistence and replay, with backward compatibility for legacy plain signatures ([#1819](https://github.com/badlogic/pi-mono/issues/1819)).
- Fixed OpenAI Responses replay to omit empty thinking blocks, avoiding invalid no-op reasoning items in follow-up turns.
- Switched the Mistral provider from the OpenAI-compatible completions path to Mistral's native SDK and conversations API, preserving native thinking blocks and Mistral-specific message semantics across turns ([#1716](https://github.com/badlogic/pi-mono/issues/1716)).
- Fixed Antigravity endpoint fallback: 403/404 responses now cascade to the next endpoint instead of throwing immediately, added `autopush-cloudcode-pa.sandbox` endpoint to the fallback list, and removed extra fingerprint headers (`X-Goog-Api-Client`, `Client-Metadata`) from Antigravity requests ([#1830](https://github.com/badlogic/pi-mono/issues/1830)).
- Fixed `@mariozechner/pi-ai/oauth` package exports to point directly at built `dist` files, avoiding broken TypeScript resolution through unpublished wrapper targets ([#1856](https://github.com/badlogic/pi-mono/issues/1856)).
- Fixed Gemini 3 unsigned tool call replay: use `skip_thought_signature_validator` sentinel instead of converting function calls to text, preserving structured tool call context across multi-turn conversations ([#1829](https://github.com/badlogic/pi-mono/issues/1829)).

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

### Breaking Changes

- Moved Node OAuth runtime exports off the top-level package entry. Import OAuth login/refresh functions from `@mariozechner/pi-ai/oauth` instead of `@mariozechner/pi-ai` ([#1814](https://github.com/badlogic/pi-mono/issues/1814))

### Added

- Added `gemini-3.1-flash-lite-preview` fallback model entry for the `google` provider so it remains selectable until upstream model catalogs include it ([#1785](https://github.com/badlogic/pi-mono/issues/1785), thanks [@n-WN](https://github.com/n-WN)).
- Added OpenCode Go provider support with `opencode-go` model catalog entries and `OPENCODE_API_KEY` environment variable support ([#1757](https://github.com/badlogic/pi-mono/issues/1757)).

### Changed

- Updated Antigravity Gemini 3.1 model metadata and request headers to match current upstream behavior.

### Fixed

- Fixed Gemini 3.1 thinking-level detection in `google` and `google-vertex` providers so `gemini-3.1-*` models use Gemini 3 level-based thinking config instead of budget fallback ([#1785](https://github.com/badlogic/pi-mono/issues/1785), thanks [@n-WN](https://github.com/n-WN)).
- Fixed browser bundling failures by lazy-loading the Bedrock provider and removing Node-only side effects from the default browser import graph ([#1814](https://github.com/badlogic/pi-mono/issues/1814)).
- Fixed `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` failures by replacing `Function`-based dynamic imports with module dynamic imports in browser-safe provider loading paths ([#1814](https://github.com/badlogic/pi-mono/issues/1814)).
- Fixed Bedrock region resolution for `AWS_PROFILE` by honoring `region` from the selected profile when present ([#1800](https://github.com/badlogic/pi-mono/issues/1800)).
- Fixed Groq Qwen3 reasoning effort mapping by translating unsupported effort values to provider-supported values ([#1745](https://github.com/badlogic/pi-mono/issues/1745)).

## [0.55.4] - 2026-03-02

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

### Fixed

- Restored built-in OAuth providers when unregistering dynamically registered provider IDs and added `resetOAuthProviders()` for registry reset flows.
- Fixed Z.ai thinking control using wrong parameter name (`thinking` instead of `enable_thinking`), causing thinking to always be enabled and wasting tokens/latency ([#1674](https://github.com/badlogic/pi-mono/pull/1674) by [@okuyam2y](https://github.com/okuyam2y))
- Fixed `redacted_thinking` blocks being silently dropped during Anthropic streaming. They are now captured as `ThinkingContent` with `redacted: true`, passed back to the API in multi-turn conversations, and handled in cross-model message transformation ([#1665](https://github.com/badlogic/pi-mono/pull/1665) by [@tctev](https://github.com/tctev))
- Fixed `interleaved-thinking-2025-05-14` beta header being sent for adaptive thinking models (Opus 4.6, Sonnet 4.6) where the header is deprecated or redundant ([#1665](https://github.com/badlogic/pi-mono/pull/1665) by [@tctev](https://github.com/tctev))
- Fixed temperature being sent alongside extended thinking, which is incompatible with both adaptive and budget-based thinking modes ([#1665](https://github.com/badlogic/pi-mono/pull/1665) by [@tctev](https://github.com/tctev))
- Fixed `(external, cli)` user-agent flag causing 401 errors on Anthropic setup-token endpoint ([#1677](https://github.com/badlogic/pi-mono/pull/1677) by [@LazerLance777](https://github.com/LazerLance777))
- Fixed crash when OpenAI-compatible provider returns a chunk with no `choices` array by adding optional chaining ([#1671](https://github.com/badlogic/pi-mono/issues/1671))

## [0.55.1] - 2026-02-26

### Added

- Added `gemini-3.1-pro-preview` model support to the `google-gemini-cli` provider ([#1599](https://github.com/badlogic/pi-mono/pull/1599) by [@audichuang](https://github.com/audichuang))

### Fixed

- Fixed adaptive thinking for Claude Sonnet 4.6 in Anthropic and Bedrock providers, and clamped unsupported `xhigh` effort values to supported levels ([#1548](https://github.com/badlogic/pi-mono/pull/1548) by [@tctev](https://github.com/tctev))
- Fixed Vertex ADC credential detection race by avoiding caching a false negative during async import initialization ([#1550](https://github.com/badlogic/pi-mono/pull/1550) by [@jeremiahgaylord-web](https://github.com/jeremiahgaylord-web))

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

### Added

- Added Anthropic `claude-sonnet-4-6` fallback model entry to generated model definitions.

## [0.52.12] - 2026-02-13

### Added

- Added `transport` to `StreamOptions` with values `"sse"`, `"websocket"`, and `"auto"` (currently supported by `openai-codex-responses`).
- Added WebSocket transport support for OpenAI Codex Responses (`openai-codex-responses`).

### Changed

- OpenAI Codex Responses now defaults to SSE transport unless `transport` is explicitly set.
- OpenAI Codex Responses WebSocket connections are cached per `sessionId` and expire after 5 minutes of inactivity.

## [0.52.11] - 2026-02-13

### Added

- Added MiniMax M2.5 model entries for `minimax`, `minimax-cn`, `openrouter`, and `vercel-ai-gateway` providers, plus `minimax-m2.5-free` for `opencode`.

## [0.52.10] - 2026-02-12

### Added

- Added optional `metadata` field to `StreamOptions` for passing provider-specific metadata (e.g. Anthropic `user_id` for abuse tracking/rate limiting) ([#1384](https://github.com/badlogic/pi-mono/pull/1384) by [@7Sageer](https://github.com/7Sageer))
- Added `gpt-5.3-codex-spark` model definition for OpenAI and OpenAI Codex providers (128k context, text-only, research preview). Not yet functional, may become available in the next few hours or days.

### Changed

- Routed GitHub Copilot Claude 4.x models through Anthropic Messages API, centralized Copilot dynamic header handling, and added Copilot Claude Anthropic stream coverage ([#1353](https://github.com/badlogic/pi-mono/pull/1353) by [@NateSmyth](https://github.com/NateSmyth))

### Fixed

- Fixed OpenAI completions and responses streams to tolerate malformed trailing tool-call JSON without failing parsing ([#1424](https://github.com/badlogic/pi-mono/issues/1424))

## [0.52.9] - 2026-02-08

### Changed

- Updated the Antigravity system instruction to a more compact version for Google Gemini CLI compatibility

### Fixed

- Use `parametersJsonSchema` for Google provider tool declarations to support full JSON Schema (anyOf, oneOf, const, etc.) ([#1398](https://github.com/badlogic/pi-mono/issues/1398) by [@jarib](https://github.com/jarib))
- Reverted incorrect Antigravity model change: `claude-opus-4-6-thinking` back to `claude-opus-4-5-thinking` (model doesn't exist on Antigravity endpoint)
- Corrected opencode context windows for Claude Sonnet 4 and 4.5 ([#1383](https://github.com/badlogic/pi-mono/issues/1383))

## [0.52.8] - 2026-02-07

### Added

- Added OpenRouter `auto` model alias for automatic model routing ([#1361](https://github.com/badlogic/pi-mono/pull/1361) by [@yogasanas](https://github.com/yogasanas))

### Changed

- Replaced Claude Opus 4.5 with Opus 4.6 in model definitions ([#1345](https://github.com/badlogic/pi-mono/pull/1345) by [@calvin-hpnet](https://github.com/calvin-hpnet))

## [0.52.7] - 2026-02-06

### Added

- Added `AWS_BEDROCK_SKIP_AUTH` and `AWS_BEDROCK_FORCE_HTTP1` environment variables for connecting to unauthenticated Bedrock proxies ([#1320](https://github.com/badlogic/pi-mono/pull/1320) by [@virtuald](https://github.com/virtuald))

### Fixed

- Set OpenAI Responses API requests to `store: false` by default to avoid server-side history logging ([#1308](https://github.com/badlogic/pi-mono/issues/1308))
- Re-exported TypeBox `Type`, `Static`, and `TSchema` from `@mariozechner/pi-ai` to match documentation and avoid duplicate TypeBox type identity issues in pnpm setups ([#1338](https://github.com/badlogic/pi-mono/issues/1338))
- Fixed Bedrock adaptive thinking handling for Claude Opus 4.6 with interleaved thinking beta responses ([#1323](https://github.com/badlogic/pi-mono/pull/1323) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Fixed `AWS_BEDROCK_SKIP_AUTH` environment detection to avoid `process` access in non-Node.js environments

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

### Fixed

- Fixed `supportsXhigh()` to treat Anthropic Messages Opus 4.6 models as xhigh-capable so `streamSimple` can map `xhigh` to adaptive effort `max`

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

### Fixed

- Fixed Bedrock Opus 4.6 model IDs (removed `:0` suffix) and cache pricing for `us.*` and `eu.*` variants
- Added missing `eu.anthropic.claude-opus-4-6-v1` inference profile to model catalog
- Fixed Claude Opus 4.6 context window metadata to 200000 for Anthropic and OpenCode providers

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

### Added

- Added adaptive thinking support for Claude Opus 4.6 with effort levels (`low`, `medium`, `high`, `max`)
- Added `effort` option to `AnthropicOptions` for controlling adaptive thinking depth
- `thinkingEnabled` now automatically uses adaptive thinking for Opus 4.6+ models and budget-based thinking for older models
- `streamSimple`/`completeSimple` automatically map `ThinkingLevel` to effort levels for Opus 4.6

### Changed

- Updated `@anthropic-ai/sdk` to 0.73.0
- Updated `@aws-sdk/client-bedrock-runtime` to 3.983.0
- Updated `@google/genai` to 1.40.0
- Removed `fast-xml-parser` override (no longer needed)

## [0.52.0] - 2026-02-05

### Added

- Added Claude Opus 4.6 model to the generated model catalog
- Added GPT-5.3 Codex model to the generated model catalog (OpenAI Codex provider only)

## [0.51.6] - 2026-02-04

### Fixed

- Fixed OpenAI Codex Responses provider to respect configured baseUrl ([#1244](https://github.com/badlogic/pi-mono/issues/1244))

## [0.51.5] - 2026-02-04

### Changed

- Changed Bedrock model generation to drop legacy workarounds now handled upstream ([#1239](https://github.com/badlogic/pi-mono/pull/1239) by [@unexge](https://github.com/unexge))

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

### Fixed

- Fixed xhigh thinking level support check to accept gpt-5.2 model IDs ([#1209](https://github.com/badlogic/pi-mono/issues/1209))

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

### Fixed

- Fixed `cache_control` not being applied to string-format user messages in Anthropic provider

## [0.51.0] - 2026-02-01

### Fixed

- Fixed `cacheRetention` option not being passed through in `buildBaseOptions` ([#1154](https://github.com/badlogic/pi-mono/issues/1154))
- Fixed OAuth login/refresh not using HTTP proxy settings (`HTTP_PROXY`, `HTTPS_PROXY` env vars) ([#1132](https://github.com/badlogic/pi-mono/issues/1132))
- Fixed OpenAI-compatible completions to omit unsupported `strict` tool fields for providers that reject them ([#1172](https://github.com/badlogic/pi-mono/issues/1172))

## [0.50.9] - 2026-02-01

### Added

- Added `PI_AI_ANTIGRAVITY_VERSION` environment variable to override the Antigravity User-Agent version when Google updates their version requirements ([#1129](https://github.com/badlogic/pi-mono/issues/1129))
- Added `cacheRetention` stream option with provider-specific mappings for prompt cache controls, defaulting to short retention ([#1134](https://github.com/badlogic/pi-mono/issues/1134))

## [0.50.8] - 2026-02-01

### Added

- Added `maxRetryDelayMs` option to `StreamOptions` to cap server-requested retry delays. When a provider (e.g., Google Gemini CLI) requests a delay longer than this value, the request fails immediately with an informative error instead of waiting silently. Default: 60000ms (60 seconds). Set to 0 to disable the cap. ([#1123](https://github.com/badlogic/pi-mono/issues/1123))
- Added Qwen thinking format support for OpenAI-compatible completions via `enable_thinking`. ([#940](https://github.com/badlogic/pi-mono/pull/940) by [@4h9fbZ](https://github.com/4h9fbZ))

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.4] - 2026-01-30

### Added

- Added Vercel AI Gateway routing support via `vercelGatewayRouting` option in model config ([#1051](https://github.com/badlogic/pi-mono/pull/1051) by [@ben-vargas](https://github.com/ben-vargas))

### Fixed

- Updated Antigravity User-Agent from 1.11.5 to 1.15.8 to fix rejected requests ([#1079](https://github.com/badlogic/pi-mono/issues/1079))
- Fixed tool call argument defaults for Anthropic and Google history conversion when providers omit inputs ([#1065](https://github.com/badlogic/pi-mono/issues/1065))

## [0.50.3] - 2026-01-29

### Added

- Added Kimi For Coding provider support (Moonshot AI's Anthropic-compatible coding API)

## [0.50.2] - 2026-01-29

### Added

- Added Hugging Face provider support via OpenAI-compatible Inference Router ([#994](https://github.com/badlogic/pi-mono/issues/994))
- Added `PI_CACHE_RETENTION` environment variable to control cache TTL for Anthropic (5m vs 1h) and OpenAI (in-memory vs 24h). Set to `long` for extended retention. Only applies to direct API calls (api.anthropic.com, api.openai.com). ([#967](https://github.com/badlogic/pi-mono/issues/967))

### Fixed

- Fixed OpenAI completions `toolChoice` handling to correctly set `type: "function"` wrapper ([#998](https://github.com/badlogic/pi-mono/pull/998) by [@williamtwomey](https://github.com/williamtwomey))
- Fixed cross-provider handoff failing when switching from OpenAI Responses API providers (github-copilot, openai-codex) to other providers due to pipe-separated tool call IDs not being normalized, and trailing underscores in truncated IDs being rejected by OpenAI Codex ([#1022](https://github.com/badlogic/pi-mono/issues/1022))
- Fixed 429 rate limit errors incorrectly triggering auto-compaction instead of retry with backoff ([#1038](https://github.com/badlogic/pi-mono/issues/1038))
- Fixed Anthropic provider to handle `sensitive` stop_reason returned by API ([#978](https://github.com/badlogic/pi-mono/issues/978))
- Fixed DeepSeek API compatibility by detecting `deepseek.com` URLs and disabling unsupported `developer` role ([#1048](https://github.com/badlogic/pi-mono/issues/1048))
- Fixed Anthropic provider to preserve input token counts when proxies omit them in `message_delta` events ([#1045](https://github.com/badlogic/pi-mono/issues/1045))

## [0.50.1] - 2026-01-26

### Fixed

- Fixed OpenCode Zen model generation to exclude deprecated models ([#970](https://github.com/badlogic/pi-mono/pull/970) by [@DanielTatarkin](https://github.com/DanielTatarkin))

## [0.50.0] - 2026-01-26

### Added

- Added OpenRouter provider routing support for custom models via `openRouterRouting` compat field ([#859](https://github.com/badlogic/pi-mono/pull/859) by [@v01dpr1mr0s3](https://github.com/v01dpr1mr0s3))
- Added `azure-openai-responses` provider support for Azure OpenAI Responses API. ([#890](https://github.com/badlogic/pi-mono/pull/890) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Added HTTP proxy environment variable support for API requests ([#942](https://github.com/badlogic/pi-mono/pull/942) by [@haoqixu](https://github.com/haoqixu))
- Added `createAssistantMessageEventStream()` factory function for use in extensions.
- Added `resetApiProviders()` to clear and re-register built-in API providers.

### Changed

- Refactored API streaming dispatch to use an API registry with provider-owned `streamSimple` mapping.
- Moved environment API key resolution to `env-api-keys.ts` and re-exported it from the package entrypoint.
- Azure OpenAI Responses provider now uses base URL configuration with deployment-aware model mapping and no longer includes service tier handling.

### Fixed

- Fixed Bun runtime detection for dynamic imports in browser-compatible modules (stream.ts, openai-codex-responses.ts, openai-codex.ts) ([#922](https://github.com/badlogic/pi-mono/pull/922) by [@dannote](https://github.com/dannote))
- Fixed streaming functions to use `model.api` instead of hardcoded API types
- Fixed Google providers to default tool call arguments to an empty object when omitted
- Fixed OpenAI Responses streaming to handle `arguments.done` events on OpenAI-compatible endpoints ([#917](https://github.com/badlogic/pi-mono/pull/917) by [@williballenthin](https://github.com/williballenthin))
- Fixed OpenAI Codex Responses tool strictness handling after the shared responses refactor
- Fixed Azure OpenAI Responses streaming to guard deltas before content parts and correct metadata and handoff gating
- Fixed OpenAI completions tool-result image batching after consecutive tool results ([#902](https://github.com/badlogic/pi-mono/pull/902) by [@terrorobe](https://github.com/terrorobe))

## [0.49.3] - 2026-01-22

### Added

- Added `headers` option to `StreamOptions` for custom HTTP headers in API requests. Supported by all providers except Amazon Bedrock (which uses AWS SDK auth). Headers are merged with provider defaults and `model.headers`, with `options.headers` taking precedence.
- Added `originator` option to `loginOpenAICodex()` for custom OAuth client identification
- Browser compatibility for pi-ai: replaced top-level Node.js imports with dynamic imports for browser environments ([#873](https://github.com/badlogic/pi-mono/issues/873))

### Fixed

- Fixed OpenAI Responses API 400 error "function_call without required reasoning item" when switching between models (same provider, different model). The fix omits the `id` field for function_calls from different models to avoid triggering OpenAI's reasoning/function_call pairing validation ([#886](https://github.com/badlogic/pi-mono/issues/886))

## [0.49.2] - 2026-01-19

### Added

- Added AWS credential detection for ECS/Kubernetes environments: `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE` ([#848](https://github.com/badlogic/pi-mono/issues/848))

### Fixed

- Fixed OpenAI Responses 400 error "reasoning without following item" by skipping errored/aborted assistant messages entirely in transform-messages.ts ([#838](https://github.com/badlogic/pi-mono/pull/838))

### Removed

- Removed `strictResponsesPairing` compat option (no longer needed after the transform-messages fix)

## [0.49.1] - 2026-01-18

### Added

- Added `OpenAIResponsesCompat` interface with `strictResponsesPairing` option for Azure OpenAI Responses API, which requires strict reasoning/message pairing in history replay ([#768](https://github.com/badlogic/pi-mono/pull/768) by [@prateekmedia](https://github.com/prateekmedia))

### Changed

- Split `OpenAICompat` into `OpenAICompletionsCompat` and `OpenAIResponsesCompat` for type-safe API-specific compat settings

### Fixed

- Fixed tool call ID normalization for cross-provider handoffs (e.g., Codex to Antigravity Claude) ([#821](https://github.com/badlogic/pi-mono/issues/821))

## [0.49.0] - 2026-01-17

### Changed

- OpenAI Codex responses now use the context system prompt directly in the instructions field.

### Fixed

- Fixed orphaned tool results after errored assistant messages causing Codex API errors. When an assistant message has `stopReason: "error"`, its tool calls are now excluded from pending tool tracking, preventing synthetic tool results from being generated for calls that will be dropped by provider-specific converters. ([#812](https://github.com/badlogic/pi-mono/issues/812))
- Fixed Bedrock Claude max_tokens handling to always exceed thinking budget tokens, preventing compaction failures. ([#797](https://github.com/badlogic/pi-mono/pull/797) by [@pjtf93](https://github.com/pjtf93))
- Fixed Claude Code tool name normalization to match the Claude Code tool list case-insensitively and remove invalid mappings.

## [0.48.0] - 2026-01-16

### Fixed

- Fixed OpenAI-compatible provider feature detection to use `model.provider` in addition to URL, allowing custom base URLs (e.g., proxies) to work correctly with provider-specific settings ([#774](https://github.com/badlogic/pi-mono/issues/774))
- Fixed Gemini 3 context loss when switching from providers without thought signatures: unsigned tool calls are now converted to text with anti-mimicry notes instead of being skipped
- Fixed string numbers in tool arguments not being coerced to numbers during validation ([#786](https://github.com/badlogic/pi-mono/pull/786) by [@dannote](https://github.com/dannote))
- Fixed Bedrock tool call IDs to use only alphanumeric characters, avoiding API errors from invalid characters ([#781](https://github.com/badlogic/pi-mono/pull/781) by [@pjtf93](https://github.com/pjtf93))
- Fixed empty error assistant messages (from 429/500 errors) breaking the tool_use to tool_result chain by filtering them in `transformMessages`

## [0.47.0] - 2026-01-16

### Fixed

- Fixed OpenCode provider's `/v1` endpoint to use `system` role instead of `developer` role, fixing `400 Incorrect role information` error for models using `openai-completions` API ([#755](https://github.com/badlogic/pi-mono/pull/755) by [@melihmucuk](https://github.com/melihmucuk))
- Added retry logic to OpenAI Codex provider for transient errors (429, 5xx, connection failures). Uses exponential backoff with up to 3 retries. ([#733](https://github.com/badlogic/pi-mono/issues/733))

## [0.46.0] - 2026-01-15

### Added

- Added MiniMax China (`minimax-cn`) provider support ([#725](https://github.com/badlogic/pi-mono/pull/725) by [@tallshort](https://github.com/tallshort))
- Added `gpt-5.2-codex` models for GitHub Copilot and OpenCode Zen providers ([#734](https://github.com/badlogic/pi-mono/pull/734) by [@aadishv](https://github.com/aadishv))

### Fixed

- Avoid unsigned Gemini 3 tool calls ([#741](https://github.com/badlogic/pi-mono/pull/741) by [@roshanasingh4](https://github.com/roshanasingh4))
- Fixed signature support for non-Anthropic models in Amazon Bedrock provider ([#727](https://github.com/badlogic/pi-mono/pull/727) by [@unexge](https://github.com/unexge))

## [0.45.7] - 2026-01-13

### Fixed

- Fixed OpenAI Responses timeout option handling ([#706](https://github.com/badlogic/pi-mono/pull/706) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Fixed Bedrock tool call conversion to apply message transforms ([#707](https://github.com/badlogic/pi-mono/pull/707) by [@pjtf93](https://github.com/pjtf93))

## [0.45.6] - 2026-01-13

### Fixed

- Export `parseStreamingJson` from main package for tsx dev mode compatibility

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

### Added

- Added Vercel AI Gateway provider with model discovery and `AI_GATEWAY_API_KEY` env support ([#689](https://github.com/badlogic/pi-mono/pull/689) by [@timolins](https://github.com/timolins))

### Fixed

- Fixed z.ai thinking/reasoning: z.ai uses `thinking: { type: "enabled" }` instead of OpenAI's `reasoning_effort`. Added `thinkingFormat` compat flag to handle this. ([#688](https://github.com/badlogic/pi-mono/issues/688))

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

### Added

- MiniMax provider support with M2 and M2.1 models via Anthropic-compatible API ([#656](https://github.com/badlogic/pi-mono/pull/656) by [@dannote](https://github.com/dannote))
- Add Amazon Bedrock provider with prompt caching for Claude models (experimental, tested with Anthropic Claude models only) ([#494](https://github.com/badlogic/pi-mono/pull/494) by [@unexge](https://github.com/unexge))
- Added `serviceTier` option for OpenAI Responses requests ([#672](https://github.com/badlogic/pi-mono/pull/672) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Anthropic caching on OpenRouter**: Interactions with Anthropic models via OpenRouter now set a 5-minute cache point using Anthropic-style `cache_control` breakpoints on the last assistant or user message. ([#584](https://github.com/badlogic/pi-mono/pull/584) by [@nathyong](https://github.com/nathyong))
- **Google Gemini CLI provider improvements**: Added Antigravity endpoint fallback (tries daily sandbox then prod when `baseUrl` is unset), header-based retry delay parsing (`Retry-After`, `x-ratelimit-reset`, `x-ratelimit-reset-after`), stable `sessionId` derivation from first user message for cache affinity, empty SSE stream retry with backoff, and `anthropic-beta` header for Claude thinking models ([#670](https://github.com/badlogic/pi-mono/pull/670) by [@kim0](https://github.com/kim0))

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

### Fixed

- Fixed Google provider thinking detection: `isThinkingPart()` now only checks `thought === true`, not `thoughtSignature`. Per Google docs, `thoughtSignature` is for context replay and can appear on any part type. Also removed `id` field from `functionCall`/`functionResponse` (rejected by Vertex AI and Cloud Code Assist), and added `textSignature` round-trip for multi-turn reasoning context. ([#631](https://github.com/badlogic/pi-mono/pull/631) by [@theBucky](https://github.com/theBucky))

## [0.42.5] - 2026-01-11

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

### Changed

- OpenAI Codex: switched to bundled system prompt matching opencode, changed originator to "pi", simplified prompt handling

## [0.42.2] - 2026-01-10

### Added

- Added `GOOGLE_APPLICATION_CREDENTIALS` env var support for Vertex AI credential detection (standard for CI/production).
- Added `supportsUsageInStreaming` compatibility flag for OpenAI-compatible providers that reject `stream_options: { include_usage: true }`. Defaults to `true`. Set to `false` in model config for providers like gatewayz.ai. ([#596](https://github.com/badlogic/pi-mono/pull/596) by [@XesGaDeus](https://github.com/XesGaDeus))
- Improved Google model pricing info ([#588](https://github.com/badlogic/pi-mono/pull/588) by [@aadishv](https://github.com/aadishv))

### Fixed

- Fixed `os.homedir()` calls at module load time; now resolved lazily when needed.
- Fixed OpenAI Responses tool strict flag to use a boolean for LM Studio compatibility ([#598](https://github.com/badlogic/pi-mono/pull/598) by [@gnattu](https://github.com/gnattu))
- Fixed Google Cloud Code Assist OAuth for paid subscriptions: properly handles long-running operations for project provisioning, supports `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env vars for paid tiers, and handles VPC-SC affected users ([#582](https://github.com/badlogic/pi-mono/pull/582) by [@cmf](https://github.com/cmf))

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

### Added

- Added OpenCode Zen provider support with 26 models (Claude, GPT, Gemini, Grok, Kimi, GLM, Qwen, etc.). Set `OPENCODE_API_KEY` env var to use.

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

### Fixed

- Fixed Gemini CLI abort handling: detect native `AbortError` in retry catch block, cancel SSE reader when abort signal fires ([#568](https://github.com/badlogic/pi-mono/pull/568) by [@tmustier](https://github.com/tmustier))
- Fixed Antigravity provider 429 errors by aligning request payload with CLIProxyAPI v6.6.89: inject Antigravity system instruction with `role: "user"`, set `requestType: "agent"`, and use `antigravity` userAgent. Added bridge prompt to override Antigravity behavior (identity, paths, web dev guidelines) with Pi defaults. ([#571](https://github.com/badlogic/pi-mono/pull/571) by [@ben-vargas](https://github.com/ben-vargas))
- Fixed thinking block handling for cross-model conversations: thinking blocks are now converted to plain text (no `<thinking>` tags) when switching models. Previously, `<thinking>` tags caused models to mimic the pattern and output literal tags. Also fixed empty thinking blocks causing API errors. ([#561](https://github.com/badlogic/pi-mono/issues/561))

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option in `SimpleStreamOptions` for customizing token budgets per thinking level on token-based providers ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

### Breaking Changes

- Removed OpenAI Codex model aliases (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `codex-mini-latest`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-chat-latest`). Use canonical model IDs: `gpt-5.1`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))

### Fixed

- Fixed OpenAI Codex context window from 400,000 to 272,000 tokens to match Codex CLI defaults and prevent 400 errors. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))
- Fixed Codex SSE error events to surface message, code, and status. ([#551](https://github.com/badlogic/pi-mono/pull/551) by [@tmustier](https://github.com/tmustier))
- Fixed context overflow detection for `context_length_exceeded` error codes.

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

### Added

- Exported OpenAI Codex utilities: `CacheMetadata`, `getCodexInstructions`, `getModelFamily`, `ModelFamily`, `buildCodexPiBridge`, `buildCodexSystemPrompt`, `CodexSystemPrompt` ([#510](https://github.com/badlogic/pi-mono/pull/510) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option in `StreamOptions` for providers that support session-based caching. OpenAI Codex provider uses this to set `prompt_cache_key` and routing headers.

## [0.37.2] - 2026-01-05

### Fixed

- Codex provider now always includes `reasoning.encrypted_content` even when custom `include` options are passed ([#484](https://github.com/badlogic/pi-mono/pull/484) by [@kim0](https://github.com/kim0))

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

### Breaking Changes

- OpenAI Codex models no longer have per-thinking-level variants (e.g., `gpt-5.2-codex-high`). Use the base model ID and set thinking level separately. The Codex provider clamps reasoning effort to what each model supports internally. (initial implementation by [@ben-vargas](https://github.com/ben-vargas) in [#472](https://github.com/badlogic/pi-mono/pull/472))

### Added

- Headless OAuth support for all callback-server providers (Google Gemini CLI, Antigravity, OpenAI Codex): paste redirect URL when browser callback is unreachable ([#428](https://github.com/badlogic/pi-mono/pull/428) by [@ben-vargas](https://github.com/ben-vargas), [#468](https://github.com/badlogic/pi-mono/pull/468) by [@crcatala](https://github.com/crcatala))
- Cancellable GitHub Copilot device code polling via AbortSignal

### Fixed

- Codex requests now omit the `reasoning` field entirely when thinking is off, letting the backend use its default instead of forcing a value. ([#472](https://github.com/badlogic/pi-mono/pull/472))

## [0.36.0] - 2026-01-05

### Added

- OpenAI Codex OAuth provider with Responses API streaming support: `openai-codex-responses` streaming provider with SSE parsing, tool-call handling, usage/cost tracking, and PKCE OAuth flow ([#451](https://github.com/badlogic/pi-mono/pull/451) by [@kim0](https://github.com/kim0))

### Fixed

- Vertex AI dummy value for `getEnvApiKey()`: Returns `"<authenticated>"` when Application Default Credentials are configured (`~/.config/gcloud/application_default_credentials.json` exists) and both `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION` are set. This allows `streamSimple()` to work with Vertex AI without explicit `apiKey` option. The ADC credentials file existence check is cached per-process to avoid repeated filesystem access.

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

### Fixed

- Google Vertex AI models no longer appear in available models list without explicit authentication. Previously, `getEnvApiKey()` returned a dummy value for `google-vertex`, causing models to show up even when Google Cloud ADC was not configured.

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

### Added

- Vertex AI provider with ADC (Application Default Credentials) support. Authenticate with `gcloud auth application-default login`, set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and access Gemini models via Vertex AI. ([#300](https://github.com/badlogic/pi-mono/pull/300) by [@default-anton](https://github.com/default-anton))

### Fixed

- **Gemini CLI rate limit handling**: Added automatic retry with server-provided delay for 429 errors. Parses delay from error messages like "Your quota will reset after 39s" and waits accordingly. Falls back to exponential backoff for other transient errors. ([#370](https://github.com/badlogic/pi-mono/issues/370))

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent API moved**: All agent functionality (`agentLoop`, `agentLoopContinue`, `AgentContext`, `AgentEvent`, `AgentTool`, `AgentToolResult`, etc.) has moved to `@mariozechner/pi-agent-core`. Import from that package instead of `@mariozechner/pi-ai`.

### Added

- **`GoogleThinkingLevel` type**: Exported type that mirrors Google's `ThinkingLevel` enum values (`"THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`). Allows configuring Gemini thinking levels without importing from `@google/genai`.
- **`ANTHROPIC_OAUTH_TOKEN` env var**: Now checked before `ANTHROPIC_API_KEY` in `getEnvApiKey()`, allowing OAuth tokens to take precedence.
- **`event-stream.js` export**: `AssistantMessageEventStream` utility now exported from package index.

### Changed

- **OAuth uses Web Crypto API**: PKCE generation and OAuth flows now use Web Crypto API (`crypto.subtle`) instead of Node.js `crypto` module. This improves browser compatibility while still working in Node.js 20+.
- **Deterministic model generation**: `generate-models.ts` now sorts providers and models alphabetically for consistent output across runs. ([#332](https://github.com/badlogic/pi-mono/pull/332) by [@mrexodia](https://github.com/mrexodia))

### Fixed

- **OpenAI completions empty content blocks**: Empty text or thinking blocks in assistant messages are now filtered out before sending to the OpenAI completions API, preventing validation errors. ([#344](https://github.com/badlogic/pi-mono/pull/344) by [@default-anton](https://github.com/default-anton))
- **Thinking token duplication**: Fixed thinking content duplication with chutes.ai provider. The provider was returning thinking content in both `reasoning_content` and `reasoning` fields, causing each chunk to be processed twice. Now only the first non-empty reasoning field is used.
- **zAi provider API mapping**: Fixed zAi models to use `openai-completions` API with correct base URL (`https://api.z.ai/api/coding/paas/v4`) instead of incorrect Anthropic API mapping. ([#344](https://github.com/badlogic/pi-mono/pull/344), [#358](https://github.com/badlogic/pi-mono/pull/358) by [@default-anton](https://github.com/default-anton))

## [0.28.0] - 2025-12-25

### Breaking Changes

- **OAuth storage removed** ([#296](https://github.com/badlogic/pi-mono/issues/296)): All storage functions (`loadOAuthCredentials`, `saveOAuthCredentials`, `setOAuthStorage`, etc.) removed. Callers are responsible for storing credentials.
- **OAuth login functions**: `loginAnthropic`, `loginGitHubCopilot`, `loginGeminiCli`, `loginAntigravity` now return `OAuthCredentials` instead of saving to disk.
- **refreshOAuthToken**: Now takes `(provider, credentials)` and returns new `OAuthCredentials` instead of saving.
- **getOAuthApiKey**: Now takes `(provider, credentials)` and returns `{ newCredentials, apiKey }` or null.
- **OAuthCredentials type**: No longer includes `type: "oauth"` discriminator. Callers add discriminator when storing.
- **setApiKey, resolveApiKey**: Removed. Callers must manage their own API key storage/resolution.
- **getApiKey**: Renamed to `getEnvApiKey`. Only checks environment variables for known providers.

## [0.27.7] - 2025-12-24

### Fixed

- **Thinking tag leakage**: Fixed Claude mimicking literal `</thinking>` tags in responses. Unsigned thinking blocks (from aborted streams) are now converted to plain text without `<thinking>` tags. The TUI still displays them as thinking blocks. ([#302](https://github.com/badlogic/pi-mono/pull/302) by [@nicobailon](https://github.com/nicobailon))

## [0.25.1] - 2025-12-21

### Added

- **xhigh thinking level support**: Added `supportsXhigh()` function to check if a model supports xhigh reasoning level. Also clamps xhigh to high for OpenAI models that don't support it. ([#236](https://github.com/badlogic/pi-mono/pull/236) by [@theBucky](https://github.com/theBucky))

### Fixed

- **Gemini multimodal tool results**: Fixed images in tool results causing flaky/broken responses with Gemini models. For Gemini 3, images are now nested inside `functionResponse.parts` per the [docs](https://ai.google.dev/gemini-api/docs/function-calling#multimodal). For older models (which don't support multimodal function responses), images are sent in a separate user message.

- **Queued message steering**: When `getQueuedMessages` is provided, the agent loop now checks for queued user messages after each tool call and skips remaining tool calls in the current assistant message when a queued message arrives (emitting error tool results).

- **Double API version path in Google provider URL**: Fixed Gemini API calls returning 404 after baseUrl support was added. The SDK was appending its default apiVersion to baseUrl which already included the version path. ([#251](https://github.com/badlogic/pi-mono/pull/251) by [@shellfyred](https://github.com/shellfyred))

- **Anthropic SDK retries disabled**: Re-enabled SDK-level retries (default 2) for transient HTTP failures. ([#252](https://github.com/badlogic/pi-mono/issues/252))

## [0.23.5] - 2025-12-19

### Added

- **Gemini 3 Flash thinking support**: Extended thinking level support for Gemini 3 Flash models (MINIMAL, LOW, MEDIUM, HIGH) to match Pro models' capabilities. ([#212](https://github.com/badlogic/pi-mono/pull/212) by [@markusylisiurunen](https://github.com/markusylisiurunen))

- **GitHub Copilot thinking models**: Added thinking support for additional Copilot models (o3-mini, o1-mini, o1-preview). ([#234](https://github.com/badlogic/pi-mono/pull/234) by [@aadishv](https://github.com/aadishv))

### Fixed

- **Gemini tool result format**: Fixed tool result format for Gemini 3 Flash Preview which strictly requires `{ output: value }` for success and `{ error: value }` for errors. Previous format using `{ result, isError }` was rejected by newer Gemini models. Also improved type safety by removing `as any` casts. ([#213](https://github.com/badlogic/pi-mono/issues/213), [#220](https://github.com/badlogic/pi-mono/pull/220))

- **Google baseUrl configuration**: Google provider now respects `baseUrl` configuration for custom endpoints or API proxies. ([#216](https://github.com/badlogic/pi-mono/issues/216), [#221](https://github.com/badlogic/pi-mono/pull/221) by [@theBucky](https://github.com/theBucky))

- **GitHub Copilot vision requests**: Added `Copilot-Vision-Request` header when sending images to GitHub Copilot models. ([#222](https://github.com/badlogic/pi-mono/issues/222))

- **GitHub Copilot X-Initiator header**: Fixed X-Initiator logic to check last message role instead of any message in history. This ensures proper billing when users send follow-up messages. ([#209](https://github.com/badlogic/pi-mono/issues/209))

## [0.22.3] - 2025-12-16

### Added

- **Image limits test suite**: Added comprehensive tests for provider-specific image limitations (max images, max size, max dimensions). Discovered actual limits: Anthropic (100 images, 5MB, 8000px), OpenAI (500 images, ≥25MB), Gemini (~2500 images, ≥40MB), Mistral (8 images, ~15MB), OpenRouter (~40 images context-limited, ~15MB). ([#120](https://github.com/badlogic/pi-mono/pull/120))

- **Tool result streaming**: Added `tool_execution_update` event and optional `onUpdate` callback to `AgentTool.execute()` for streaming tool output during execution. Tools can now emit partial results (e.g., bash stdout) that are forwarded to subscribers. ([#44](https://github.com/badlogic/pi-mono/issues/44))

- **X-Initiator header for GitHub Copilot**: Added X-Initiator header handling for GitHub Copilot provider to ensure correct call accounting (agent calls are not deducted from quota). Sets initiator based on last message role. ([#200](https://github.com/badlogic/pi-mono/pull/200) by [@kim0](https://github.com/kim0))

### Changed

- **Normalized tool_execution_end result**: `tool_execution_end` event now always contains `AgentToolResult` (no longer `AgentToolResult | string`). Errors are wrapped in the standard result format.

### Fixed

- **Reasoning disabled by default**: When `reasoning` option is not specified, thinking is now explicitly disabled for all providers. Previously, some providers like Gemini with "dynamic thinking" would use their default (thinking ON), causing unexpected token usage. This was the original intended behavior. ([#180](https://github.com/badlogic/pi-mono/pull/180) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.22.2] - 2025-12-15

### Added

- **Interleaved thinking for Anthropic**: Added `interleavedThinking` option to `AnthropicOptions`. When enabled, Claude 4 models can think between tool calls and reason after receiving tool results. Enabled by default (no extra token cost, just unlocks the capability). Set `interleavedThinking: false` to disable.

## [0.22.1] - 2025-12-15

_Dedicated to Peter's shoulder ([@steipete](https://twitter.com/steipete))_

### Added

- **Interleaved thinking for Anthropic**: Enabled interleaved thinking in the Anthropic provider, allowing Claude models to output thinking blocks interspersed with text responses.

## [0.22.0] - 2025-12-15

### Added

- **GitHub Copilot provider**: Added `github-copilot` as a known provider with models sourced from models.dev. Includes Claude, GPT, Gemini, Grok, and other models available through GitHub Copilot. ([#191](https://github.com/badlogic/pi-mono/pull/191) by [@cau1k](https://github.com/cau1k))

### Fixed

- **GitHub Copilot gpt-5 models**: Fixed API selection for gpt-5 models to use `openai-responses` instead of `openai-completions` (gpt-5 models are not accessible via completions endpoint)

- **GitHub Copilot cross-model context handoff**: Fixed context handoff failing when switching between GitHub Copilot models using different APIs (e.g., gpt-5 to claude-sonnet-4). Tool call IDs from OpenAI Responses API were incompatible with other models. ([#198](https://github.com/badlogic/pi-mono/issues/198))

- **Gemini 3 Pro thinking levels**: Thinking level configuration now works correctly for Gemini 3 Pro models. Previously all levels mapped to -1 (minimal thinking). Now LOW/MEDIUM/HIGH properly control test-time computation. ([#176](https://github.com/badlogic/pi-mono/pull/176) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.18.2] - 2025-12-11

### Changed

- **Anthropic SDK retries disabled**: Set `maxRetries: 0` on Anthropic client to allow application-level retry handling. The SDK's built-in retries were interfering with coding-agent's retry logic. ([#157](https://github.com/badlogic/pi-mono/issues/157))

## [0.18.1] - 2025-12-10

### Added

- **Mistral provider**: Added support for Mistral AI models via the OpenAI-compatible API. Includes automatic handling of Mistral-specific requirements (tool call ID format). Set `MISTRAL_API_KEY` environment variable to use.

### Fixed

- Fixed Mistral 400 errors after aborted assistant messages by skipping empty assistant messages (no content, no tool calls) ([#165](https://github.com/badlogic/pi-mono/issues/165))

- Removed synthetic assistant bridge message after tool results for Mistral (no longer required as of Dec 2025) ([#165](https://github.com/badlogic/pi-mono/issues/165))

- Fixed bug where `ANTHROPIC_API_KEY` environment variable was deleted globally after first OAuth token usage, causing subsequent prompts to fail ([#164](https://github.com/badlogic/pi-mono/pull/164))

## [0.17.0] - 2025-12-09

### Added

- **`agentLoopContinue` function**: Continue an agent loop from existing context without adding a new user message. Validates that the last message is `user` or `toolResult`. Useful for retry after context overflow or resuming from manually-added tool results.

### Breaking Changes

- Removed provider-level tool argument validation. Validation now happens in `agentLoop` via `executeToolCalls`, allowing models to retry on validation errors. For manual tool execution, use `validateToolCall(tools, toolCall)` or `validateToolArguments(tool, toolCall)`.

### Added

- Added `validateToolCall(tools, toolCall)` helper that finds the tool by name and validates arguments.

- **OpenAI compatibility overrides**: Added `compat` field to `Model` for `openai-completions` API, allowing explicit configuration of provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`). Falls back to URL-based detection if not set. Useful for LiteLLM, custom proxies, and other non-standard endpoints. ([#133](https://github.com/badlogic/pi-mono/issues/133), thanks @fink-andreas for the initial idea and PR)

- **xhigh reasoning level**: Added `xhigh` to `ReasoningEffort` type for OpenAI codex-max models. For non-OpenAI providers (Anthropic, Google), `xhigh` is automatically mapped to `high`. ([#143](https://github.com/badlogic/pi-mono/issues/143))

### Changed

- **Updated SDK versions**: OpenAI SDK 5.21.0 → 6.10.0, Anthropic SDK 0.61.0 → 0.71.2, Google GenAI SDK 1.30.0 → 1.31.0

## [0.13.0] - 2025-12-06

### Breaking Changes

- **Added `totalTokens` field to `Usage` type**: All code that constructs `Usage` objects must now include the `totalTokens` field. This field represents the total tokens processed by the LLM (input + output + cache). For OpenAI and Google, this uses native API values (`total_tokens`, `totalTokenCount`). For Anthropic, it's computed as `input + output + cacheRead + cacheWrite`.

## [0.12.10] - 2025-12-04

### Added

- Added `gpt-5.1-codex-max` model support

### Fixed

- **OpenAI Token Counting**: Fixed `usage.input` to exclude cached tokens for OpenAI providers. Previously, `input` included cached tokens, causing double-counting when calculating total context size via `input + cacheRead`. Now `input` represents non-cached input tokens across all providers, making `input + output + cacheRead + cacheWrite` the correct formula for total context size.

- **Fixed Claude Opus 4.5 cache pricing** (was 3x too expensive)
  - Corrected cache_read: $1.50 → $0.50 per MTok
  - Corrected cache_write: $18.75 → $6.25 per MTok
  - Added manual override in `scripts/generate-models.ts` until upstream fix is merged
  - Submitted PR to models.dev: https://github.com/sst/models.dev/pull/439

## [0.9.4] - 2025-11-26

Initial release with multi-provider LLM support.
