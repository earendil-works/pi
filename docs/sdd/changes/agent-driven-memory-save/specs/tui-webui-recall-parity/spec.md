# tui-webui-recall-parity Specification

## ADDED Requirements

### Requirement: shared `recallPipeline` is the single recall entry point

Both the TUI `context` hook (personal-assistant `memory.ts:726`) and the webui `POST /api/memory/search` route (webui `routes/memory.ts:845`) SHALL invoke the same `recallPipeline(index, opts)` function from `extensions/personal-assistant/recall.ts`. No inline recall/rewrite/rerank/merge pipeline code SHALL remain in either caller after this change.

#### Scenario: TUI context hook delegates to recallPipeline

- **GIVEN** `gate` returns `need_memory: true` and `rewriteEnabled` is true
- **WHEN** the TUI `context` hook processes a user message
- **THEN** the hook calls `recallPipeline(index, {query, recent, topK: 20, rerankEnabled, atomsDir, embeddingServiceUrlProbe: false})`
- **AND** the hook does NOT directly call `rewriteQueries`, `recallAtoms`, `rerankAndFilter`, or `mergeByRerankScore`
- **AND** the hook still calls `formatMemoryContext` and injects the result into the last user message

#### Scenario: webui /api/memory/search delegates to recallPipeline

- **GIVEN** the request body validates (non-empty `query`)
- **WHEN** the webui `POST /api/memory/search` handler runs
- **THEN** the handler calls `recallPipeline(index, {query, recent, topK, filter, rerankEnabled, atomsDir, embeddingServiceUrl, embeddingServiceUrlProbe: true})`
- **AND** the handler does NOT directly call `rewriteQueries`, `recallAtoms`, `rerankAndFilter`, or `mergeByRerankScore`
- **AND** the handler maps `status.embeddingServiceStatus` from the pipeline into the response body

### Requirement: recallPipeline accepts `recent` for anaphora resolution

`recallPipeline` SHALL accept an optional `recent: string[] | null` parameter and forward it to `rewriteQueries`. When `recent` is `null` or `undefined`, the pipeline SHALL pass `null` to `rewriteQueries` so the rewrite LLM sees `Recent user messages: None` placeholder. When `recent` is a non-empty array, the pipeline SHALL pass it verbatim.

#### Scenario: TUI passes recent user messages for anaphora

- **GIVEN** the TUI `context` hook extracts the last 3 prior user messages as `["msg1", "msg2", "msg3"]`
- **WHEN** the hook calls `recallPipeline(index, {query: current, recent: ["msg1", "msg2", "msg3"], ...})`
- **THEN** the internal `rewriteQueries` call receives `(query, ["msg1", "msg2", "msg3"])`
- **AND** the rewrite prompt includes the `Recent user messages:` block with those three messages

#### Scenario: webui passes recent: null by default

- **GIVEN** the webui request body has no `recent` field
- **WHEN** the handler calls `recallPipeline(index, {query, recent: null, ...})`
- **THEN** the internal `rewriteQueries` call receives `(query, null)`
- **AND** the rewrite prompt includes the `Recent user messages: None` placeholder

#### Scenario: webui accepts recent: string[] when provided

- **GIVEN** the webui request body has `recent: ["past1", "past2"]`
- **WHEN** the handler validates and forwards to `recallPipeline`
- **THEN** the rewrite prompt includes the `Recent user messages:` block with `["past1", "past2"]`

#### Scenario: webui rejects recent of wrong type

- **GIVEN** the webui request body has `recent: 42` (not an array)
- **WHEN** the handler validates the body
- **THEN** the handler returns HTTP 400 `{error: "recent must be string[] or absent"}`
- **AND** `recallPipeline` is NOT invoked

### Requirement: recallPipeline default `topK` is 20

`recallPipeline` SHALL default `topK` to `20` when the caller does not specify it. When specified, `topK` SHALL be clamped to the closed interval `[1, 100]`. The webui `POST /api/memory/search` route SHALL forward the request body's `topK` (or 20 when absent) to `recallPipeline` — the route SHALL NOT keep its own default different from the pipeline.

#### Scenario: TUI default topK = 20

- **GIVEN** the TUI `context` hook calls `recallPipeline(index, {query, recent, ...})` without `topK`
- **WHEN** the pipeline runs
- **THEN** each per-subquery `recallAtoms` call uses `topK: 20`

#### Scenario: webui default topK = 20 (was 10)

- **GIVEN** the webui request body has no `topK` field
- **WHEN** the handler forwards to `recallPipeline(index, {query, topK: 20, ...})`
- **THEN** each per-subquery `recallAtoms` call uses `topK: 20`
- **AND** this matches the TUI default

#### Scenario: webui topK clamped to [1, 100]

- **GIVEN** the webui request body has `topK: 200`
- **WHEN** the handler forwards to `recallPipeline`
- **THEN** `recallPipeline` clamps internally to `topK: 100` before calling `recallAtoms`
- **AND** for `topK: 0` or `topK: -5`, the pipeline clamps to `1`

### Requirement: recallPipeline exposes pipeline timing and status metadata

`recallPipeline` SHALL return `{results, status}` where `status` includes:
- `rewrite`: one of `"ok" | "skip" | "parse" | "timeout" | "unreachable"`
- `rerank`: one of `"ok" | "fallback" | "skip" | "all-below"`
- `recallMs`, `rewriteMs`, `rerankMs`: wall-clock milliseconds for each stage
- `embeddingServiceStatus`: optional `"up" | "down"` (only when caller sets `embeddingServiceUrlProbe: true`)

#### Scenario: pipeline status reflects each stage's outcome

- **GIVEN** `rewriteQueries` succeeds returning 2 subqueries
- **AND** `recallAtoms` returns 5 hits per subquery
- **AND** `rerankAndFilter` returns an array (success, not fallback)
- **WHEN** `recallPipeline` returns
- **THEN** `status.rewrite === "ok"`
- **AND** `status.rerank === "ok"`
- **AND** `status.recallMs > 0`, `status.rewriteMs > 0`, `status.rerankMs > 0`

#### Scenario: rerank fallback surfaced in status

- **GIVEN** `rerankAndFilter` returns `RerankFallback { reason: "timeout", topK: hits.slice(0, 3) }`
- **WHEN** `recallPipeline` returns
- **THEN** `status.rerank === "fallback"`
- **AND** `results` contains the fallback `topK` slice

#### Scenario: webui embedding service status from pipeline

- **GIVEN** the embedding service `/api/health` returns 2xx
- **WHEN** the webui handler calls `recallPipeline(index, {..., embeddingServiceUrlProbe: true})`
- **THEN** `status.embeddingServiceStatus === "up"`
- **AND** the webui response includes `embeddingServiceStatus: "up"`

#### Scenario: webui embedding service down surfaces status

- **GIVEN** the embedding service `/api/health` returns 500
- **WHEN** the webui handler calls `recallPipeline(index, {..., embeddingServiceUrlProbe: true})`
- **THEN** `status.embeddingServiceStatus === "down"`
- **AND** the webui response includes `embeddingServiceStatus: "down"`

### Requirement: webui response shape preserved with pipeline metadata

The webui `POST /api/memory/search` response SHALL preserve its existing shape (`results` array with `id`, `type`, `title`, `summary`, `tags`, `cosine`, `sparseScore`, `rrf`, optional `rerankScore`) AND add `embeddingServiceStatus` from the pipeline. The `recallTimeMs`, `rewriteTimeMs`, `rerankTimeMs` fields SHALL be sourced from `recallPipeline` status, not measured inline.

#### Scenario: webui response includes pipeline-derived timings

- **GIVEN** `recallPipeline` returns `status: {recallMs: 123, rewriteMs: 45, rerankMs: 67, ...}`
- **WHEN** the webui handler builds the response
- **THEN** response body includes `recallTimeMs: 123`, `rewriteTimeMs: 45`, `rerankTimeMs: 67`
- **AND** (when `filtered !== false`) all three are present
- **AND** (when `filtered === false`) only `recallTimeMs` is present (matching the existing shape)

#### Scenario: webui response includes embeddingServiceStatus

- **GIVEN** `recallPipeline` returns `status.embeddingServiceStatus: "up"`
- **WHEN** the webui handler builds the response
- **THEN** response body includes `embeddingServiceStatus: "up"`
- **AND** this field is always present regardless of `filtered` value