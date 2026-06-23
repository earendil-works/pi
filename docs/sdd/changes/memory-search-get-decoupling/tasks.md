# Tasks: memory-search-get-decoupling

> **Design:** design.md | **Base:** 58d95354

**Goal:** Decouple `search` (discovery) from `get` (full content) by removing `access_count` bumps from search, adding an explicit `memory_get` tool, exposing a per-type top-3 weighted score formula, and letting extraction LLM use the user's tone as a hint to calibrate `importance`.

**Architecture:** Three layered changes —
1. **Type + shape layer**: `RecallResult` swaps `file_path` → `score`; format block emits `id:` instead of `file:`; webui `GET /:id` becomes preview-only (no bump).
2. **Algorithm layer**: `recallAtoms` runs 3 independent per-type vector searches (top-3 each, sparse types skip), interleaves them via round-robin, sorts within each type by `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`. `updateAccess` is removed from search. `formatMemoryContext` still re-sorts by cosine before injecting into prompt.
3. **Tool layer**: `registerMemory` adds `pi.registerTool({ name: "memory_get", parameters: { id }, execute } })` — sole programmatic strength-feedback entry. Bumps `access_count` + `last_access` only.
4. **Prompt layer**: extraction computes `scoreUserTone(messages)` (5-tier, bilingual word list) and prepends `<user_tone>level</user_tone>` + `<importance_hint>hint</importance_hint>` to `buildExtractionPrompt` (omitted for NEUTRAL). LLM uses it as a hint when picking `importance` (±0.15).

`runDecay` is untouched — baseDecay=0.05, archiveThreshold=0.1, rule-never-archive all preserved. The new score formula naturally makes strength decay visible in search ranking.

**Tech Stack:** better-sqlite3 + sqlite-vec (existing), zod (existing), `@earendil-works/pi-ai` `Type` (existing), `@earendil-works/pi-coding-agent` `ExtensionAPI`/`ContextEvent` (existing), `@earendil-works/pi-agent-core` `AgentToolResult` (existing).

## Notes

- **`依赖`** = execution order. Format: `<section>.<task>`.
- **Task ID format**: `1.1`, `1.10`, etc. Single lowercase letter suffix allowed (`10.1b`).
- **TDD**: each task = one coherent unit. Within a task: RED test → confirm fail → GREEN impl → confirm pass → commit.
- **Inline parens** in `依赖` are stripped by the parser.

## 1. Types + score field

- [ ] 1.1 **`RecallResult` swaps `file_path` → `score`**
  - **文件**: `extensions/personal-assistant/types.ts` (Modify)
  - **内容**: In `RecallResult` interface, remove `file_path: string` field, add `score: number` field with JSDoc explaining the multiplicative formula and that it is exposed only to search response / debug UI, NOT to LLM prompt (format layer re-sorts by distance before injection).
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/types.test.ts`
  - **依赖**: 无

- [ ] 1.2 **types test updates for new shape**
  - **文件**: `extensions/personal-assistant/test/types.test.ts` (Modify)
  - **内容**: Rewrite the `RecallResult` shape test: assert presence of `score: number`, absence of `file_path`. Use the formula `cosine × (1 + 0.3 × strength + 0.2 × importance)` to verify the example: cosine=0.7, strength=1.0, importance=1.0 ⇒ score=1.05.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/types.test.ts`
  - **依赖**: 1.1

## 2. Search algorithm — per-type top-3 + score formula

- [ ] 2.1 **Add per-type top-3 recall with score formula (search.ts)**
  - **文件**: `extensions/personal-assistant/search.ts` (Modify)
  - **内容**: Rewrite `recallAtoms` to: (a) embed query via `embedText` (collapse to `[]` on null per Decision 7), (b) call `index.vectorSearch(embedding, 3, { type: "rule", isLatestOnly: true, archived: false })` × 3 in parallel via `Promise.all`, (c) for each returned `{id, distance}` fetch atom via `index.getAtom`, drop if missing, (d) compute `cosine = 1 - distance²/2` and `score = cosine × (1 + 0.3 × atom.strength + 0.2 × atom.importance)`, drop if `cosine < 0.5` threshold, (e) collect per-type arrays of ≤3, sort each by score DESC, (f) round-robin interleave into final list (skip sparse type slot), (g) return. **Remove `index.updateAccess(id)` call entirely.** Add `DEFAULT_TOP_K = 3` per-type constant. Drop `file_path` from the result construction. Update file-header JSDoc to reflect new contract.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/search.test.ts`
  - **依赖**: 1.1

- [ ] 2.2 **search test rewrite for per-type + score formula**
  - **文件**: `extensions/personal-assistant/test/search.test.ts` (Modify)
  - **内容**: Rewrite the test suite. Coverage: (a) ollama null → `[]` (kept), (b) per-type cap: 4 rule + 4 fact + 4 process → at most 9 results total (3 per type), (c) sparse type: 1 rule + 0 fact + 2 process → results = [rule@0, process@0, process@1] (round-robin, sparse skipped), (d) score formula: insert 3 atoms with controlled strength/importance and verify ordering within type, (e) cosine=0 atom dropped (boundary), (f) `score` field present, `file_path` absent, (g) **`updateAccess` NOT called**: search returns and `getAtom(id).access_count` remains 0, (h) `is_latest=0` excluded, (i) `archived=1` excluded.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/search.test.ts`
  - **依赖**: 2.1

## 3. Format — id block, no path

- [ ] 3.1 **`formatMemoryBlock` emits `id:` line instead of `file:`**
  - **文件**: `extensions/personal-assistant/format.ts` (Modify)
  - **内容**: In `formatMemoryBlock`, drop the `file: <file_path>` line, add `id: <atom.id>` line. Update file-header JSDoc to describe the LLM flow: search returns id, LLM calls `memory_get(id)` to fetch full content. Also update `formatMemoryContext` JSDoc to clarify it re-sorts by distance ASC (not score) before injection — score is metadata.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/format.test.ts`
  - **依赖**: 2.1

- [ ] 3.2 **format test updates**
  - **文件**: `extensions/personal-assistant/test/format.test.ts` (Modify)
  - **内容**: Update the two existing assertions: replace `expect(block).toContain("/tmp/atoms/rule/test.md")` with `expect(block).toContain(\`id: ${atom.id}\`)`. Replace the regex `^file: ...$` with `^id: ...$`. Update the sample helper to remove `file_path: "/tmp/..."` and add `score: 1.0` to the RecallResult factory. Add a new test: `formatMemoryContext` re-sorts by distance ASC, not score DESC — pass two results with high score / far distance and low score / close distance, assert the close-distance one appears first in the output text.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/format.test.ts`
  - **依赖**: 3.1

## 4. Tone scoring + prompt injection

- [ ] 4.1 **Add `scoreUserTone` + integrate into `buildExtractionPrompt`**
  - **文件**: `extensions/personal-assistant/extraction.ts` (Modify)
  - **内容**: (a) Export `scoreUserTone(messages: Array<{role: string; content: string}>): { level: "strong" | "habit" | "neutral" | "weak" | "rare", importanceHint: number }`. Word lists (bilingual, case-insensitive substring match): STRONG `["千万", "务必", "必须", "一定要", "must", "always", "never", "绝对", "禁止"]`, HABIT `["总是", "永远", "记得", "每次", "习惯", "usually", "often", "always do"]`, WEAK `["可能", "也许", "大概", "如果", "maybe", "perhaps", "might", "could"]`, RARE `["偶尔", "有时", "sometimes", "rarely"]`. Score = max tier hit; NEUTRAL if no hit. `importanceHint` mapping: STRONG=0.85, HABIT=0.65, NEUTRAL=0.5, WEAK=0.35, RARE=0.2. (b) Export `buildExtractionPrompt` (currently private) — change `function` → `export function` so tests can directly inspect the prompt. (c) Prepend `<user_tone>${level}</user_tone>\n<importance_hint>${importanceHint}</importance_hint>\n\n` when tone is not NEUTRAL; for NEUTRAL omit the hint block entirely. (d) Add a new paragraph in `EXTRACT_PROMPT_V2` describing the hint: "如果用户消息携带 `<user_tone>` 和 `<importance_hint>` 段,这表示用户语气的强度暗示。LLM 应基于此**调整 importance**,但仍可上下浮动 ±0.15 — 这是 hint,不是 hardcode。" Place it right after the existing Importance section.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/extraction-prompt.test.ts`
  - **依赖**: 无

- [ ] 4.2 **tone scoring tests**
  - **文件**: `extensions/personal-assistant/test/extraction-prompt.test.ts` (Modify)
  - **内容**: Add a new `describe("scoreUserTone")` block with 6 cases: (a) "千万记得每次 commit 前跑 check" → STRONG (0.85), (b) "我总是 9 点起床" → HABIT (0.65), (c) "也许可以试试 bge-m3" → WEAK (0.35), (d) "如果今天有空就帮我看下 bug" → WEAK (0.35) — "如果" hits, (e) "今天天气不错" → NEUTRAL (level === "neutral"), (f) "我有时候会看看文档" → RARE (0.2), "有时" hits. Also add a `describe("buildExtractionPrompt tone injection")` block: (a) NEUTRAL messages: prompt does NOT contain `<user_tone>`, (b) STRONG messages: prompt contains `<user_tone>strong</user_tone>` AND `<importance_hint>0.85</importance_hint>`, (c) HABIT messages: prompt contains `<user_tone>habit</user_tone>` AND `<importance_hint>0.65</importance_hint>`, (d) WEAK messages: prompt contains `<user_tone>weak</user_tone>` AND `<importance_hint>0.35</importance_hint>`, (e) RARE messages: prompt contains `<user_tone>rare</user_tone>` AND `<importance_hint>0.2</importance_hint>`, (f) EXTRACT_PROMPT_V2 still contains the new importance hint paragraph.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/extraction-prompt.test.ts`
  - **依赖**: 4.1

- [ ] 4.3 **update index.ts exports**
  - **文件**: `extensions/personal-assistant/index.ts` (Modify)
  - **内容**: Re-export `scoreUserTone` (function) and `buildExtractionPrompt` (function) from `./extraction.ts` alongside the existing `runMemoryExtraction, extractionPlanSchema, EXTRACT_PROMPT_V2, parseExtractionJson, executePlan`.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/index-exports.test.ts`
  - **依赖**: 4.1

- [ ] 4.4 **index exports test update**
  - **文件**: `extensions/personal-assistant/test/index-exports.test.ts` (Modify)
  - **内容**: Add two assertions: `expect(typeof mod.scoreUserTone).toBe("function")` and `expect(typeof mod.buildExtractionPrompt).toBe("function")`.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/index-exports.test.ts`
  - **依赖**: 4.3

## 5. `memory_get` tool registration

- [ ] 5.1 **Define `MemoryGetParams` + register `memory_get` tool**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: (a) Add `import { Type } from "@earendil-works/pi-ai"` and `import type { AgentToolResult } from "@earendil-works/pi-agent-core"`. (b) Add `const MemoryGetParams = Type.Object({ id: Type.String({ description: "Atom UUID from a search result" }) })`. (c) At the bottom of `registerMemory(pi)`, call `pi.registerTool({ name: "memory_get", label: "Memory Get", description: "Fetch the full content of an atom by id. Use this to hydrate a search result before acting on it. Bumps the atom's access_count so the strength-feedback loop keeps it visible.", promptSnippet: "Fetch full content of a memory atom.", parameters: MemoryGetParams, async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<{ id: string; type: string; title: string; content: string; summary: string; tags: string[]; importance: number }>> { /* … */ } })`. The execute body: open MemoryIndex, `index.getAtom(params.id)`, return 404-shaped `{ content: [{ type: "text", text: "atom not found: <id>" }], details: { error: "not_found", id } }` when null. Otherwise call `index.updateAccess(params.id)` (the ONLY programmatic feedback entry), return `{ content: [{ type: "text", text: "title\nsummary\ncontent" }], details: { id, type, title, content, summary, tags, importance } }`. close index in `finally`. Add file-header comment explaining this is the only programmatic get.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/memory-tool.test.ts`
  - **依赖**: 无

- [ ] 5.2 **`memory_get` tool test**
  - **文件**: `extensions/personal-assistant/test/memory-tool.test.ts` (Create)
  - **内容**: New file. Mock embed.ts at module level (char-bag, same as search.test.ts). Use the pattern from `cron.test.ts` / `ask-user-question.test.ts`: create a fake `pi = { registerTool: vi.fn(), on: vi.fn() }`, call `registerMemory(pi)`, assert `pi.registerTool` was called with an entry whose `name === "memory_get"`. Then invoke the registered `execute` directly. Cases: (a) valid id returns full content via details, text contains title+summary+content, (b) `access_count` is bumped by 1 after valid call, (c) `last_access` is updated to a recent timestamp, (d) invalid id returns `error: "not_found"` text and details.error === "not_found", (e) `MemoryGetParams` schema rejects missing `id` (use `TypeCompiler` or just JSON.stringify and check by attempt). The valid-call case must also verify the result shape: `{ content: [{ type: "text", text: string }], details: { id, type, title, content, summary, tags, importance } }`.
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run test/memory-tool.test.ts`
  - **依赖**: 5.1

## 6. Webui route — search response + GET /:id no-bump

- [ ] 6.1 **search route returns `score`, no `file_path`**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: In `registerPostSearch`, change the response mapping: drop `file_path: r.file_path`, add `score: r.score`. Update the JSDoc to describe the new shape: `{ id, type, title, summary, tags, distance, cosine, score }`. score is a debug/UI-only metadata field.
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/server && ../../../../node_modules/.bin/vitest --run test/memory-routes.test.ts`
  - **依赖**: 2.1

- [ ] 6.2 **GET /:id preview-only — does not bump access_count**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: In `registerGetMemoryById`, after `index.getAtom(req.params.id)` resolves the atom, do NOT call `index.updateAccess(...)`. Currently the route does not bump (verify in code review — it doesn't, but if a previous change added it, remove it). Update the JSDoc to make the preview-only contract explicit: "This endpoint is a UI preview only — reading an atom via the webui does NOT count toward the strength-feedback loop. Strength feedback is recorded exclusively by the agent's `memory_get` tool."
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/server && ../../../../node_modules/.bin/vitest --run test/memory-routes.test.ts`
  - **依赖**: 无

- [ ] 6.3 **webui search test updates**
  - **文件**: `packages/webui/server/test/memory-routes.test.ts` (Modify)
  - **内容**: In the "returns results with file_path for valid query" test, replace `expect(typeof first.file_path).toBe("string")` and `expect(fp.startsWith(path.join(atomsDir, first.type as string))).toBe(true)` with `expect(typeof first.score).toBe("number")` and `expect(first.score as number).toBeGreaterThanOrEqual(0)`. Assert `first.file_path` is `undefined`.
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/server && ../../../../node_modules/.bin/vitest --run test/memory-routes.test.ts`
  - **依赖**: 6.1

- [ ] 6.4 **GET /:id no-bump regression test**
  - **文件**: `packages/webui/server/test/memory-routes.test.ts` (Modify)
  - **内容**: Add a new `it("does not bump access_count on GET preview")` to the `GET /api/memory/:id` describe block. Insert atom via `insertTestAtom` helper, GET the atom via the route, then re-open the index and assert `getAtom(id).access_count === 0` and `last_access === null`.
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/server && ../../../../node_modules/.bin/vitest --run test/memory-routes.test.ts`
  - **依赖**: 6.2

## 7. Webui frontend — types + SearchTester

- [ ] 7.1 **api.ts type update**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Modify)
  - **内容**: Update the search-related types. The existing `MemoryAtomWithScores` and `MemorySearchResult` are the legacy FTS shape from webui-memory-page (already deleted in `search?*` overwrite?). Verify: if `MemorySearchResult` is referenced only by deleted `MemorySearchTester.tsx`, remove it. The new `MemorySearchTester.tsx` (already has shape `SearchResult = { id, type, title, summary, tags, file_path, distance, cosine }`). Update that shape: remove `file_path`, add `score: number`. The api.ts `search` method itself returns `unknown` (already typed loosely), so no change there.
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/web && ./node_modules/.bin/vitest --run src/lib/api.test.ts`
  - **依赖**: 6.1

- [ ] 7.2 **MemorySearchTester uses `score` not `file_path`**
  - **文件**: `packages/webui/web/src/components/memory/MemorySearchTester.tsx` (Modify)
  - **内容**: Update the `SearchResult` interface (drop `file_path`, add `score`). Update the JSX: replace `<span className="...font-mono truncate" title={r.file_path}>{r.file_path}</span>` with `<span className="text-xs text-gray-500">id: {r.id.slice(0, 8)}…  score: {r.score.toFixed(3)}</span>`. Also drop the `title={r.file_path}` on the outer `<div>`. Remove the old `embedding_available` / `rewritten` fallback notice JSX if present (it was the old webui-memory-page search shape — already removed in the overwrite commit). Update the test mocks to match the new shape.
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/web && ./node_modules/.bin/vitest --run src/components/memory/MemorySearchTester.test.tsx`
  - **依赖**: 7.1

- [ ] 7.3 **MemorySearchTester test rewrite**
  - **文件**: `packages/webui/web/src/components/memory/MemorySearchTester.test.tsx` (Modify)
  - **内容**: Rewrite the mocks to the new shape. Cases: (a) Search button disabled when query empty (kept), (b) call `api.memory.search("foo", 10)` and render results showing title and `score.toFixed(3)`, (c) onSelectAtom called with result id (kept), (d) score is displayed — assert `screen.getByText(/score: \d+\.\d{3}/)`. Remove the obsolete `embedding_available` / `rewritten` / `fallback` assertions.
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/web && ./node_modules/.bin/vitest --run src/components/memory/MemorySearchTester.test.tsx`
  - **依赖**: 7.2

## 8. Changelog + cross-cutting cleanup

- [ ] 8.1 **personal-assistant CHANGELOG entry**
  - **文件**: `extensions/personal-assistant/CHANGELOG.md` (Modify)
  - **内容**: Under `## [Unreleased]`, add a `### Changed` bullet: "Search response now returns `score` instead of `file_path`. Agents use the new `memory_get` tool to fetch full content — search is discovery-only. Score = cosine × (1 + 0.3 × strength + 0.2 × importance), per-type top-3 with round-robin interleaving. Extraction prompt now accepts `<user_tone>` hint to calibrate importance." Add `### Added` bullet: "New `memory_get` tool — sole programmatic strength-feedback entry. Bumps `access_count` and `last_access`."
  - **验证**: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | head -60` (full check, must exit 0)
  - **依赖**: 5.2

- [ ] 8.2 **webui CHANGELOG entry**
  - **文件**: `packages/webui/CHANGELOG.md` (Modify)
  - **内容**: Under `## [Unreleased]`, add a `### Changed` bullet: "SearchTester shows `score` (weighted formula) instead of file path. Search response from server drops `file_path` and adds `score`. `GET /api/memory/:id` is preview-only — does not bump `access_count`."
  - **验证**: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | head -60` (full check, must exit 0)
  - **依赖**: 7.3

## Verification
- [ ] personal-assistant tests: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && ../../node_modules/.bin/vitest --run`
- [ ] webui server tests: `cd /home/qjh/workspace/personal/pi/packages/webui/server && ../../../../node_modules/.bin/vitest --run`
- [ ] webui frontend tests: `cd /home/qjh/workspace/personal/pi/packages/webui/web && ./node_modules/.bin/vitest --run --no-file-parallelism`
- [ ] Full repo check: `cd /home/qjh/workspace/personal/pi && npm run check` (must exit 0; full output, no tail)