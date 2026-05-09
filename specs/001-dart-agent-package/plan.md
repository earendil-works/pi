# Implementation Plan: Dart Agent Package

**Branch**: `001-dart-agent-package` | **Date**: 2026-05-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-dart-agent-package/spec.md`

## Summary

Create a pub.dev-ready Dart package (`pi_agent`) that mirrors the core functionality of the `@earendil-works/pi-agent-core` TypeScript package. The package provides an Agent class with stateful conversation management, tool execution (parallel/sequential), streaming event emission, session persistence, skill loading, and context compaction. It targets Dart SDK >= 3.0.0 and uses sealed classes for discriminated unions, `package:http` for LLM streaming, and minimal external dependencies (2 runtime: `http`, `yaml`).

## Technical Context

**Language/Version**: Dart 3.0+ (for sealed classes, records, pattern matching)
**Primary Dependencies**: `http` (LLM HTTP streaming), `yaml` (YAML frontmatter parsing)
**Storage**: JSONL files (append-only), in-memory (testing/transient)
**Testing**: `dart test` using `package:test`
**Target Platform**: Dart VM (native), native executables, web (via `package:http` `BrowserClient`)
**Project Type**: Library (pub.dev Dart package)
**Performance Goals**: <100ms overhead per tool execution, <50MB memory for typical conversations
**Constraints**: Zero Node.js dependencies, no TypeScript-specific APIs, max 2 runtime deps
**Scale/Scope**: Single-agent usage; conversation transcripts up to model context window (200K tokens)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution template is unfilled (all placeholders). No specific constitutional gates are defined for this project. Proceeding with standard Dart package best practices:

- Library-first design: package is self-contained, independently testable
- Test coverage target: 80%+ on core library files
- Documentation: dartdoc comments on all public API
- Static analysis: zero errors/warnings via `dart analyze`

**Verdict**: PASS — No constitutional violations. Standard library best practices applied.

## Project Structure

### Documentation (this feature)

```text
specs/001-dart-agent-package/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── public-api.md    # Public API contract
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
pi_agent/
├── lib/
│   ├── pi.dart           # Barrel export
│   └── src/
│       ├── agent.dart           # Agent class
│       ├── agent_loop.dart      # Low-level agent loop
│       ├── types.dart            # Core types (events, messages, tools, config)
│       ├── tools.dart            # AgentTool + parameter validation
│       ├── session.dart          # Session class
│       ├── session_storage.dart  # InMemory + JSONL storage
│       ├── skills.dart           # SKILL.md loading + formatting
│       ├── prompt_templates.dart # Prompt template loading + substitution
│       ├── execution_env.dart    # ExecutionEnv + NodeExecutionEnv
│       ├── compaction.dart       # Context compaction utilities
│       ├── sse_parser.dart       # SSE stream parser
│       ├── llm_client.dart       # LLM API client (OpenAI, Anthropic)
│       └── conversion.dart       # Message conversion utilities
├── test/
│   ├── agent_test.dart
│   ├── agent_loop_test.dart
│   ├── tools_test.dart
│   ├── session_test.dart
│   ├── session_storage_test.dart
│   ├── skills_test.dart
│   ├── prompt_templates_test.dart
│   ├── execution_env_test.dart
│   ├── compaction_test.dart
│   ├── sse_parser_test.dart
│   └── llm_client_test.dart
├── example/
│   └── main.dart                 # Standalone usage example
├── analysis_options.yaml
├── CHANGELOG.md
├── LICENSE
├── pubspec.yaml
└── README.md
```

**Structure Decision**: Single Dart package (library) with `lib/src/` for implementation and `lib/pi.dart` as barrel export. Follows standard Dart package layout conventions for pub.dev compatibility.

## Complexity Tracking

No constitutional violations to justify.

---

## Phase 0: Research (Complete)

See [research.md](./research.md) for all technology decisions and rationale. Key outcomes:

1. Dart sealed classes for discriminated unions (AgentEvent, SessionTreeEntry)
2. `package:http` with `AbortableRequest` for streaming LLM calls
3. Custom lightweight JSON Schema validation (~80 lines)
4. `yaml` package for SKILL.md / prompt template frontmatter
5. Standard Dart package layout for pub.dev compliance
6. 2 runtime dependencies: `http`, `yaml`
7. JSONL format for file-based session storage
8. `Completer<void>` for abort/cancellation pattern

## Phase 1: Design (Complete)

See [data-model.md](./data-model.md) for entity definitions, relationships, and state transitions.

See [contracts/public-api.md](./contracts/public-api.md) for the complete public API surface.

See [quickstart.md](./quickstart.md) for developer onboarding and usage examples.

## Phase 2: Tasks

Not part of this plan command. Will be generated by `/speckit.tasks`.
