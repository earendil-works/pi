# Research: Dart Agent Package

## Decision 1: Discriminated Unions via Dart Sealed Classes

**Decision**: Use Dart 3.0+ `sealed` classes for all discriminated union types (AgentEvent, SessionTreeEntry, LLM message types).

**Rationale**: Dart sealed classes provide compile-time exhaustiveness checking in `switch` expressions, zero code-gen overhead, and native pattern matching. This maps cleanly to the TypeScript discriminated unions in the source agent package without requiring `freezed` or build_runner.

**Alternatives considered**:
- `freezed` package: Adds code generation complexity, build_runner dependency, and `.part` files. Unnecessary overhead for unions that don't need JSON serialization.
- String-discriminated types (`type` field + `is` checks): No exhaustiveness checking, error-prone.

**Implementation notes**:
- All variants must be in the same library (file). This means `agent_events.dart` will contain the sealed `AgentEvent` base + all 9 variants.
- Use `const` constructors on leaf classes where fields are immutable.
- Base class can carry shared fields (e.g., `timestamp`).

---

## Decision 2: HTTP Streaming via package:http with AbortableRequest

**Decision**: Use `package:http` with `Client.send()` + `AbortableRequest` for streaming LLM API calls.

**Rationale**: `package:http` is maintained by the Dart team, has zero transitive dependencies, works on all platforms (including web via `BrowserClient`), and supports cancellation via `AbortableRequest` since v1.4+. The hand-rolled SSE parser is ~30 lines and avoids pulling in a third-party SSE package.

**Alternatives considered**:
- `dio`: Adds ~5 transitive dependencies, agent-level cancellation via `CancelToken`. Overkill for simple SSE streaming.
- `dart:io` `HttpClient`: Platform-limited (no web), manual cancellation management.
- `eventflux` / `flutter_client_sse`: Extra dependencies, Flutter-centric.

**Implementation notes**:
- SSE parser: `utf8.decoder` -> `LineSplitter` -> buffer lines until blank line boundary
- Handle `data:`, `event:`, `id:` prefixes per SSE spec
- Wrap in `async*` generator for ergonomic `Stream<Map<String, String>>` output

---

## Decision 3: JSON Schema Validation via Lightweight Custom Approach

**Decision**: Implement a custom lightweight parameter validation system rather than depending on the full `json_schema` package.

**Rationale**: The full `json_schema` package has 5 transitive dependencies and implements the entire JSON Schema Draft 7 spec with `$ref` resolution, remote schemas, etc. For tool call parameter validation, we only need type checking on simple schemas (string, number, integer, boolean, object, array, enum). A custom ~80-line validator avoids unnecessary dependencies and is more maintainable.

**Alternatives considered**:
- `json_schema` (Workiva, 172k downloads): Full spec but heavy (http, logging, rfc_6901, uri, collection deps).
- `ez_validator`: Zod-like API but not standard JSON Schema format (LLMs produce standard JSON Schema).
- Manual `Map` type extraction: Fragile, no schema validation.

**Implementation notes**:
- Accept JSON Schema-compatible dictionary format (LLMs emit this natively)
- Validate: type, properties, required, enum, items, description
- Return typed error messages with property paths
- No `$ref`, `oneOf`, `anyOf`, `allOf`, `if/then/else` — simple schemas only

---

## Decision 4: YAML Frontmatter Parsing

**Decision**: Use `yaml` package from pub.dev for SKILL.md and prompt template YAML frontmatter parsing.

**Rationale**: The `yaml` package is the de facto standard for YAML parsing in Dart, has 100% popularity on pub.dev, zero transitive dependencies, and is maintained by the Dart team. It's the same approach used in the source pi agent package.

**Alternatives considered**:
- Manual YAML parsing: Error-prone, doesn't handle nested structures.
- `yaml_writer` / `yaml_edit`: For writing YAML, not needed (read-only use case).

---

## Decision 5: Package Structure and pub.dev Compliance

**Decision**: Follow the standard Dart package layout with `lib/src/` for implementation, `lib/<package>.dart` as public barrel, and full pub.dev required files.

**Rationale**: The pub.dev scoring system requires LICENSE, README.md, CHANGELOG.md, example/, and dartdoc comments on 20%+ of public API. Following conventions ensures maximum pub points and a professional appearance.

**Required files**:
- `pubspec.yaml`: name, version, description, SDK constraint >=3.0.0, dependencies
- `LICENSE`: BSD 3-Clause or MIT
- `README.md`: Installation, usage, provider setup
- `CHANGELOG.md`: Semantic versioning format
- `example/`: Standalone example program
- `analysis_options.yaml`: Using `lints` package + `public_member_api_docs`

---

## Decision 6: Dependency Choices

| Dependency | Source | Purpose |
|---|---|---|
| `http` | pub.dev (Dart team) | HTTP client for LLM API calls |
| `yaml` | pub.dev (Dart team) | YAML frontmatter parsing for skills/templates |
| `test` | pub.dev (Dart team) | Unit testing |
| `lints` | pub.dev (Dart team) | Linter rules |

**Total external dependencies**: 2 runtime (`http`, `yaml`), 2 dev (`test`, `lints`).

No dependency on `dart:io`-only APIs (the package should work on web where HTTP calls can use `BrowserClient` from `package:http`).

---

## Decision 7: Session Storage Format

**Decision**: Use JSON Lines (JSONL) format for file-based session storage.

**Rationale**: Matches the source pi agent package. JSONL is simple, append-friendly, human-readable, and can be processed line-by-line without loading the entire session into memory.

**Implementation notes**:
- Each line is a JSON object representing a `SessionTreeEntry`
- Lines are appended atomically (write full line with trailing newline)
- Recovery: skip malformed lines, reconstruct tree from valid entries

---

## Decision 8: Abort/Cancellation Pattern

**Decision**: Use `Completer<void>` as abort trigger, passed to `AbortableRequest` from `package:http`.

**Rationale**: Dart does not have a built-in `AbortSignal`/`AbortController` like JavaScript. Using `Completer<void>` with `AbortableRequest.abortTrigger` provides equivalent functionality: calling `completer.complete()` aborts the HTTP request and any stream listeners.

**Implementation notes**:
- Agent owns an `AbortController`-like object (wrapping `Completer<void>`)
- `abort()` completes the completer and cancels stream subscriptions
- New runs create a fresh completer
- Tool execution receives a reference for cooperative cancellation
