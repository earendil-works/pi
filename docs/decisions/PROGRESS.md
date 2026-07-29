# ADR Archaeology — Progress Log

Use this to trace relationships between records without re-reading commits.
Each session logs every commit that was flagged as significant, with a one-liner.

---

## Session 1 — 2026-07-28

**Range:** a74c5da1 → efaa5cdb (commits 1–100)
**Branch:** adr-archaeology/phase-1
**Resume at:** `0fbb0921` feat(ai): Add gpt-5-chat-latest model to generated models

### Flagged commits

| Hash | One-liner |
|---|---|
| `a74c5da1` | Initial monorepo setup with npm workspaces, dual tsconfig, lockstep versioning |
| `afa807b2` | TUI double-buffer: smart differential rendering + VirtualTerminal abstraction |
| `386f90fc` | TUI surgical differential rendering refinement (follow-up to afa807b2) |
| `f064ea0e` | Create unified AI package with OpenAI/Anthropic/Gemini, streaming-first |
| `e5aedfed` | Implement unified AI API with Anthropic provider (building on f064ea0e) |
| `8364ecde` | Add OpenAI Completions and Responses API providers |
| `a8ba19f0` | Implement Gemini provider with streaming and tool support |
| `f29752ac` | Refactor AI API to support multiple thinking and text blocks |
| `bf1f410c` | Refactor AI API for partial results on abort |
| `02a9b4f0` | Add models.dev data integration for model metadata |
| `da66a97e` | Auto-generated models.generated.ts with type-safe createLLM factory |
| `c7618db3` | Unified model system: Model interface, type-safe createLLM, provider cleanup |
| `efaa5cdb` | Fetch models from models.dev directly instead of OpenRouter (primary providers) |
| `46b5800d` | Cross-provider message handoff with transformMessages() |
| `2e90f8f8` | Enable browser support for OpenAI providers |
| `d46a98ec` | Rename package to @mariozechner/pi-ai |

### Connections to track

- ADR-003 (f064ea0e) → ADR-004 (da66a97e): unified AI package needed a model registry; code-gen pipeline added ~8 days later
- ADR-004 spans three commits: da66a97e (initial gen) → c7618db3 (unified model system) → efaa5cdb (models.dev sourcing shift)
- ADR-002 (afa807b2) → ADR-011 (97c730c8): ADR-011 replaces ADR-002's rendering engine while keeping the component interface
- efaa5cdb (models.dev sourcing) reverses the earlier OpenRouter-first approach used in c7618db3

### No TDRs in this range

### ADRs written

| # | Title | Source |
|---|---|---|
| 001 | Monorepo with npm workspaces and lockstep versioning | `a74c5da1` |
| 002 | Custom TUI engine with differential rendering | `afa807b2` |
| 003 | Unified AI provider abstraction with streaming-first API | `f064ea0e` |
| 004 | Auto-generated model registry with type-safe factory | `da66a97e` / `c7618db3` / `efaa5cdb` |
| 005 | Cross-provider message handoff protocol | `46b5800d` |

---

## Session 2 — 2026-07-28

**Range:** 0fbb0921 → 741add44 (commits 101–300)
**Branch:** adr-archaeology/phase-1
**Resume at:** `3fcae75e` Remove StreamingMessageComponent - just use AssistantMessageComponent

### Flagged commits

| Hash | One-liner |
|---|---|
| `004de3c9` | New streaming generate API with AsyncIterable interface |
| `4cee070b` | Simplify API with new streaming interface and model management |
| `d073953e` | Add zAI provider support |
| `35fe8f21` | Implement Zod-based tool validation and improve Agent API (later replaced) |
| `e8370436` | Replace Zod with TypeBox for schema validation (reverses 35fe8f21) |
| `98a876f3` | Preliminary tool call streaming — argument deltas only, no partial JSON |
| `f55985f6` | GPT-5 no-reasoning mode cannot be fully disabled |
| `39c626b6` | Partial JSON parsing for streaming tool calls |
| `b67c10df` | Add cross-browser extension |
| `aaea0f46` | Integrate JailJS for CSP-restricted execution |
| `04966513` | Pluggable storage + Anthropic prompt caching + CORS proxy |
| `e5cf25a2` | Refactor agent architecture and add session persistence |
| `05dfaa11` | Custom message extension system |
| `aa005d06` | Remove browser-extension package to separate sitegeist repo |
| `4e7a3404` | Unicode surrogate sanitization for all providers |
| `ffc9be88` | Agent package + coding agent WIP |
| `bbbc232c` | Unified storage architecture (single IndexedDB backend) |
| `0de89a75` | Refactor to Store-based architecture |
| `c2793d80` | Runtime bridge for sandboxed provider execution |
| `97c730c8` | TUI rewrite with 3-strategy differential rendering |
| `741add44` | Refactor TUI into proper components |

### Connections to track

- ADR-007 (e8370436) reverses the Zod decision (35fe8f21) — no ADR was written for Zod since it was replaced within ~3 commits
- ADR-008 (04966513, multi-backend) → ADR-008 (bbbc232c, single backend): two-pass evolution, multi-backend approach lasted ~3 days before consolidation
- ADR-011 (97c730c8) replaces ADR-002 (afa807b2): complete TUI engine rewrite, same component interface
- ADR-009 (e5cf25a2) builds on ADR-008's storage architecture: session persistence used the IndexedDB backend set up the day before
- TDR-001 (98a876f3) relates to ADR-006: tool call streaming is part of the streaming API defined in ADR-006
- TDR-002 (f55985f6) relates to ADR-003: GPT-5 is a provider under the unified abstraction from ADR-003
- `aa005d06` (browser extension extraction) flips `b67c10df` (browser extension creation) — born and extracted within the same month

### TDRs written

| ID | Title | Source |
|---|---|---|
| TDR-001 | Tool call streaming reports argument deltas, not partial JSON | `98a876f3` |
| TDR-002 | GPT-5 reasoning mode cannot be fully disabled | `f55985f6` |

### ADRs written

| # | Title | Source |
|---|---|---|
| 006 | AsyncIterable streaming generate API | `004de3c9` / `4cee070b` |
| 007 | TypeBox over Zod for schema validation | `e8370436` |
| 009 | Agent architecture refactor with session persistence | `e5cf25a2` |
| 008 | Pluggable storage architecture and Anthropic prompt caching | `04966513` / `bbbc232c` |
| 010 | Runtime bridge for sandboxed execution | `c2793d80` |
| 011 | TUI rewrite with three-strategy differential rendering | `97c730c8` |

---

## Session 3 — 2026-07-28

**Range:** 3fcae75e → f6148924 (commits 301–800)
**Branch:** adr-archaeology/phase-1
**Resume at:** `3fcae75e`

### Flagged commits

| Hash | One-liner |
|---|---|
| `dca3e1cc` | Hierarchical context file loading for monorepos (AGENTS.md walk) |
| `b1c2c32e` | Move context files from user messages to system prompt |
| `79ee33c3` | Rename package to @mariozechner/pi-coding-agent |
| `0c5cbd00` | Custom models/providers via models.json |
| `587d7c39` | OAuth authentication for Claude Pro/Max |
| `cc880951` | Theming system with /theme command (36 color tokens, dark/light) |
| `c4a65ad8` | Standalone binary with Bun compilation |
| `5daef11b` | Compaction research and implementation plan |
| `c89b1ec3` | Context compaction: /compact, /autocompact, auto-trigger |
| `a38e6190` | New compaction system with overflow recovery |
| `5a9d844f` | Simplify compaction: remove proactive abort, use Agent.continue() |
| `3d7edfa6` | Windows Git Bash support for bash tool |
| `bd0d0676` | Bash mode (! prefix for shell commands) |
| `8bec289d` | Remove provider-level tool validation, add validateToolCall helper |
| `99b4b1ac` | Mistral AI provider with compat flags |
| `3f305502`→`dcf81a6a` | AgentSession refactor (17 WP commits) |
| `3559a43b` | RPC mode rewrite with typed protocol and RpcClient |
| `04d59f31` | Hooks system with pi.send() and mode-specific UI context |
| `aa9e0582` | mom Slack bot package with abort support and streaming |
| `29900ce6` | Make bash tool timeout optional and configurable |
| `8ae236f9` | /branch command for conversation branching |
| `b8e5f8db` | Fuzzy file search with @ prefix |
| `a84a97e1` | Switch web-ui back to tsc from tsgo for decorator support |
| `e467a80b` | /export command for session HTML export |

### Connections to track

- ADR-019 (AgentSession) is the hub — ADR-018 (bash mode), ADR-020 (RPC), and ADR-021 (hooks) all build on it. The mom package (aa9e0582) also uses AgentSession
- ADR-017 (compaction) was researched (5daef11b) before implementation, then simplified post-release (5a9d844f): removed proactive abort, used Agent.continue() instead
- ADR-022 (Mistral) extends the compat flag pattern from ADR-007 (TypeBox validation) — most flags of any provider, shows how wide the gap is between "OpenAI-compatible" and actual behavior
- ADR-012 (b1c2c32e): context files moved from user messages to system prompt after ADR-012's initial implementation — changes how the LLM prioritizes them
- `8bec289d` (tool validation removal) relates to ADR-007: after switching to TypeBox/AJV, provider-level validation was redundant; consolidated into a shared helper
- `79ee33c3` (package rename) and ADR-016 (binary): the rename to @mariozechner/pi-coding-agent happened ~2 weeks before binary distribution
- `8ae236f9` (/branch) relates to ADR-017 (compaction): branching is the alternative to compaction — preserve full history vs compress
- `a84a97e1` (web-ui back to tsc): a reversal of the earlier tsgo decision for the web-ui package only

### ADRs written

| # | Title | Source |
|---|---|---|
| 012 | Hierarchical context file loading for monorepos | `dca3e1cc` |
| 013 | Custom providers via models.json | `0c5cbd00` |
| 014 | OAuth authentication for Claude Pro/Max | `587d7c39` |
| 015 | Theming system with user-defined themes | `cc880951` |
| 016 | Standalone binary distribution with Bun | `c4a65ad8` |
| 017 | Context compaction system | `c89b1ec3` |
| 018 | Bash mode for shell command execution | `bd0d0676` |
| 019 | Coding agent refactor into AgentSession architecture | `3f305502`→`dcf81a6a` |
| 020 | RPC mode with typed protocol | `3559a43b` |
| 021 | Hooks system for extensibility | `04d59f31` |
| 022 | Mistral AI provider with extended compat flags | `99b4b1ac` |

---

## Session 4 — 2026-07-28

**Range:** 5095b4eb → 0f27eae7 (commits ~801–1800)
**Branch:** adr-archaeology/phase-1
**Resume at:** `acec56c6`

### Flagged commits

| Hash | One-liner |
|---|---|
| `5482bf3e` | SDK for programmatic AgentSession usage (createAgentSession factory) |
| `c58d5f20` | Session tree structure with id/parentId linking |
| `2846c7d1` | Unified extensions system (hooks + custom-tools merge) |
| `8f268257` | Configurable keybindings via keybindings.json |
| `d0a4c370` | Split queue into steer() and followUp() APIs |
| `42d7d9d9` | Before/after session events with cancellation |
| `c53b22db` | /settings command with unified settings menu |
| `f8d3b0e3` | Auto-load SYSTEM.md as custom system prompt |
| `746ec9eb` | Shell commands without context contribution (!! prefix) |
| `dde5f251` | Word wrapping in Editor component |
| `6467e709` | Vertex AI provider with ADC support |
| `1650041a` | OpenAI Codex OAuth + responses provider |
| `256fa575` | Export-html rewrite with tree sidebar, client-side rendering |
| `9c9e6822` | Event bus for tool/hook communication |
| `4cee51e4` | Plan-mode hook (todo tracking, progress, widget, context events) |
| `77fe3f1a` | Context event for pre-LLC message modification |
| `51d396b3` | setWidget/setWidgetComponent API for hooks |
| `57bba4e3` | Hook API for tool control, CLI flags, shortcuts |
| `93498737` | steer()/followUp() migration completed (PR #403) |
| `f8b3d0e3` | Auto-load SYSTEM.md |
| `1f3f8511` | Session tree merge (branching, compaction, hook API) |

### Connections to track

- ADR-026 (extensions) merges ADR-021 (hooks) and the earlier custom-tools system into one API
- ADR-029 (steer/followUp) refines the queue mechanism originally added alongside ADR-019 (AgentSession)
- ADR-024 (session tree) is a fundamental change to session storage — ADR-017 (compaction) and ADR-009 (session persistence) both needed updates
- ADR-030 (hook expansion) builds directly on ADR-021 (hooks) — adds widget, context event, text_delta, tool registration
- ADR-023 (SDK) exposes ADR-019 (AgentSession) as a documented public API
- TDR-004 relates to ADR-024: the one-way migration without rollback was a known risk from the start

### TDRs written

| ID | Title | Source |
|---|---|---|
| TDR-003 | Image resizing heuristics for provider size limits | `69dc6b07` |
| TDR-004 | Session tree migration without rollback | `cb6310e1` |
| TDR-005 | Truecolor assumed for all terminals | `b4fb6770` |

### ADRs written

| # | Title | Source |
|---|---|---|
| 024 | Session tree structure with id/parentId branching | `c58d5f20` |
| 023 | SDK for programmatic AgentSession usage | `5482bf3e` |
| 026 | Unified extensions system | `2846c7d1` / `cf1c4c31` |
| 027 | Configurable keybinding system | `8f268257` |
| 029 | Steer and followUp API split | `d0a4c370` / `93498737` |
| 028 | Shell commands without context contribution | `746ec9eb` |
| 025 | Settings command with unified settings UI | `c53b22db` |
| 030 | Hook API expansion — plan mode, widgets, context events | `4cee51e4` / `51d396b3` / `57bba4e3` / `77fe3f1a` |
| 031 | OpenAI Codex OAuth provider | `1650041a` |
| 032 | Rename /branch to /fork | `df3f5f41` |
| 033 | Event bus for extension communication | `9c9e6822` |

---

## Session 5 — 2026-07-28

**Range:** acec56c6 → a363b668 (commits ~1801–3800)
**Branch:** adr-archaeology/phase-1
**Resume at:** `a363b668`

### Triage notes

2000-commit batch. Read in chunks due to truncation. First pass caught the major ADRs. Re-read of middle sections caught two more (ADR-037, ADR-036). Several commits follow established patterns and are logged below for reference.

### ADRs written this session

| # | Title | Source |
|---|---|---|
| 038 | Extension package management with ResourceLoader | `b846a4bf` |
| 035 | Amazon Bedrock provider | `fd268479` |
| 039 | Azure OpenAI Responses provider | `85601229` |
| 032 | Rename /branch to /fork | `df3f5f41` |
| 040 | Per-tool execution mode override | `bfa11a50` |
| 034 | TUI overlay compositing | `f9064c2f` / `a4ccff38` |
| 037 | Custom provider support via extensions | `177c6944` / `3256d3c0` |
| 036 | HTTP proxy support via environment variables | `1e718e63` |

### TDRs written this session

| ID | Title | Source |
|---|---|---|
| TDR-006 | Image processing library churn | `e45fc5f9` / `6bf073f1` |

### Missed in first pass (caught on re-read)

- Custom provider extension API (177c6944, 3256d3c0) → ADR-037
- HTTP proxy support (1e718e63) → ADR-036

### Connections to track

- ADR-037 (custom provider API) and ADR-036 (HTTP proxy) both extend the provider system infrastructure from ADR-003 and ADR-013
- ADR-038 (package management) builds on ADR-026 (extensions) — extensions now installable from git URLs
- ADR-032 (fork rename) relates to ADR-024 (session tree) — fork is the user-facing operation on the tree
- ADR-040 (tool execution mode) adds a capability orthogonal to ADR-026's extension tools
- ADR-034 (overlay compositing) extends the TUI from ADR-011 and the extension UI context from ADR-030
- ADR-035 (Bedrock) and ADR-039 (Azure) follow the provider patterns established in ADR-003 and ADR-022
- TDR-006 (image processing churn) relates to TDR-003 (image resizing) — both deal with the image handling pipeline

### Other notable commits in this range

| Hash | One-liner | Notes |
|---|---|---|
| `dac7474d` | OpenRouter provider routing | Covered by ADR-013 |
| `c808de60` | Hugging Face provider | Follows ADR-003 provider pattern |
| `87ab5c5c` | Kimi For Coding provider | Follows ADR-003 provider pattern |
| `993c45a0` | Qwen CLI OAuth provider | Extension provider via ADR-037 |
| `3e6d8dc7` | GitLab Duo provider extension | Extension provider via ADR-037 |
| `cb850676` | Android/Termux support | Platform port |
| `86b43c8e` | Bash spawn hook | Extension hook via ADR-026/030 |
| `bd646eec` | Per-model overrides in models.json | Covered by ADR-013 |
| `c35be660` | Merge custom models with built-ins by id | Covered by ADR-013/039 |
| `30fd99bd` | Terminal input hook for extensions | Extension hook via ADR-030 |
| `ff5148e7` | Forward message/tool events to extensions | Extension event via ADR-026/031 |
| `757d36a4` | Offline startup mode | Minor |
| `a26a9cfa` | Configurable transport and codex websocket caching | Provider detail |

---

## Session 6 — 2026-07-28

**Range:** a363b668 → 027a5847 (commits ~3801–5162)
**Branch:** adr-archaeology/phase-1
**Resume at:** HEAD — all commits processed

### ADRs written this session

| # | Title | Source |
|---|---|---|
| 041 | AgentHarness testing architecture | `a5b27367` / `c0f416aa` |
| 042 | Provider and package pruning | `fe66edd9` / `0ed0d434` / `b141e1fa` |
| 043 | Image output generation | `e3d066da` / `62d91326` / `e9b0af0a` |
| 044 | Constrained sampling for structured output | `24bace27` |
| 045 | Models runtime with provider-owned auth | `f63095cf` — `10a575b7` (8 phases) |
| 046 | Per-request fetch injection | `027a5847` |
| 047 | SQLite session storage backend | `9e7582aa` |

### TDRs written this session

None.

### Connections to track

- ADR-045 (Models runtime) is the most significant architectural change in this batch — it restructures how providers, auth, and model resolution work, building on ADR-003 (provider abstraction), ADR-004 (model registry), and ADR-037 (custom provider API)
- ADR-043 (image output) adds a new capability orthogonal to the existing image processing pipeline (TDR-003, TDR-006)
- ADR-041 (AgentHarness) provides the testing infrastructure that the AgentSession (ADR-019) and extensions (ADR-026) systems needed
- ADR-042 (pruning) reverses earlier decisions to add Google providers (ADR-003 extensions), the mom package, and the web-ui package — acknowledging that not all experiments become permanent
- ADR-046 (fetch injection) gives extensions a per-request hook into the provider HTTP layer, complementing ADR-036 (HTTP proxy)
- ADR-044 (constrained sampling) adds structured output enforcement to the provider interface from ADR-003
- The Models refactoring (ADR-045) is the capstone to the provider evolution that started with ADR-003 and went through ADR-013, ADR-022, ADR-031, ADR-035, ADR-039, ADR-037, ADR-036, ADR-046, and ADR-044
