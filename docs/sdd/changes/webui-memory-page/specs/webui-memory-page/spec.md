# webui-memory-page Specification

## ADDED Requirements

### Requirement: Webui Server List Memory Atoms
The webui server SHALL expose `GET /api/memory` that returns a JSON array of `MemoryAtom` objects. The server SHALL support query parameters `archived` (values: `"active"` default, `"archived"`, `"all"`), `type` (comma-separated multi-select), `tag` (single), `q` (free-text matching against `title` and `summary`), `limit` (default 200, max 1000), and `offset`. The server SHALL read atoms from `MemoryIndex.getAllAtoms()` and apply filters in this order: archived → type → tag → q → sort by `updated_at` desc → limit/offset. The response SHALL NOT include `.md` file body content (only DB-row metadata). When the DB file does not exist, the server SHALL initialize a fresh DB and return an empty array.

#### Scenario: List all active atoms by default
- **GIVEN** `~/.pi/agent/data/memory.db` contains 12 atoms with `archived = 0` spanning 7 types
- **WHEN** `GET /api/memory` is called with no query parameters
- **THEN** the response is a JSON array of 12 atoms, all with `archived: false`, sorted by `updated_at` descending

#### Scenario: List filters by archived mode
- **GIVEN** the DB contains 3 archived atoms and 9 active atoms
- **WHEN** `GET /api/memory?archived=archived` is called
- **THEN** the response contains exactly the 3 archived atoms
- **WHEN** `GET /api/memory?archived=all` is called
- **THEN** the response contains all 12 atoms

#### Scenario: List filters by type and tag and q
- **GIVEN** the DB contains a mix of 7 types, some atoms have tag `"rust"`, some titles contain `"font"`
- **WHEN** `GET /api/memory?type=preference,workflow&tag=rust&q=font` is called
- **THEN** the response contains only atoms whose `type` is `preference` OR `workflow`, AND `tags` includes `"rust"`, AND `title` or `summary` matches `"font"`

#### Scenario: List returns empty array on fresh DB
- **GIVEN** `~/.pi/agent/data/memory.db` does not exist
- **WHEN** `GET /api/memory` is called
- **THEN** the server initializes a fresh DB and returns `[]` with HTTP 200

#### Scenario: List returns empty array on existing DB with zero atoms
- **GIVEN** the DB exists but `memory_index` has 0 rows
- **WHEN** `GET /api/memory` is called
- **THEN** the response is `[]` with HTTP 200

### Requirement: Webui Server Get Memory Atom Detail
The webui server SHALL expose `GET /api/memory/:id` that returns a single `MemoryAtom` JSON object including the `content` field read from the `.md` file. When the atom has a `file_path`, the server SHALL call `readAtomFromFile(file_path, content_hash)`. If the file is missing OR `readAtomFromFile` throws a hash-mismatch error, the server SHALL set `content: ""` and still return HTTP 200 (so the UI can render a `<memory-error>` placeholder). If the atom id does not exist, the server SHALL return HTTP 404 with `{ "error": "not found" }`.

#### Scenario: Get atom reads content from .md file
- **GIVEN** atom id `X` exists in DB with `file_path` and `content_hash` matching the on-disk file
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response includes `content` field with the file body (trimmed)

#### Scenario: Get atom returns 404 for missing id
- **GIVEN** atom id `X` does not exist
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response is HTTP 404 with `{ "error": "not found" }`

#### Scenario: Get atom returns empty content when .md file is missing
- **GIVEN** atom id `X` has `file_path = P` but the file `P` has been deleted externally
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response is HTTP 200 with `content: ""` and no error

#### Scenario: Get atom returns empty content when .md hash mismatches
- **GIVEN** atom id `X` has `content_hash = H1` but the file at `file_path` was externally edited and now hashes to `H2`
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response is HTTP 200 with `content: ""` and no error

### Requirement: Webui Server Patch Memory Atom
The webui server SHALL expose `PATCH /api/memory/:id` that accepts a JSON body of `Partial<MemoryAtom>` and updates the atom. The server SHALL: (1) load the existing atom via `getAtom(id)` — 404 if missing; (2) read the current body from the `.md` file via `readAtomFromFile(file_path, content_hash)`, falling back to `""` on file-missing or hash-mismatch; (3) merge `req.body` over the existing atom, using `req.body.content ?? currentBody` for the content field, bumping `version` by 1 and setting `updated_at` to now; (4) call `writeAtomToFile(merged, deps.atomsDir)` and adopt its returned `filePath` and `contentHash`; (5) `unlink` the old file if its `file_path` differs from the new one; (6) call `idx.upsertAtom(merged)`; (7) call `idx.invalidateEmbedding(merged.id)`. The response SHALL be the updated atom JSON.

#### Scenario: Patch metadata field bumps version and updates file
- **GIVEN** atom `X` exists with `title = "old"`, `version = 3`
- **WHEN** `PATCH /api/memory/X` with `{ "title": "new" }` is called
- **THEN** the response atom has `title = "new"`, `version = 4`, `updated_at` set to now, `content_hash` updated, `file_path` updated to reflect the new slug

#### Scenario: Patch metadata preserves file body bytes
- **GIVEN** atom `X` exists with on-disk body of 5KB markdown
- **WHEN** `PATCH /api/memory/X` with `{ "title": "new title" }` (no `content` field) is called
- **THEN** the new `.md` file body bytes are identical to the old body bytes; only the frontmatter lines changed (new `title`, `version`, `updated_at`)

#### Scenario: Patch body rewrites .md file with new hash
- **GIVEN** atom `X` has `content_hash = H1` and `file_path = P1`
- **WHEN** `PATCH /api/memory/X` with `{ "content": "new body" }` is called
- **THEN** a new file is written at `P2 = atomsDir/<type>/<slug>.md`; the old `P1` is unlinked; DB `content_hash = H2`, `file_path = P2`, `version+1`, `updated_at = now`; the `memory_embeddings` row for id `X` is deleted

#### Scenario: Patch with empty content string
- **GIVEN** atom `X` exists with non-empty body
- **WHEN** `PATCH /api/memory/X` with `{ "content": "" }` is called
- **THEN** the file is rewritten; the new file body is empty (or fallback to `summary` if `summary` is non-empty per `writeAtomToFile` body logic)

#### Scenario: Patch with empty tags array
- **GIVEN** atom `X` exists with `tags = ["foo", "bar"]`
- **WHEN** `PATCH /api/memory/X` with `{ "tags": [] }` is called
- **THEN** the DB row's `tags` JSON column is `[]` and the file's frontmatter reflects this

#### Scenario: Patch importance at boundary values
- **GIVEN** atom `X` exists
- **WHEN** `PATCH /api/memory/X` with `{ "importance": 0 }` or `{ "importance": 1 }` is called
- **THEN** the server accepts the value and persists; subsequent `runDecay` calls use `λ = baseDecay * (1 - importance)` so importance=1 means λ=0 (no decay)

#### Scenario: Patch type changes file_path directory
- **GIVEN** atom `X` has `type = "preference"`, `file_path = atomsDir/preference/foo.md`
- **WHEN** `PATCH /api/memory/X` with `{ "type": "constraint" }` is called
- **THEN** the new file is written to `atomsDir/constraint/foo.md`; the old `preference/foo.md` is unlinked; the new `file_path` reflects the new directory

#### Scenario: Patch returns 404 for missing id
- **GIVEN** atom id `X` does not exist
- **WHEN** `PATCH /api/memory/X` is called
- **THEN** the response is HTTP 404 with `{ "error": "not found" }`

### Requirement: Webui Server Archive Memory Atom
The webui server SHALL expose `POST /api/memory/:id/archive` that accepts `{ "archived": boolean }` and toggles the atom's archived state. When `archived: true`, the server SHALL call `idx.markArchived(id)`. When `archived: false`, the server SHALL call `idx.upsertAtom({ ...atom, archived: false, version: atom.version + 1, updated_at: now })`. The response SHALL be `{ "ok": true, "atom": <updated atom> }` with HTTP 200, or HTTP 404 if the id does not exist.

#### Scenario: Archive active atom
- **GIVEN** atom `X` exists with `archived = false`
- **WHEN** `POST /api/memory/X/archive` with `{ "archived": true }` is called
- **THEN** the response is HTTP 200 with `ok: true` and the returned atom has `archived: true`; subsequent `GET /api/memory?archived=active` does not include `X`

#### Scenario: Restore archived atom
- **GIVEN** atom `X` exists with `archived = true`, `version = 5`
- **WHEN** `POST /api/memory/X/archive` with `{ "archived": false }` is called
- **THEN** the response is HTTP 200 with `ok: true` and the returned atom has `archived: false`, `version = 6`, `updated_at = now`

### Requirement: Webui Server Memory Search (Real Pipeline)
The webui server SHALL expose `POST /api/memory/search` that accepts `{ "query": string, "topK"?: number }` and returns `{ "rewritten": QueryRewriteResult, "embedding_available": boolean, "results": Array<{ atom: MemoryAtom, fts_score: number, cosine_score: number, hybrid_score: number }> }`. The server SHALL call `rewriteQueryWithCallLlm(deps.callLlm, query, deps.settings)` to produce the rewritten query. If that call throws, the server SHALL fall back to `simpleKeywordExtraction(query)` and continue. The server SHALL then call `searchAtomsWithScores(idx, rewritten, topK ?? 10)` and return its result. The `embedding_available` field SHALL be `false` when the search used the pure-FTS branch (Ollama not running or `embedding.provider !== "local"`).

#### Scenario: Search returns results with score breakdown
- **GIVEN** the DB contains 3 atoms matching the query "字体"
- **WHEN** `POST /api/memory/search` with `{ "query": "用户偏好什么字体" }` is called and Ollama is available
- **THEN** the response includes `rewritten.keywords` and `rewritten.target_types`; `embedding_available: true`; `results` is a non-empty array where each result has `atom`, `fts_score`, `cosine_score`, `hybrid_score` fields

#### Scenario: Search falls back to simpleKeywordExtraction when LLM fails
- **GIVEN** `deps.callLlm` is configured to throw an error
- **WHEN** `POST /api/memory/search` is called
- **THEN** the response is HTTP 200 with `rewritten.keywords` populated from `simpleKeywordExtraction`; results are still returned (possibly empty)

#### Scenario: Search uses pure FTS when embedding unavailable
- **GIVEN** Ollama is not running (or `embedding.provider` is not `"local"`)
- **WHEN** `POST /api/memory/search` is called
- **THEN** the response has `embedding_available: false`; `cosine_score` on all results is `0`; FTS-only hybrid score is used

#### Scenario: Search on empty DB
- **GIVEN** the DB has 0 atoms
- **WHEN** `POST /api/memory/search` is called
- **THEN** the response has `results: []`, `embedding_available: false` (no candidates), HTTP 200

### Requirement: Webui Server Memory Stats
The webui server SHALL expose `GET /api/memory/stats` that returns `{ "total": number, "archived": number, "byType": Record<MemoryAtomType, number> }` aggregating over `getAllAtoms(idx)`. `byType` SHALL include all 7 atom types (entries with count 0 may be omitted).

#### Scenario: Stats on empty DB
- **GIVEN** the DB has 0 atoms
- **WHEN** `GET /api/memory/stats` is called
- **THEN** the response is `{ "total": 0, "archived": 0, "byType": {} }`

#### Scenario: Stats with mixed types and archived
- **GIVEN** the DB has 5 atoms: 2 `preference`, 1 `workflow`, 1 `knowledge`, 1 archived `event`
- **WHEN** `GET /api/memory/stats` is called
- **THEN** the response is `{ "total": 5, "archived": 1, "byType": { "preference": 2, "workflow": 1, "knowledge": 1, "event": 1 } }`

### Requirement: Personal-Assistant Public MemoryIndex API
The `extensions/personal-assistant/memory.ts` module SHALL export `class MemoryIndex`, `interface MemoryAtom`, `type MemoryAtomType`, `function writeAtomToFile(atom, baseDir?)`, `function readAtomFromFile(filePath, expectedHash?)`, `function searchAtoms(index, query, topK)`, `function rewriteQuery(query, ctx, config)`, `const ATOMS_DIR`, and `const MEMORY_DB_PATH` as public symbols. The `extensions/personal-assistant/index.ts` module SHALL re-export all of these so they are accessible via `@earendil-works/pi-personal-assistant`.

#### Scenario: Webui server can import MemoryIndex via the package alias
- **GIVEN** the webui server is configured with `paths` mapping `@earendil-works/pi-personal-assistant` to `extensions/personal-assistant/index.ts`
- **WHEN** a server file does `import { MemoryIndex, MemoryAtom } from "@earendil-works/pi-personal-assistant"`
- **THEN** TypeScript compiles without error and the symbols resolve to the extension's implementation

### Requirement: Personal-Assistant Server-Friendly Memory Helpers
The `extensions/personal-assistant/memory.ts` module SHALL export the following server-friendly helpers: `function getAllAtoms(index: MemoryIndex): MemoryAtom[]` returning all atoms including archived; `function rewriteQueryWithCallLlm(callLlm: (prompt: string) => Promise<string>, query: string, config: PersonalAssistantConfig): Promise<QueryRewriteResult>` that uses the `callLlm` callback instead of `ctx.modelRegistry` and falls back to `simpleKeywordExtraction` on failure; `function searchAtomsWithScores(index, query, topK): Promise<{ results: Array<{ atom, fts_score, cosine_score, hybrid_score }>, embedding_available: boolean }>` that returns the score breakdown for the recall test panel.

#### Scenario: getAllAtoms includes archived atoms
- **GIVEN** the DB has 3 active atoms and 2 archived atoms
- **WHEN** `getAllAtoms(idx)` is called
- **THEN** it returns all 5 atoms (no archived filter)

#### Scenario: rewriteQueryWithCallLlm uses the provided callback
- **GIVEN** `callLlm` is a mock that returns `'{"keywords":["x"],"target_types":["preference"]}'`
- **WHEN** `rewriteQueryWithCallLlm(callLlm, "query", config)` is called
- **THEN** `callLlm` is invoked exactly once with the rewrite prompt; the function returns `{ keywords: ["x"], target_types: ["preference"], raw_query: "query" }`

#### Scenario: rewriteQueryWithCallLlm falls back on LLM error
- **GIVEN** `callLlm` rejects with an error
- **WHEN** `rewriteQueryWithCallLlm(callLlm, "hello world", config)` is called
- **THEN** the function returns the result of `simpleKeywordExtraction("hello world")` and does not throw

#### Scenario: searchAtomsWithScores returns breakdown with embedding
- **GIVEN** the DB has 3 atoms matching the query keywords, and Ollama is running
- **WHEN** `searchAtomsWithScores(idx, rewrittenQuery, 10)` is called
- **THEN** the result includes `embedding_available: true`; each result has `fts_score`, `cosine_score`, and `hybrid_score` numbers

#### Scenario: searchAtomsWithScores returns pure FTS breakdown when no embedding
- **GIVEN** Ollama is not running
- **WHEN** `searchAtomsWithScores(idx, rewrittenQuery, 10)` is called
- **THEN** the result has `embedding_available: false`; each result has `cosine_score: 0` and `hybrid_score` computed from FTS only

### Requirement: MemoryIndex invalidateEmbedding Method
The `MemoryIndex` class SHALL expose a public method `invalidateEmbedding(id: string): void` that executes `DELETE FROM memory_embeddings WHERE id = ?`. This avoids exposing the private `db` field to external callers.

#### Scenario: invalidateEmbedding removes the embedding row
- **GIVEN** the DB has an embedding row for atom `X` in `memory_embeddings`
- **WHEN** `idx.invalidateEmbedding("X")` is called
- **THEN** the row is removed from `memory_embeddings`; subsequent `getEmbedding("X")` returns `null`

### Requirement: Webui Client Auto-Save with Flush on Route Change
The webui client SHALL provide a `useAutoSave<T>(value: T, save: (v: T) => Promise<void>, delay?: number)` React hook (default delay 3000ms) that debounces calls to `save` until `value` has been stable for `delay` milliseconds. The hook SHALL expose a `state` field with values `idle | dirty | saving | saved | error`. On component unmount, the hook SHALL cancel any pending `setTimeout` and flush any pending save with a 200ms best-effort timeout. If `save` rejects, the hook SHALL transition to `error` state and retry once after another `delay` (no infinite retries).

#### Scenario: Debounce triggers save after 3s idle
- **GIVEN** a detail view is mounted with `useAutoSave({ title: "old" }, save)`
- **WHEN** the user changes the title to `"new"` and 3 seconds elapse without further changes
- **THEN** `save({ title: "new" })` is called exactly once

#### Scenario: Route change flushes pending save
- **GIVEN** the user has changed a field 1s ago (within the debounce window) and a pending `setTimeout` exists
- **WHEN** the user navigates away from `/memory` (component unmounts)
- **THEN** the pending `setTimeout` is cleared and the in-flight save is awaited with a 200ms best-effort timeout; if it succeeds the data is persisted before navigation completes

#### Scenario: Route quick toggle does not block
- **GIVEN** the user enters `/memory` and immediately clicks back to chat (no edit made)
- **WHEN** unmount happens
- **THEN** cleanup detects no pending save and no in-flight fetch; the route change completes immediately

#### Scenario: Save failure triggers one retry
- **GIVEN** the first PATCH attempt fails (network error or 5xx)
- **WHEN** the failure is observed
- **THEN** `state` becomes `error`; a second PATCH is attempted after `delay`; if the second attempt also fails the hook stops retrying and stays in `error` state

### Requirement: Webui Client Memory Page
The webui client SHALL provide a `MemoryPage` React component at route `/memory` that displays a 3-pane layout: a left-side `MemoryList` (with type/tag/archived/q filters and a Refresh button), a right-side `MemoryDetail` (with `MemoryEditor` for metadata + body), and a collapsible `MemorySearchTester` panel at the bottom. The list and detail SHALL auto-refresh every 3 seconds via polling. The list SHALL include a stats badge in the header showing `total / byType` from `GET /api/memory/stats`. The page SHALL be reachable from a new Memory icon in the `AppShell` sidebar.

#### Scenario: Memory page route loads with empty state
- **GIVEN** the DB has 0 atoms
- **WHEN** the user navigates to `/memory`
- **THEN** the page renders the 3-pane layout with the list showing "No memories yet" and the detail showing an empty state

#### Scenario: Memory page lists atoms with type filter
- **GIVEN** the DB has 10 atoms across multiple types
- **WHEN** the user selects the `preference` type filter chip
- **THEN** the list re-renders showing only atoms whose `type === "preference"`

#### Scenario: Memory page shows stats badge
- **GIVEN** the DB has 12 atoms (2 preference, 3 workflow, 7 knowledge)
- **WHEN** the memory page loads
- **THEN** the header shows a stats badge with "12 total · 2 pref · 3 wf · 7 kn"

#### Scenario: Sidebar Memory icon navigates to /memory
- **GIVEN** the user is on `/sessions/<id>` (chat)
- **WHEN** the user clicks the Memory icon in the sidebar IconRow
- **THEN** the route changes to `/memory` and `MemoryPage` renders

### Requirement: Webui Client Memory Detail and Editor
The `MemoryPage` SHALL provide a `MemoryDetail` component that loads the selected atom via `GET /api/memory/:id` and renders it via `MemoryEditor`. The `MemoryEditor` SHALL provide form controls for `title` (text), `type` (select), `importance` (slider 0-1 step 0.05), `tags` (chip input), `summary` (textarea), and `content` (textarea + Markdown preview tab). All field changes SHALL be funneled into a `Partial<MemoryAtom>` patch and passed to `useAutoSave` for 3s debounced PATCH submission. The detail header SHALL display read-only metadata (`strength`, `access_count`, `created_at`, `updated_at`, `last_access`, `file_path`) and the auto-save state badge.

#### Scenario: Click list item opens detail
- **GIVEN** the user is on `/memory` and the list shows 5 atoms
- **WHEN** the user clicks the first atom
- **THEN** the right pane loads the detail: `MemoryEditor` shows the title, type, importance, tags, summary, and content from `GET /api/memory/:id`

#### Scenario: Edit title auto-saves after 3s
- **GIVEN** detail for atom `X` is loaded
- **WHEN** the user changes the title to `"new title"` and stops typing for 3s
- **THEN** `PATCH /api/memory/X` with `{ title: "new title" }` is called; the header state badge transitions `dirty → saving → saved`; the list row reflects the new title

#### Scenario: Edit body auto-saves and triggers .md rewrite
- **GIVEN** detail for atom `X` is loaded with body 5KB
- **WHEN** the user changes the body content and stops typing for 3s
- **THEN** `PATCH /api/memory/X` with `{ content: "..." }` is called; the header shows `saved`; the underlying `.md` file at `atomsDir/<type>/<slug>.md` is rewritten with new hash

#### Scenario: Body editor with very long content
- **GIVEN** atom body is 50KB markdown
- **WHEN** detail loads
- **THEN** the body editor renders a textarea at 60vh with internal scroll; the preview tab uses the existing `Markdown` component to render the full content

### Requirement: Webui Client Memory Search Tester Panel
The `MemoryPage` SHALL include a collapsible `MemorySearchTester` panel at the bottom that allows the user to enter a free-text query and POST it to `/api/memory/search`. The panel SHALL display the `rewritten.keywords` as chips, the `rewritten.target_types` as chips, an `embedding_available` indicator (gray "embedding unavailable" badge when false), and the result list with each row showing the atom's title and a hover tooltip revealing `{ fts_score, cosine_score, hybrid_score, strength, importance }`. Clicking a result SHALL select that atom in the detail pane.

#### Scenario: Search tester submits real query
- **GIVEN** the user expands the search tester panel
- **WHEN** the user types "用户偏好什么字体" and clicks Search
- **THEN** `POST /api/memory/search` with `{ query: "用户偏好什么字体" }` is called; keywords and target_types chips render; results render as a list

#### Scenario: Search tester shows score breakdown on hover
- **GIVEN** search returns 3 results
- **WHEN** the user hovers over a result
- **THEN** a tooltip shows `fts: 0.80 · cos: 0.60 · hybrid: 0.71 · str: 0.90 · imp: 0.70`

#### Scenario: Search tester shows embedding unavailable
- **GIVEN** Ollama is not running
- **WHEN** the user runs a search
- **THEN** the panel shows a gray "embedding unavailable" badge; `cosine_score: 0` is displayed in result tooltips

#### Scenario: Search tester LLM rewrite fallback notice
- **GIVEN** `deps.callLlm` fails (5xx or timeout)
- **WHEN** the user runs a search
- **THEN** the panel renders successfully with `simpleKeywordExtraction` keywords; a small note "using keyword fallback (no LLM rewrite)" appears above the results

### Requirement: Personal-Assistant Slugify Collision Known Bug (Documented)
The `writeAtomToFile` function in `extensions/personal-assistant/memory.ts` SHALL use `join(atomsDir, atom.type, slugify(atom.title) + ".md")` as the file path, with no id-based suffix. Two atoms with the same title SHALL therefore map to the same file path; the later write SHALL overwrite the earlier one. This is a known bug; v1 SHALL NOT fix it. The webui client SHALL tolerate this by displaying `<memory-error>` when `readAtomFromFile` fails on the affected atom (via the empty-`content` behavior already specified in `Webui Server Get Memory Atom Detail`).

#### Scenario: Two atoms with identical title overwrite each other
- **GIVEN** atom A and atom B both have `title = "用 Rust 重写"` and are persisted
- **WHEN** either atom is read back via `GET /api/memory/:id`
- **THEN** the response has `content: ""` if the file's hash does not match the row's `content_hash` (because the file was last written by the other atom); the UI shows a `<memory-error>` placeholder

#### Scenario: Slug collision behavior is documented
- **GIVEN** the v1 implementation is shipped
- **WHEN** a user inspects the code or reads the design doc
- **THEN** `docs/sdd/changes/webui-memory-page/design.md` and the `Risks / Trade-offs` table document the slugify-collision behavior and note that the fix is deferred to v2

## MODIFIED Requirements

(none)

## REMOVED Requirements

(none)

## RENAMED Requirements

(none)
