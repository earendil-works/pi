# memory-search-decoupled Specification

## ADDED Requirements

### Requirement: memory_get tool
The agent MUST expose a `memory_get` tool that, given an atom id, returns the full atom content and records the call as a strength-feedback signal.

#### Scenario: fetch full content by id
- **GIVEN** an atom exists in the DB with id=`X`, type=`rule`, title=`T`, summary=`S`, content=`C`
- **WHEN** the agent invokes `memory_get({ id: "X" })`
- **THEN** the tool returns `{ content: [{ type: "text", text: "T\nS\nC" }], details: { id: "X", type: "rule", title: "T", content: "C", summary: "S", tags, importance } }`
- **AND THEN** the atom's `access_count` is incremented by 1
- **AND THEN** the atom's `last_access` is set to the current ms epoch

#### Scenario: not found
- **GIVEN** no atom exists with id=`missing`
- **WHEN** the agent invokes `memory_get({ id: "missing" })`
- **THEN** the tool returns `{ content: [{ type: "text", text: "atom not found: missing" }], details: { error: "not_found", id: "missing" } }`
- **AND THEN** no row is modified

#### Scenario: tool registration contract
- **GIVEN** the `personal-assistant` extension is loaded
- **WHEN** `registerMemory(pi)` is called
- **THEN** `pi.registerTool` is invoked exactly once for the `memory_get` tool
- **AND THEN** the tool's `parameters` schema is a `Type.Object` requiring `id: string`

### Requirement: user_tone hint in extraction prompt
The extraction LLM prompt MUST carry a `<user_tone>` segment when the user's message text exhibits strong / habit / weak / rare tone signals, so the LLM can calibrate `importance` accordingly.

#### Scenario: STRONG tone signals
- **GIVEN** messages contain tokens "千万" or "务必" or "必须" or "must" or "always"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>strong</user_tone>`
- **AND THEN** it contains `<importance_hint>0.85</importance_hint>`

#### Scenario: HABIT tone signals
- **GIVEN** messages contain tokens "总是" or "永远" or "习惯" or "usually"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>habit</user_tone>`
- **AND THEN** it contains `<importance_hint>0.65</importance_hint>`

#### Scenario: WEAK tone signals
- **GIVEN** messages contain tokens "可能" or "也许" or "如果" or "maybe" or "could"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>weak</user_tone>`
- **AND THEN** it contains `<importance_hint>0.35</importance_hint>`

#### Scenario: RARE tone signals
- **GIVEN** messages contain tokens "偶尔" or "有时" or "sometimes" or "rarely"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>rare</user_tone>`
- **AND THEN** it contains `<importance_hint>0.2</importance_hint>`

#### Scenario: NEUTRAL tone omits hint
- **GIVEN** messages contain none of the strong / habit / weak / rare tokens
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt does NOT contain `<user_tone>` or `<importance_hint>` segments

#### Scenario: EXTRACT_PROMPT_V2 documents the hint
- **GIVEN** `EXTRACT_PROMPT_V2` is the system-prompt text sent to the extraction LLM
- **THEN** it contains a paragraph instructing the LLM to use `<user_tone>` + `<importance_hint>` as a hint to calibrate importance, with explicit permission to deviate ±0.15 from the hint

### Requirement: weighted score formula for search ranking
Search MUST rank recall results within each type by `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`. Cosine is the multiplicative anchor; strength/importance contribute a continuous boost on every comparison (never only on strict equality).

#### Scenario: zero cosine gives zero score
- **GIVEN** an atom with `cosine = 0` (completely unrelated)
- **WHEN** its score is computed
- **THEN** `score = 0 × (1 + 0.3 × strength + 0.2 × importance) = 0`
- **AND THEN** the atom cannot rank above any non-zero-cosine competitor regardless of strength/importance

#### Scenario: full cosine gives max boost
- **GIVEN** an atom with `cosine = 1`, `strength = 1`, `importance = 1`
- **WHEN** its score is computed
- **THEN** `score = 1.0 × 1.5 = 1.5`

#### Scenario: cosine dominates boost
- **GIVEN** atom X with `cosine = 0.6, strength = 1.0, importance = 1.0` (score = 0.9)
- **AND GIVEN** atom Y with `cosine = 0.85, strength = 0.0, importance = 0.0` (score = 0.85)
- **WHEN** compared
- **THEN** X ranks above Y because the 0.5 max boost from strength/importance cannot overcome the 0.25 cosine gap when cosine ≥ 0.667× the loser's cosine

#### Scenario: within-type sort uses score DESC
- **GIVEN** rule type has 3 atoms with cosine/strength/importance triples giving scores 1.05 / 0.8925 / 0.876
- **WHEN** `recallAtoms` ranks the rule slice
- **THEN** the returned order is [1.05, 0.8925, 0.876]

### Requirement: per-type top-3 recall
`recallAtoms` MUST run three independent KNN searches (one per atom type) and return at most 3 results per type, interleaved round-robin.

#### Scenario: all 3 types have ≥3 atoms
- **GIVEN** DB contains 4 rule + 4 fact + 4 process atoms, all matching the query above cosine threshold
- **WHEN** `recallAtoms(index, query, atomsDir)` is called
- **THEN** 9 results are returned
- **AND THEN** result indices [0, 3, 6] are rule, [1, 4, 7] are fact, [2, 5, 8] are process (round-robin interleaving)

#### Scenario: sparse type slot is skipped
- **GIVEN** DB contains 1 rule + 0 fact + 2 process atoms matching the query
- **WHEN** `recallAtoms(index, query, atomsDir)` is called
- **THEN** 3 results are returned: `[rule@0, process@0, process@1]` — the fact slot is skipped, not padded with other types

#### Scenario: sub-threshold atoms are dropped
- **GIVEN** some rule-type candidates have `cosine < 0.5`
- **WHEN** `recallAtoms` returns
- **THEN** those candidates do not appear in results
- **AND THEN** the rule slice has at most `min(3, post-filter count)` entries

### Requirement: search does not mutate access state
`recallAtoms` MUST NOT call `updateAccess` for any returned atom. Strength-feedback is recorded exclusively by the agent's `memory_get` tool and the webui `GET /api/memory/:id` preview endpoint.

#### Scenario: search leaves access_count at 0
- **GIVEN** an atom exists with `access_count = 0`
- **WHEN** `recallAtoms(index, query, atomsDir)` returns that atom
- **THEN** the atom's `access_count` remains 0 after the call
- **AND THEN** the atom's `last_access` remains null

#### Scenario: only memory_get bumps access_count
- **GIVEN** an atom exists with `access_count = 0`
- **WHEN** `recallAtoms` returns it (no bump)
- **AND THEN** the `memory_get` tool is invoked with the atom's id
- **THEN** `access_count` becomes 1 and `last_access` is set

### Requirement: formatMemoryBlock emits id, not file_path
`formatMemoryBlock` MUST emit an `id:` line carrying the atom's UUID and MUST NOT emit a `file:` line. The LLM uses the id to call `memory_get` when full content is needed.

#### Scenario: id line present, file line absent
- **GIVEN** an atom with id=`abc-123`, type=`rule`, title=`T`, summary=`S`, tags=[`x`]
- **WHEN** `formatMemoryBlock(result)` is called
- **THEN** the block contains `id: abc-123`
- **AND THEN** the block does NOT contain `file:`

#### Scenario: formatMemoryContext re-sorts by cosine
- **GIVEN** two results: A with `score = 1.5, cosine = 0.7`, B with `score = 0.7, cosine = 0.95`
- **WHEN** `formatMemoryContext([A, B], 4000)` is called
- **THEN** B appears before A in the output text — sorting is by distance ASC (cosine DESC), NOT by score DESC
- **NOTE**: score is metadata for the search response / debug UI only. The LLM never sees it; it sees cosine-ordered blocks regardless.

## MODIFIED Requirements

### Requirement: RecallResult shape
The `RecallResult` type MUST include a `score: number` field and MUST NOT include a `file_path` field.

#### Scenario: type contract
- **GIVEN** a `RecallResult` is constructed from a search hit
- **THEN** `result.score` is a non-negative number
- **AND THEN** `result.file_path` is not present in the shape

### Requirement: webui `GET /api/memory/:id` is preview-only
The `GET /api/memory/:id` route MUST return the atom + content for UI display but MUST NOT call `index.updateAccess(id)`. Strength feedback is recorded exclusively by the agent's `memory_get` tool.

#### Scenario: GET does not bump
- **GIVEN** an atom with `access_count = 0` and `last_access = null`
- **WHEN** the webui `GET /api/memory/:id` endpoint is called
- **THEN** the response body contains the atom and content
- **AND THEN** `getAtom(id).access_count === 0` after the call
- **AND THEN** `getAtom(id).last_access === null` after the call

### Requirement: webui search response shape
The webui `POST /api/memory/search` response MUST include `score` in each result and MUST NOT include `file_path`.

#### Scenario: response shape
- **GIVEN** search returns 3 hits
- **WHEN** the response body is serialized
- **THEN** each result has `{ id, type, title, summary, tags, distance, cosine, score }`
- **AND THEN** `file_path` is not present

## REMOVED Requirements

### Requirement: search-bumps-access-count
- **Reason**: Search is discovery-only. Strength feedback must be intentional (the agent's `memory_get` call) to avoid spurious bumps from routine recall.
- **Migration**: Atom strength still reflects prior access history until the atom is updated by `memory_get`. New feedback loop requires the agent to call `memory_get` after search.

### Requirement: search-returns-file-path
- **Reason**: file_path leaks storage layout to the LLM and creates a dependency on the `read` tool. Replacing with `id` keeps the LLM aware of the abstraction and routes full-content access through `memory_get`, where strength feedback lives.
- **Migration**: Clients that previously read `file_path` from the search response must instead call `memory_get(id)` to retrieve full content.

### Requirement: file-in-format-block
- **Reason**: Same as above — `formatMemoryBlock` previously emitted `file: <path>` which mirrored the old `read` tool flow.
- **Migration**: `formatMemoryBlock` now emits `id: <uuid>`. The LLM uses `memory_get` to resolve the id.

## RENAMED Requirements

(none)