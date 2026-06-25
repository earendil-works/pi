# memory-search-decoupled Specification

## ADDED Requirements

### Requirement: hybrid retrieval via FTS5 BM25 + dense KNN, fused by RRF
`recallAtoms` SHALL execute dense (sqlite-vec KNN) and BM25 (sqlite FTS5) channels in parallel, fuse their per-rank contributions via Reciprocal Rank Fusion (RRF), and apply a configurable recall threshold before per-type round-robin interleaving.

#### Scenario: BM25 single-channel hit is recalled even when dense cosine is below floor
- **GIVEN** the DB contains an atom whose title / summary / content contains the query tokens verbatim (e.g., title="X101SC26052587-Z01-J002 客户数据未回传", query="X101SC26052587 数据回传")
- **AND** the atom's dense cosine against the query is below the dense floor (e.g., 0.50 < 0.65)
- **WHEN** `recallAtoms(index, query, { rrfK: 60, recallThreshold: 1/60 })` is called
- **THEN** the BM25 channel returns the atom at rank ≤ 5
- **AND** the dense channel does NOT return the atom (cosine < floor)
- **AND** the RRF fused score ≥ `recallThreshold` (because BM25 contributes `1/(60+rank)`)
- **AND** the atom appears in the final result list

#### Scenario: dense single-channel hit is recalled even when BM25 has zero hits
- **GIVEN** the DB contains atoms with high dense cosine to the query
- **AND** the query contains no tokens that overlap any atom's FTS5 index (e.g., query="qwertyuiop")
- **WHEN** `recallAtoms(index, "qwertyuiop", { rrfK: 60, recallThreshold: 1/60 })` is called
- **THEN** the BM25 channel returns `[]`
- **AND** the dense channel returns the atoms with high cosine
- **AND** atoms with cosine ≥ floor contribute `1/(60+rank)` from the dense channel
- **AND** at least one atom with cosine ≥ 0.80 surfaces in the final list

#### Scenario: double-channel hit ranks above single-channel hits
- **GIVEN** atom A matches both dense (cosine=0.78) and BM25 (rank=1)
- **AND** atom B matches only dense (cosine=0.85)
- **AND** atom C matches only BM25 (rank=2)
- **WHEN** `recallAtoms` is called with a query that hits all three
- **THEN** A's rrfScore = `1/(60+0) + 1/(60+0)` ≈ 0.0333
- **AND** B's rrfScore = `1/(60+0)` ≈ 0.0167
- **AND** C's rrfScore = `1/(60+1)` ≈ 0.0164
- **AND** A appears first in the final result list, B second, C third

#### Scenario: single channel rank=1 alone does NOT exceed default recallThreshold
- **GIVEN** the default `recallThreshold = 1/60 ≈ 0.0167`
- **AND** `rrfK = 60`
- **WHEN** an atom is matched by only one channel at rank=1
- **THEN** the contribution is `1/(60+1)` ≈ 0.01639
- **AND** `0.01639 < 0.01667`, so the atom's fused rrfScore < threshold
- **AND** the atom is filtered out (or it must have a second signal from the other channel to qualify)
- **NOTE**: this is the design choice that solves the dense-noise problem — a single dense cosine (no BM25 support) cannot pass

### Requirement: FTS5 schema and storage sync
`MemoryIndex` SHALL maintain a `memory_fts` virtual table (FTS5 with unicode61 tokenizer, fields `id UNINDEXED, title, summary, content, tags`) and keep its rows synchronized with `memory_index` in the same transaction as the corresponding write.

#### Scenario: init creates memory_fts idempotently
- **GIVEN** a fresh DB (no `memory_fts` table)
- **WHEN** `MemoryIndex.init()` is called
- **THEN** `CREATE VIRTUAL TABLE memory_fts USING fts5(...)` is executed
- **AND** all active atoms (`archived = 0 AND is_latest = 1`) are inserted into `memory_fts`
- **WHEN** `init()` is called again
- **THEN** no duplicate rows are created (idempotent)

#### Scenario: init backfills memory_fts from existing memory_index
- **GIVEN** an existing DB with 8 active atoms and no `memory_fts` table
- **WHEN** `MemoryIndex.init()` is called for the first time after this change
- **THEN** `memory_fts` is created
- **AND** all 8 active atoms appear in `memory_fts` immediately after init returns

#### Scenario: insertAtom writes a matching memory_fts row
- **GIVEN** a `MemoryAtom` with title, summary, content, tags
- **WHEN** `index.insertAtom(atom, embedding)` is called
- **THEN** `memory_index` and `memory_vectors` are updated as before
- **AND** `memory_fts` gains a row with the same `id` and the four indexed fields
- **AND** all three writes happen in a single transaction (atomicity)

#### Scenario: archiveAtom removes the memory_fts row
- **GIVEN** an atom with id=X exists in `memory_fts`
- **WHEN** the atom is archived (`archived = 1`)
- **THEN** the `memory_fts` row with id=X is deleted in the same transaction
- **AND** subsequent `bm25Search` queries do not return X

#### Scenario: supersedeAtom swaps the memory_fts row
- **GIVEN** atom A is superseded by atom B
- **WHEN** the supersede transaction commits
- **THEN** `memory_fts` row for A is deleted
- **AND** `memory_fts` row for B is inserted with B's title/summary/content/tags

### Requirement: bm25Search escapes FTS5 special characters
`MemoryIndex.bm25Search` SHALL escape double quotes, parens, asterisks, and colons in the user-provided query string before passing it as the `MATCH` parameter, so that queries containing FTS5 syntax characters do not raise SQL parse errors.

#### Scenario: query with FTS5 special characters is sanitised
- **GIVEN** a user query `lefse "没有" 结果` containing `"`, `(`, `)`, `*`, `:`, `[`, `]` characters
- **WHEN** `bm25Search(query, 10, ...)` is called
- **THEN** the internal `MATCH` parameter has each special character replaced with a space (e.g., `lefse  没有  结果`); no doubling or escaping of `"` is performed
- **AND** no SQL error is raised
- **AND** atoms matching the literal phrase are returned
- **AND** a query consisting entirely of special characters short-circuits to `[]` rather than running `MATCH ''`

### Requirement: rrfK and recallThreshold are configurable
The recall configuration MUST be readable from `~/.pi/agent/settings.json` under `personalAssistant.memory.recall.{rrfK, recallThreshold}`, and MUST fall back to defaults (`rrfK = 60`, `recallThreshold = 1/60`) when the block is absent.

#### Scenario: config block missing → defaults used
- **GIVEN** `~/.pi/agent/settings.json` does not contain `personalAssistant.memory.recall`
- **WHEN** `MemoryIndex` loads config and `recallAtoms` is called
- **THEN** `rrfK = 60` and `recallThreshold = 1/60` are used (defaults from `search.ts`)
- **AND** behavior matches the documented default scenario

#### Scenario: user tightens recallThreshold
- **GIVEN** `personalAssistant.memory.recall.recallThreshold = 0.05` in settings.json
- **WHEN** `recallAtoms` is called
- **THEN** only atoms with fused rrfScore ≥ 0.05 are returned
- **AND** single-channel rank=1 contributions (≈ 0.0167) are insufficient — must have either dense + BM25 both rank=1, or single channel at rank=1 + other channel rank≤1

#### Scenario: user loosens recallThreshold to 0
- **GIVEN** `personalAssistant.memory.recall.recallThreshold = 0`
- **WHEN** `recallAtoms` is called
- **THEN** RRF score filter is bypassed
- **AND** fused top-9 is returned regardless of score
- **NOTE**: this is the mode used by hermetic tests (search.test.ts, recall-quality.test.ts) to assert pure ranking without threshold filtering

### Requirement: RecallResult carries rrfScore alongside score
`RecallResult` SHALL include an `rrfScore: number` field representing the fused RRF contribution sum. The existing `score` field (multiplicative boost) MUST be preserved for backwards compatibility with the webui and memory_get consumers.

#### Scenario: rrfScore is populated by hybrid recall
- **GIVEN** a hybrid recall returns an atom
- **WHEN** the caller inspects `result.rrfScore`
- **THEN** the field is a number ≥ 0
- **AND** equals the sum of `1/(rrfK + rank)` across all channels that returned the atom

#### Scenario: existing score field preserved
- **GIVEN** a hybrid recall returns an atom with strength=0.7, importance=0.8, cosine=0.78
- **WHEN** the caller inspects `result.score`
- **THEN** `score = 0.78 × (1 + 0.3×0.7 + 0.2×0.8)` ≈ 1.222 (unchanged from prior contract)

#### Scenario: formatMemoryBlock does not expose rrfScore
- **GIVEN** a `RecallResult` with `rrfScore = 0.032`
- **WHEN** `formatMemoryBlock(result)` is called
- **THEN** the rendered block contains `[type] title\nsummary\nid: ...\nTags: ...`
- **AND** the block does NOT contain any rrfScore or score field (LLM does not need to see internal scoring)

## MODIFIED Requirements

### Requirement: recallAtoms returns top-K results sorted by RRF fused score, with per-type round-robin interleaving
`recallAtoms` SHALL return at most 9 results per call. For each of the three atom types (rule / fact / process), it SHALL independently execute dense KNN (sqlite-vec, top-K candidates per type) and BM25 (`memory_fts`, top-K candidates per type), fuse the two channels per-type via RRF with smoothing constant `rrfK`, filter by `recallThreshold`, take the top 3 by fused score per type (sparse types degrade), then interleave the per-type lists via round-robin into a single result list. The fused score is `Σ 1/(rrfK + rank + 1)` summed across channels.

(Replaces the prior per-type top-3 dense-only algorithm.)

#### Scenario: per-type cap of 3 holds after RRF fusion
- **GIVEN** 5 rule atoms, 5 fact atoms, 5 process atoms all match the query
- **WHEN** `recallAtoms(index, query, { rrfK: 60, recallThreshold: 0 })` is called
- **THEN** at most 3 rule + 3 fact + 3 process = 9 results are returned
- **AND** the order is round-robin interleaved: `[rule[0], fact[0], process[0], rule[1], fact[1], process[1], rule[2], fact[2], process[2]]`
- **AND** sparse type slots are skipped (not padded with cross-type atoms)

#### Scenario: dense null collapses to pure BM25 (graceful degradation)
- **GIVEN** `embedText(query)` returns null (ollama down)
- **WHEN** `recallAtoms` is called
- **THEN** the dense channel returns `[]`
- **AND** the BM25 channel runs normally
- **AND** the fused result contains only BM25-derived hits
- **AND** no error is raised

#### Scenario: empty query returns empty result
- **GIVEN** user prompt is empty string `""`
- **WHEN** `recallAtoms(index, "")` is called
- **THEN** the result list is `[]`
- **NOTE**: `memory.ts` before_agent_start already short-circuits on empty prompt; this is defense in depth

### Requirement: threshold is now recallThreshold on RRF score, not cosine
The recall gate is now a single fused RRF score threshold (`recallThreshold`), not a per-item cosine threshold. The default `recallThreshold` equals `1/rrfK` (e.g., 1/60 ≈ 0.01667), which forces at least two channels to contribute OR a single channel at rank=1 with strong secondary contribution. A separate `threshold` option (cosine floor) remains available but is documented as a dense-channel filter, not the recall gate.

(Replaces the prior `DEFAULT_THRESHOLD = 0.65` cosine gate.)

#### Scenario: default threshold rejects single-channel dense noise
- **GIVEN** atom X has dense cosine 0.55 to query Q
- **AND** no atom in the DB contains any token of Q (BM25 returns empty)
- **WHEN** `recallAtoms(index, Q)` is called with default config
- **THEN** X's RRF contribution from dense rank=1 is `1/(60+1)` ≈ 0.01639
- **AND** BM25 contributes 0
- **AND** X's fused rrfScore = 0.01639 < default `recallThreshold` = 1/60 ≈ 0.01667
- **AND** X is filtered out (correctly identified as noise)

#### Scenario: lifting threshold to allow single-channel recall
- **GIVEN** user sets `recallThreshold = 0.01` (looser)
- **WHEN** `recallAtoms` is called
- **THEN** single-channel rank=1 contribution (≈ 0.0167) > 0.01 passes
- **NOTE**: trade-off — looser threshold accepts more single-channel hits, including potential dense noise

## REMOVED Requirements

### Requirement: hardcoded DEFAULT_THRESHOLD = 0.5 (or 0.65 after 2026-06-24) cosine gate
- **Reason**: Pure cosine threshold is replaced by RRF fused score threshold; the hardcoded value is moved to `recallThreshold` config field with default `1/rrfK`. The dense cosine floor remains available as a separate `threshold` option for backwards compat but is no longer the recall gate.
- **Migration**: Existing call sites that pass `{ threshold: 0.5 }` continue to work (dense floor), but to control the recall gate they should pass `recallThreshold` instead. No code change required at call sites that use defaults — recall just behaves better out of the box.

## RENAMED Requirements

(none)