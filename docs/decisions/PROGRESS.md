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
- ADR-009 (04966513, multi-backend) → ADR-009 (bbbc232c, single backend): two-pass evolution, multi-backend approach lasted ~3 days before consolidation
- ADR-011 (97c730c8) replaces ADR-002 (afa807b2): complete TUI engine rewrite, same component interface
- ADR-008 (e5cf25a2) builds on ADR-009's storage architecture: session persistence used the IndexedDB backend set up the day before
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
| 008 | Agent architecture refactor with session persistence | `e5cf25a2` |
| 009 | Pluggable storage architecture and Anthropic prompt caching | `04966513` / `bbbc232c` |
| 010 | Runtime bridge for sandboxed execution | `c2793d80` |
| 011 | TUI rewrite with three-strategy differential rendering | `97c730c8` |

