# Tasks: memory-hybrid-bm25-recall

> **Design:** design.md | **Base:** b589c1b17cf95b498528f8de9f0367465669b92f

**Goal:** Add FTS5 BM25 to `recallAtoms` and fuse with existing sqlite-vec dense KNN via RRF, with `rrfK` + `recallThreshold` configurable in `personalAssistant.memory.recall`.

**Architecture:** `MemoryIndex` adds `memory_fts` virtual table + `bm25Search` method, kept in sync with `memory_index` in the same transaction. `recallAtoms` runs dense top-20 + BM25 top-20 in parallel, fuses via RRF (`1/(rrfK + rank)`), filters by `recallThreshold`, takes fused top-9, applies per-type slice(≤3) + round-robin interleave. `RecallResult` gains `rrfScore` field; `score` (乘法 boost) preserved.

**Tech Stack:** better-sqlite3 12.11.1 (FTS5 builtin), sqlite-vec 0.1.9, vitest, TypeScript erasable syntax (Node strip-only).

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs that must complete first
  - **Task ID format:** `<section>.<task>[letter]` where letter is single lowercase char
- **`前置阅读`** = context only (not execution order; orthogonal to parallelism)
- All test commands use the in-repo vitest: `node ../../node_modules/vitest/dist/cli.js --run <test-path>` from `extensions/personal-assistant/`
- All tasks use TDD: write failing test → confirm FAIL → implement → confirm PASS → commit

## 1. Storage layer — FTS5 schema + sync

- [ ] 1.1 **Add `memory_fts` schema to MemoryIndex.init() (with idempotent backfill)**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: Add a CREATE-statement constant `MEMORY_FTS_SCHEMA` for `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, title, summary, content, tags, tokenize='unicode61 remove_diacritics 2', content='')`. In `init()`, after the existing CREATE INDEX statements, check whether `memory_fts` exists via `db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get()` — if absent, run the CREATE then execute `INSERT INTO memory_fts(id, title, summary, content, tags) SELECT id, title, summary, content, COALESCE(..., '') FROM memory_index WHERE archived = 0 AND is_latest = 1`. Wrap the backfill in a single `db.transaction(() => { ... })()`. Document the rationale (init-time idempotent, no separate migrate route).
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts` — new test `it("init builds memory_fts idempotently + backfills active atoms")` passes; running init twice does not duplicate rows.
  - **依赖**: 无
  - **前置阅读**: `extensions/personal-assistant/storage.ts:120-160` (init method), `:540-618` (SCHEMA constant block)

- [ ] 1.2 **Add `MemoryIndex.bm25Search` method**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: Add method `bm25Search(query: string, k: number, filter?: { type?: MemoryAtomType; archived?: boolean; isLatestOnly?: boolean }): Array<{ id: string; bm25: number }>`. SQL: `SELECT v.id, v.bm25(memory_fts) AS bm25 FROM memory_fts v INNER JOIN memory_index i ON v.id = i.id WHERE ${whereClauses.join(' AND ')} AND memory_fts MATCH ? ORDER BY bm25 LIMIT ?`. `whereClauses` mirrors `vectorSearch` (`archived = 0` default, `is_latest = 1` default, optional `type`). Escape user query via a helper `escapeFtsQuery(s: string): string` that wraps unescaped double quotes (`"` → `""`) and removes/parens/brackets that FTS5 parses specially (replace `'"', '(', ')', '*', ':'` with space to avoid syntax errors). Run escape on the query string before passing as the MATCH parameter.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts` — new test `it("bm25Search returns ranked hits for keyword query")` passes: insert 3 atoms with distinct tokens ("amplicon data", "rna virus", "lefse biomarker"), query "amplicon", expect the first atom at rank 1 with non-null bm25 score.
  - **依赖**: 1.1
  - **前置阅读**: `extensions/personal-assistant/storage.ts:244-274` (vectorSearch — mirror this method's shape), `:103-122` (MemoryIndex class header)

- [ ] 1.3 **Sync memory_fts on insertAtom (within transaction)**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: In `insertAtom(atom, embedding)` at line 125, the existing `this.db.transaction(() => { ... })()` already wraps the INSERT into `memory_index` and `memory_vectors` (lines 127-146). Add an INSERT into `memory_fts` inside the same transaction body, after the memory_vectors INSERT: `this.db.prepare(\`INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)\`).run(atom.id, atom.title, atom.summary, atom.content, atom.tags.join(' '));`. Note: `atom.tags` is `string[]` (see types.ts), so `join(' ')` produces space-separated tokens for FTS5; if `atom.tags` is empty, this is an empty string, which FTS5 handles fine.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts` — new test `it("insertAtom writes memory_fts row")` passes: after insert, `SELECT count(*) FROM memory_fts WHERE id = ?` returns 1.
  - **依赖**: 1.1

- [ ] 1.4 **Sync memory_fts on markArchived (delete FTS5 row)**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: In `markArchived(id)` at line 526, the existing `this.db.transaction(() => { ... })()` wraps the UPDATE on `memory_index` and the audit insert (lines 527-530). Note: this method does NOT currently delete the vector row — `deleteVector(id)` is a separate caller-driven step. Add `this.db.prepare(\`DELETE FROM memory_fts WHERE id = ?\`).run(id);` inside the same transaction body, after the existing UPDATE. The vector deletion path (caller invokes `deleteVector` separately) is unchanged — we do NOT couple FTS5 deletion to vector deletion because the vector delete is a GC decision, not an archive decision.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts` — new test `it("markArchived deletes memory_fts row")` passes: insert atom, markArchived(id), then `SELECT count(*) FROM memory_fts WHERE id = ?` returns 0.
  - **依赖**: 1.3

- [ ] 1.5 **Sync memory_fts on markSupersededTx (delete old + insert new)**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: In `markSupersededTx(oldId, newAtom, newEmbedding)` at line 346, the existing `this.db.transaction(() => { ... })()` (line 367) already wraps: UPDATE memory_index for old (is_latest=0), INSERT memory_index for new, INSERT memory_vectors for new, and the two audit inserts (lines 367-419). Add inside the same transaction body, after the memory_vectors INSERT and before the audit inserts: (a) `this.db.prepare(\`DELETE FROM memory_fts WHERE id = ?\`).run(oldId);` and (b) `this.db.prepare(\`INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)\`).run(transferredAtom.id, transferredAtom.title, transferredAtom.summary, transferredAtom.content, transferredAtom.tags.join(' '));`. Use `transferredAtom` (the merged new atom) for the FTS5 row content, NOT the raw `newAtom`, so the FTS5 row reflects the actual stored atom.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts` — new test `it("markSupersededTx swaps memory_fts row")` passes: after supersede, old id has 0 FTS5 rows, new id has 1 FTS5 row with the merged atom's content.
  - **依赖**: 1.3

## 2. RecallResult type — add rrfScore

- [ ] 2.1 **Add rrfScore field to RecallResult type**
  - **文件**: `extensions/personal-assistant/types.ts` (Modify)
  - **内容**: In the `RecallResult` interface, add `rrfScore: number;` after the existing `score: number;` field. Update the JSDoc above the interface to mention that `rrfScore` is the RRF fusion score (sum of `1/(rrfK + rank)` contributions from each channel that returned the atom), populated only when the recall used RRF fusion; for non-hybrid callers (rare; mostly tests) it equals the rank-weighted score.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/types.test.ts` — add `it("RecallResult has rrfScore field")` passing: build a minimal RecallResult literal with `rrfScore: 0.032`, assert the field is present and typed as number.
  - **依赖**: 无

## 3. Search layer — RRF fusion

- [ ] 3.1 **Add RRF helper function in search.ts**
  - **文件**: `extensions/personal-assistant/search.ts` (Modify)
  - **内容**: Add a pure helper `rrfFuse(denseRanks: Array<{id: string}>, bm25Ranks: Array<{id:string}>, rrfK: number): Array<{id: string; rrfScore: number}>` that returns atoms sorted by fused score descending. Algorithm: `const m = new Map<string, number>(); for (let rank = 0; rank < denseRanks.length; rank++) m.set(denseRanks[rank].id, (m.get(denseRanks[rank].id) ?? 0) + 1/(rrfK + rank + 1));` — mirror for bm25; then `return [...m.entries()].map(([id, rrfScore]) => ({id, rrfScore})).sort((a, b) => b.rrfScore - a.rrfScore);`. Export the function for testing.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` — new test `it("rrfFuse sums contributions from both channels")` passes: denseRanks=[{id:'a'},{id:'b'}], bm25Ranks=[{id:'b'},{id:'c'}], rrfK=60 → a=1/61, b=1/61+1/62, c=1/62; assert exact values within 1e-9.
  - **依赖**: 无

- [ ] 3.2 **Add bm25Search call + RRF fusion in recallAtoms**
  - **文件**: `extensions/personal-assistant/search.ts` (Modify)
  - **内容**: Rewrite `recallAtoms(index, query, options)` to: (a) call `embedText(query)`, return `[]` on null; (b) `Promise.all([densePromise, bm25Promise])` where densePromise = `index.vectorSearch(queryEmbedding, topK, {isLatestOnly:true, archived:false, type})` for each of the 3 types (per-type fan-out, but now topK=20 default not 3); bm25Promise = `index.bm25Search(query, topK, {isLatestOnly:true, archived:false, type})` per type; (c) for each type, fuse via `rrfFuse(denseHits, bm25Hits, rrfK)` and filter `rrfScore >= recallThreshold`; (d) sort fused per-type list by rrfScore desc, take top-3 (per-type cap unchanged); (e) collect into perTypeResults array of arrays; (f) round-robin interleave for `min(topK, 9)` iterations to produce final 9 results. For each result: `index.getAtom(id)` → fetch atom → `cosine = 1 - distance²/2` (keep this for backwards compat) → `score = cosine × (1 + 0.3 × strength + 0.2 × importance)` (keep) → `rrfScore = (fused map)[id]` (new). Update `DEFAULT_THRESHOLD` doc to note it's now `recallThreshold` default `1/rrfK = 0.01667`, and the old `threshold` option is renamed to a dense-channel cosine floor (default 0.65, kept for backwards compat but documented as "dense-only floor, not the recall gate").
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` — new test `it("recallAtoms fuses dense + BM25 via RRF")` passes: insert 3 atoms (one matched by both, one by dense only, one by BM25 only); query touches both channels; assert all 3 surface with rrfScore populated.
  - **依赖**: 1.2, 2.1, 3.1

- [ ] 3.3 **Add new RecallOptions fields (rrfK, recallThreshold)**
  - **文件**: `extensions/personal-assistant/search.ts` (Modify)
  - **内容**: Extend `RecallOptions` interface: add `rrfK?: number;` and `recallThreshold?: number;` after the existing `threshold?: number;`. Add constants `const DEFAULT_RRF_K = 60;` and `const DEFAULT_RECALL_THRESHOLD = 1 / DEFAULT_RRF_K;` (≈ 0.01667). In `recallAtoms`, resolve: `const rrfK = options.rrfK ?? DEFAULT_RRF_K;` and `const recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;`.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` — new test `it("RecallOptions accepts rrfK and recallThreshold")` passes: pass `{rrfK: 30, recallThreshold: 0.01}`, verify the values flow through (mock-friendly: insert 1 atom, check the rrfScore is calculated with rrfK=30 → 1/(30+1) = 0.0323).
  - **依赖**: 3.2

- [ ] 3.4 **Update RecallResult construction in search.ts to populate rrfScore**
  - **文件**: `extensions/personal-assistant/search.ts` (Modify)
  - **内容**: In the scored-result push, change `scored.push({ atom, distance, cosine, score });` to `scored.push({ atom, distance, cosine, score, rrfScore: ...rrfScore from fused map });`. Thread the fused rrf score map into the per-type inner loop closure.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` — new test `it("RecallResult.rrfScore is populated")` passes: results[0].rrfScore is a number > 0.
  - **依赖**: 3.3

## 4. Config wiring

- [ ] 4.1 **Add PersonalAssistantConfig.memory.recall block**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: Extend `PersonalAssistantConfig.memory` with `recall?: { rrfK?: number; recallThreshold?: number; };`. Add JSDoc explaining both fields, their defaults (60 and 1/rrfK), and that they're optional (config entirely optional, defaults in search.ts).
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/types.test.ts` — new test `it("PersonalAssistantConfig.memory.recall is optional")` passes: build a config literal with `recall: { rrfK: 30 }` and assert type compat.
  - **依赖**: 无

- [ ] 4.2 **Wire config.recall into before_agent_start recallAtoms call**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: In the `before_agent_start` hook (around the `recallAtoms(index, userMessage, { topK: 10 })` call), change to `recallAtoms(index, userMessage, { topK: 20, rrfK: config.memory?.recall?.rrfK, recallThreshold: config.memory?.recall?.recallThreshold })`. `topK: 20` matches the per-channel KNN candidate count from design.md Decision 2 (each of dense + BM25 returns up to 20 candidates per type, then RRF takes top-3 per type after fusion). Add a one-line comment explaining the wiring.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/before-agent-start.test.ts` — existing tests still pass (no behavior change assertion since recallAtoms is mocked).
  - **依赖**: 4.1, 3.3

## 5. Test updates — adjust existing tests for new threshold

- [ ] 5.1 **Update search.test.ts to use recallThreshold: 0 (skip RRF filter)**
  - **文件**: `extensions/personal-assistant/test/search.test.ts` (Modify)
  - **内容**: In each test that currently relies on the old `threshold` option (e.g., test (k) at line 351, test (n) at line 401), add `recallThreshold: 0` to the recallAtoms options. The `threshold: 0.65` dense floor can stay or be removed depending on what the test exercises — read each test's intent and adjust minimally. The goal: every existing search.test.ts test continues to PASS without changing the expected behavior.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts` — all 16 existing tests pass.
  - **依赖**: 3.3

- [ ] 5.2 **Update recall-quality.test.ts to use recallThreshold: 0**
  - **文件**: `extensions/personal-assistant/test/recall-quality.test.ts` (Modify)
  - **内容**: In the two `recallAtoms(index, q.query, { topK: 10, threshold: 0 })` calls (lines 240 and 264), add `recallThreshold: 0` and remove the deprecated `threshold: 0` (or keep both — `threshold: 0` is the dense floor and is also 0, so no conflict). Run the aggregate metrics test — assert avg_recall@5 ≥ 0.7 (may drop slightly from 1.0 due to RRF requiring more signals), avg_recall@10 ≥ 0.85, avg_precision@5 ≥ 0.4 (should IMPROVE because BM25 reduces noise). If any threshold fails, report the actual numbers in the verification output and let the user decide whether to accept.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/recall-quality.test.ts` — all 14 existing tests pass; aggregate metrics print clearly with the new precision number.
  - **依赖**: 3.3

## 6. New tests — hybrid recall coverage

- [ ] 6.1 **hybrid-recall.test.ts — RRF algorithm correctness**
  - **文件**: `extensions/personal-assistant/test/hybrid-recall.test.ts` (Create)
  - **内容**: Import `rrfFuse` from `../search.ts`. Tests: (a) `it("rrfFuse with no overlap")` — disjoint dense/bm25 ranks → each id gets one contribution only; (b) `it("rrfFuse with full overlap")` — same 5 ids in both → each gets 2 contributions; (c) `it("rrfFuse ranks by fused score descending")` — assert sort order; (d) `it("rrfFuse k=0 collapses to rank-weighted sum")` — boundary case; (e) `it("rrfFuse handles empty channels")` — both empty → returns `[]`; one empty → still works.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` — all 5 RRF tests pass.
  - **依赖**: 3.1

- [ ] 6.2 **hybrid-recall.test.ts — recallAtoms end-to-end hybrid scenarios**
  - **文件**: `extensions/personal-assistant/test/hybrid-recall.test.ts` (Modify — append to file from 6.1)
  - **内容**: Add end-to-end tests using `MemoryIndex(":memory:")` + mock embedder (charBag) + real FTS5. Tests: (a) `it("BM25-only hit recalled even when dense cosine below floor")` — insert atom "amplicon data backflow" with vector that has low cosine to query "amplicon data backflow"; assert atom surfaces via BM25 channel; (b) `it("dense-only hit recalled even when BM25 zero hits")` — query "qwertyuiop" (no atom matches lexically) against atoms with high cosine; assert surfaces; (c) `it("double-channel hit ranks above single-channel")` — insert 3 atoms; one matched both channels, one dense only, one BM25 only; assert both-channel atom first; (d) `it("recallThreshold filters low-fused-score atoms")` — set recallThreshold=0.5, verify low-confidence hits dropped; (e) `it("recallAtoms degrades gracefully when embedText returns null")` — mock embedText null; verify BM25 still surfaces relevant atoms; (f) `it("recallAtoms returns [] when both channels empty")` — empty index, query anything → `[]`; (g) `it("per-type round-robin after RRF fusion preserves type diversity")` — insert 5 rule + 5 fact, verify final list has both types interleaved.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` — all 7 end-to-end tests pass (total 12 in the file).
  - **依赖**: 3.3, 1.2

- [ ] 6.3 **hybrid-recall.test.ts — storage-level FTS5 sync**
  - **文件**: `extensions/personal-assistant/test/hybrid-recall.test.ts` (Modify — append to file from 6.2)
  - **内容**: Storage-level tests using `MemoryIndex`: (a) `it("init creates memory_fts table")`; (b) `it("init is idempotent — second init does not duplicate rows")`; (c) `it("init backfills active atoms on existing DB without memory_fts")` — manually create memory_index without memory_fts, then init; verify backfill; (d) `it("insertAtom writes matching memory_fts row")`; (e) `it("archiveAtom removes memory_fts row")`; (f) `it("supersedeAtom swaps memory_fts row")`; (g) `it("bm25Search escapes special chars in query")` — query with `"`, `(`, `*` characters; verify no SQL error.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` — all 7 storage tests pass (total 19 in the file).
  - **依赖**: 1.5

## 7. Verification

- [ ] 7.1 **Full test suite green**
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run` — all tests in the package pass (existing 85 + ~19 new = ~104 tests).
  - **依赖**: 1.5, 2.1, 3.4, 4.2, 5.2, 6.3

- [ ] 7.2 **npm run check clean**
  - **验证**: `cd /home/qjh/workspace/personal/pi && npm run check` — no new errors, warnings, or infos introduced by this change.
  - **依赖**: 7.1

- [ ] 7.3 **Smoke test: real DB migration**
  - **验证**: Manual / scripted — back up `/home/qjh/.pi/agent/memory/memory.db` to `/tmp/memory.db.bak`, then start a pi session that triggers `MemoryIndex.init()`. Confirm: (a) DB file unchanged size +/- small growth for new table; (b) `sqlite3 ~/.pi/agent/memory/memory.db "SELECT count(*) FROM memory_fts"` returns the active atom count; (c) `recallAtoms` against a known keyword returns the right atom. Restore backup after.
  - **依赖**: 1.5

- [ ] 7.4 **Lefse regression — user's reported case**
  - **验证**: Scripted test — with the user's actual 8-atom corpus, call `recallAtoms(index, "这个先不管,这个项目路径下lefse没有结果,你看下正常吗", {rrfK:60, recallThreshold:1/60})`. Assert: returned atoms do NOT include any of the 2 `X101SC26052587-Z01-J002` customer-data atoms (they should be filtered because BM25 has zero hit + dense cosine 0.55 < fused threshold). This is the user-reported recall failure that motivated this change.
  - **依赖**: 7.1