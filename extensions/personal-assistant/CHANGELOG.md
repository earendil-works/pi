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
- New `memory_get` tool — sole programmatic strength-feedback entry. Bumps `access_count` and `last_access` on successful lookup.
- New `scoreUserTone` 5-tier user-tone scorer (STRONG/HABIT/WEAK/RARE/NEUTRAL) + `<user_tone>` hint injection in `buildExtractionPrompt`. Extraction LLM uses it to calibrate importance (±0.15 deviation allowed).
- TUI footer status indicator for memory recall. The `before_agent_start` hook now surfaces the most recent recall result via `ctx.ui.setStatus("memory", …)` so the user sees `"📦 N atoms · rule=X fact=Y process=Z · top=0.XXX"` (hits), `"🔍 no memory match"` (empty), or `"⚠ memory recall failed"` (error) below the mode chip. Status reflects the most recent recall; older states are not retained.

### Changed
- memory.ts reduced from 1649 → 290 lines (v2 is entry-point-only)
- All v1 search/extract/decay logic moved to specialized modules (storage, search, format, extraction, decay)
- Schema: new tables (memory_index, memory_vectors vec0 FLOAT[1024], memory_audit) with 5 indexes
- Embedding: full text (title+summary+content+tags) instead of title-only
- Search is discovery-only: `recallAtoms` returns summary + `id` for every result (no L0/L1 tier hydration). The agent calls `memory_get(id)` to fetch full content — that call is the sole programmatic strength-feedback signal.
- Search response now returns `score` instead of `file_path`. Score = cosine × (1 + 0.3 × strength + 0.2 × importance), per-type top-3 with round-robin interleaving. `formatMemoryContext` re-sorts by `distance` ASC (cosine DESC) before injecting into LLM prompt — `score` is metadata, not visible to the LLM. Extraction prompt now accepts `<user_tone>` hint to calibrate importance.
- Webui `GET /api/memory/:id` is preview-only — does NOT bump `access_count`. Strength feedback is recorded exclusively by the agent's `memory_get` tool.

### Fixed
- Hash mismatch between DB content_fingerprint and file contentHash (both now use normalizeContent before sha256)
- Express route shadowing: /api/memory/stats, /search, /extract now register before /:id
- **`session_before_compact` extraction wired up**: the hook previously read `event.messages` (a non-existent field) and used a hardcoded `callLlm` stub returning `'{"items":[]}'`, so compact fired the hook but never produced atoms. The handler now reads `event.preparation.messagesToSummarize`, calls `completeSimple` with the session's `ctx.model`, and resolves the API key via `getEnvApiKey` (env first) then `ctx.modelRegistry.getApiKeyForProvider` (auth-storage fallback). Compact now grows memory automatically on every summary — no more manual `POST /api/memory/extract` workaround.
- **Memory directory self-heals on missing parent**: `MemoryIndex` constructor now runs `mkdirSync(dirname(dbPath), { recursive: true })` before opening the better-sqlite3 handle. better-sqlite3 itself refuses to create parent dirs — without this, deleting `~/.pi/agent/memory/` (or installing onto a fresh machine) made every compact / session_start / before_agent_start fail with SQLITE_CANTOPEN. The runtime's `extensionRunner.emit()` caught the throw and logged it via the extension error channel, so compact completed but extraction silently no-op'd. Now extraction self-heals and the next compact recreates the directory.
- **Compact extraction is now config-driven**: previously the session_before_compact hook used `ctx.model` (the session's main model) for the extraction LLM call. That was wrong — settings.json has its own `personalAssistant.memory.extraction.{provider,model}` setting (e.g. `minimax/MiniMax-M3`) which lets users run a cheap local model for extraction while keeping a strong cloud model for the agent loop. The hook now reads `loadConfig()`, looks up the configured model via `ctx.modelRegistry.find()`, and resolves auth via `ctx.modelRegistry.getApiKeyAndHeaders()` (the same path pi's own agent loop uses). If the config is missing, the model is not in the registry, or auth fails, the hook surfaces the error via `ctx.ui.notify(message, "error")` BEFORE compact proceeds — the user sees the configuration problem in the TUI and can fix it before the next `/compact`, instead of compact silently completing with no memory written.

### Removed
- searchByFts, rewriteQuery, simpleKeywordExtraction, dedupeRedundantKeywords, dedupeAgainstQuery, expandCjkKeywords, isEmbeddingServiceAvailable, searchEmbeddings, parseRewriteJson, getEmbedding, callOllamaRewrite, searchAtoms, searchAtomsWithScores
- Legacy sqlite.ts wrapper
- `file_path` from search response and `formatMemoryBlock` output. Replaced with `id` for `memory_get` lookup.

### Known Limitations
- **TUI memory status indicator**: the `ctx.ui.setStatus` API for footer status has existed since `7b902612 feat(coding-agent): add FooterDataProvider for git branch and extension statuses`, but neither v1 nor v2 memory ever called it. Recall results were only ever injected into the LLM prompt — invisible to the user. Now fixed via the `before_agent_start` hook firing `setStatus("memory", …)` on every turn.

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
