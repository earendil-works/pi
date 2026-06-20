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

### Fixed
- Hash mismatch between DB content_fingerprint and file contentHash (both now use normalizeContent before sha256)
- Express route shadowing: /api/memory/stats, /search, /extract now register before /:id

### Removed
- searchByFts, rewriteQuery, simpleKeywordExtraction, dedupeRedundantKeywords, dedupeAgainstQuery, expandCjkKeywords, isEmbeddingServiceAvailable, searchEmbeddings, parseRewriteJson, getEmbedding, callOllamaRewrite, searchAtoms, searchAtomsWithScores
- Legacy sqlite.ts wrapper
