# Changelog

## [Unreleased]

### Breaking Changes
- Memory module v2: complete rewrite using pure vector retrieval (sqlite-vec + bge-m3)
- Atom type union: 8 types → 3 types: `rule | fact | process` (replaces constraint/preference/knowledge/event/bug/workflow/solution/insight)
- File path: `<slug>.md` → `<type>/<atom.id>.md` (id-based, no slug collision)
- Content fingerprint now includes normalization (whitespace collapse + lowercase) before hashing
- Storage: `bun:sqlite`/`node:sqlite` wrapper → better-sqlite3 + sqlite-vec
- Removed: FTS5, query rewriting, CJK keyword expansion, isEmbeddingServiceAvailable fallback

### Added
- MemoryIndex class with KNN search, fingerprint-based dedup, supersede transactions, audit log
- executePlan with fingerprint + cosine (>= 0.92) two-tier dedup
- runDecay with exp decay formula, rule type never archived
- formatMemoryContext with L0/L1 tiering and token budget (default 4000)
- Lifecycle hooks: session_before_compact (extraction), session_start (throttled decay), before_agent_start + context (memory injection with 8s timeout)
- Extraction report JSON to ~/.pi/agent/logs/
- Recall quality validation: 14 atoms / 9 queries labeled dataset, char n-gram mock embed

### Changed
- memory.ts reduced from 1649 → 290 lines (v2 is entry-point-only)
- All v1 search/extract/decay logic moved to specialized modules (storage, search, format, extraction, decay)
- Schema: new tables (memory_index, memory_vectors vec0 FLOAT[1024], memory_audit) with 5 indexes
- Embedding: full text (title+summary+content+tags) instead of title-only
- Search is discovery-only: `recallAtoms` returns summary + `file_path` for every result (no L0/L1 tier hydration). The agent reads full content on demand via the standard `read` tool on the `file_path`. The `formatMemoryContext` injection block now includes a `file: <path>` line per atom so the LLM knows where to read.

### Fixed
- Hash mismatch between DB content_fingerprint and file contentHash (both now use normalizeContent before sha256)
- Express route shadowing: /api/memory/stats, /search, /extract now register before /:id

### Removed
- searchByFts, rewriteQuery, simpleKeywordExtraction, dedupeRedundantKeywords, dedupeAgainstQuery, expandCjkKeywords, isEmbeddingServiceAvailable, searchEmbeddings, parseRewriteJson, getEmbedding, callOllamaRewrite, searchAtoms, searchAtomsWithScores
- Legacy sqlite.ts wrapper

### Added (webui-memory-page)

### Added

- **Public API surface** for the memory subsystem: `MemoryIndex`, `MemoryAtom`, `MemoryAtomType`, `QueryRewriteResult` are now exported from `@earendil-works/pi-personal-assistant` (previously module-private), enabling the webui server to read/write atoms without re-implementing the index or the file store.
- **Server-friendly helpers** that take an injected `callLlm` callback instead of `ExtensionContext.modelRegistry`, so the webui server can run the recall pipeline without constructing a fake agent context:
  - `getAllAtoms(index)` — module-level function returning all atoms (including archived).
  - `MemoryIndex.invalidateEmbedding(id)` — public method that removes the cached embedding row (PATCH callers invoke this to defer recompute).
  - `rewriteQueryWithCallLlm(callLlm, query, config)` — runs the query rewrite path against an injected LLM callback; falls back to `simpleKeywordExtraction` on error or unparseable JSON.
  - `searchAtomsWithScores(index, query, topK, config?)` — same hybrid FTS5 + embedding search as `searchAtoms`, but returns per-result `{fts_score, cosine_score, hybrid_score}` plus an `embedding_available` flag for the recall tester; accepts an optional `config` override so the server's settings (not the developer's `~/.pi/agent/settings.json`) drive embedding search.
- `MemoryAtomType` union now includes `"bug"` as an 8th type alongside the documented 7 (production data contained 1 atom of this type).
- `QueryRewriteResult.fallback: boolean` — `true` when the rewrite degraded to `simpleKeywordExtraction` (LLM threw, returned empty, or returned unparseable JSON), `false` when a structured LLM response was parsed.

### Fixed

- `writeAtomToFile(atom, baseDir)` previously emitted a `tmp → rename` overwrite that could collide with another atom sharing the same slugified title, silently orphaning the older file. (Documented as v1 limitation R14; not fixed — needs ID-stamped paths.)
- Query rewriter now drops redundant keywords before they reach FTS5:
  - `dedupeRedundantKeywords`: drops any keyword that can be formed by concatenating a subsequence of the other keywords (catches the common LLM behavior of returning BOTH the broken-down tokens AND the original phrase as one of the keywords, e.g. `["PDF","图片","提取","图片提取"]` for query `pdf中图片提取`).
  - `dedupeAgainstQuery`: drops any keyword that equals the normalized user query (case-insensitive, whitespace-folded).
  Both helpers run inside `parseRewriteJson` / `rewriteQueryWithCallLlm` / `rewriteQuery` / `callOllamaRewrite` so every code path that hands a `QueryRewriteResult` to `searchAtoms` benefits.
- `searchAtomsWithScores.embedding_available` now reflects the **embedding service's reachability**, not whether FTS candidates happened to have stored embeddings. Previously it was `(embeddingResults.size > 0)`, which conflated two unrelated facts and caused the webui Search Tester to display "embedding unavailable" in the common case where the LLM returned empty keywords or the FTS `target_types` filter excluded the matching atom. Fixed by adding `isEmbeddingServiceAvailable(queryText, config)` (probes the embedding service for the query vector) and calling it at the top of `searchAtomsWithScores`, independent of the FTS path. `searchEmbeddings` now also returns `{ scores, serviceAvailable }` so the scoring layer can keep using per-atom cosine scores without re-probing.

### Tests

- `extensions/personal-assistant/test/memory-exports.test.ts` — 14 cases covering the 4 new helpers (with hermeticity test for `searchAtomsWithScores` that proves the new `config` parameter actually drives embedding selection, independent of `HOME` / `~/.pi/agent/settings.json`).
