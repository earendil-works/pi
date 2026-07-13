# Tasks: agent-driven-memory-save

> **Design:** design.md | **Base:** d5b51dd85

**Goal**: Add agent-driven `memory_save` tool for explicit memory writes, make `session_before_compact` a graceful safety net, and extract a shared `recallPipeline()` so TUI and webui produce identical recall results.

**Architecture**: New `extensions/personal-assistant/recall.ts` exports `recallPipeline(index, opts)` shared between TUI context hook and webui `/api/memory/search`. New `extensions/personal-assistant/memory-save.ts` defines a single TypeBox-schema tool with three outcomes (created / updated / skipped) sharing the existing `extraction.ts` fingerprint dedup. Module-level `segmentMemorySaveCount` gates safety-net behavior. `tools.ts` gains path-guard branches and registers the tool.

**Tech Stack**: TypeScript (erasable syntax), TypeBox, vitest, better-sqlite3 + sqlite-vec, bge-m3 FastAPI service, Express (webui server).

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs. Comma is the ONLY delimiter.
  - Task ID format: `<section>.<task>[letter]` (e.g. `1.1`, `2.3a`).
- **TDD pattern**: each task follows `red → green → commit`. Step-level details live in the implementer's discipline; the `验证` line confirms the green.
- **Test commands**: from repo root `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts` for package-scoped tests; `npm test` for full suite.
- **Lint/typecheck**: `npm run check` (full output, no tail). Fix all errors/warnings before commit.

## 1. Foundation: shared recallPipeline

- [x] 1.1 **Create recall.ts with `recallPipeline` signature and topK default**
  - **文件**: `extensions/personal-assistant/recall.ts` (Create)
  - **内容**: Define `RecallPipelineOptions` interface (query, recent?, topK?, filter?, rerankEnabled?, atomsDir, embeddingServiceUrl?, embeddingServiceUrlProbe?) and `recallPipeline(index, opts)` returning `{results, status}` where status includes `{rewrite, rerank, recallMs, rewriteMs, rerankMs, embeddingServiceStatus?}`. Default `topK` to 20. Default `rerankEnabled` to true. Body throws "not implemented" stub.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` — test imports `recallPipeline`, asserts signature compiles and default topK=20 in unit test (test fails because stub throws).
  - **依赖**: 无
  - **前置阅读**: `extensions/personal-assistant/search.ts:171`, `extensions/personal-assistant/rewrite.ts:316`, `extensions/personal-assistant/rerank.ts:88`, `extensions/personal-assistant/merge.ts`

- [x] 1.2 **Implement recallPipeline rewrite→recall→rerank→merge core**
  - **文件**: `extensions/personal-assistant/recall.ts` (Modify)
  - **内容**: Body runs: `rewriteQueries(query, recent ?? null)` (line 316) → `Promise.all(subqueries.map(async sq => { recallAtoms(index, sq, {topK, filter, atomsDir}) then rerankAndFilter(sq, results) }))` → `mergeByRerankScore(poolResults)`. Return `{results, status}` with timings measured via `performance.now()`.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` — `recallPipeline topK default 20` and `recallPipeline passes recent to rewrite` tests PASS; mock fixtures provide stub `recallAtoms` and `rewriteQueries`.
  - **依赖**: 1.1

- [x] 1.3 **Add embedding service health probe (webui-only opt-in)**
  - **文件**: `extensions/personal-assistant/recall.ts` (Modify)
  - **内容**: When `opts.embeddingServiceUrlProbe === true`, run a 100ms `fetch(embeddingServiceUrl + "/api/health")` and set `status.embeddingServiceStatus` to `"up"` (2xx) or `"down"` (non-2xx / abort / network error). TUI callers pass `false` or omit.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` — `recallPipeline embedding probe up/down` tests PASS with mock fetch.
  - **依赖**: 1.2

- [x] 1.4 **Add topK clamp to [1, 100]**
  - **文件**: `extensions/personal-assistant/recall.ts` (Modify)
  - **内容**: At entry, if `opts.topK !== undefined`, clamp `Math.max(1, Math.min(100, opts.topK))`. Default 20 when undefined or NaN. `opts.recent ?? null` normalizes null/undefined.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` — `recallPipeline topK clamp to [1,100]` tests PASS: 0 → 1, 200 → 100, undefined → 20.
  - **依赖**: 1.3

## 2. Tooling: memory_save + segment counter

- [x] 2.1 **Create memory-save.ts with TypeBox schema and module-level counter**
  - **文件**: `extensions/personal-assistant/memory-save.ts` (Create)
  - **内容**: Define `MemorySaveParams` TypeBox schema: `id?`, `type` union (rule/fact/process), `title` 1-200, `content` 10-5000, `summary` 5-500, `tags?` array, `importance` 0-1 number, `source_session?`. Module-level `let segmentMemorySaveCount = 0`. Export `getSegmentMemorySaveCount()`, `incrementSegmentMemorySaveCount()`, `resetSegmentMemorySaveCount()`. Tool `execute` body throws "not implemented".
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — schema validation tests PASS (TypeBox rejects invalid type / content_too_short); counter accessors PASS.
  - **依赖**: 无

- [x] 2.2 **Implement create path (fingerprint miss)**
  - **文件**: `extensions/personal-assistant/memory-save.ts` (Modify)
  - **内容**: When `id` absent: `computeFingerprint(content)` → `index.getActiveAtomByFingerprint(fp)`; if null, build new MemoryAtom with `randomUUID()`, `embedText(buildEmbeddableText({title, summary, tags}), 15s)` → `vector ?? new Array(1024).fill(0)`, then `index.insertAtom(atom, vector)` + `writeAtomToFile(atom, atomsDir)` + `reindexOne(atom.id)`. Return `{action:"created", id, embedding: vectorWasNull ? "skipped" : "ok"}`.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `memory_save create fingerprint miss` test PASS: DB 1 row, .md exists, reindexOne called with the new id.
  - **依赖**: 2.1

- [x] 2.3 **Implement skipped path (fingerprint hit)**
  - **文件**: `extensions/personal-assistant/memory-save.ts` (Modify)
  - **内容**: In `id` absent branch, when `index.getActiveAtomByFingerprint(fp)` returns an atom, return `{action:"skipped", reason:"duplicate_content", existing_id: existing.id}`. Increment counter even on skip.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `memory_save fingerprint hit skip` test PASS: DB unchanged, .md not written, reindexOne not called.
  - **依赖**: 2.2

- [x] 2.4 **Implement overwrite path (id present, atom exists)**
  - **文件**: `extensions/personal-assistant/memory-save.ts` (Modify)
  - **内容**: When `id` present: `index.getAtom(id)`; if found, build `mergedAtom = {...existing, type, title, summary, content, tags, importance, content_fingerprint: computeFingerprint(content), updated_at: Date.now()}`. `embedText` → `index.updateAtom(mergedAtom, vector)` + `writeAtomToFile(mergedAtom, atomsDir)` + `reindexOne(mergedAtom.id)`. Return `{action:"updated", id, embedding}`.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `memory_save overwrite id exists` test PASS: DB row updated, version bumped via SQL, .md overwritten.
  - **依赖**: 2.3

- [x] 2.5 **Implement id-not-found error path**
  - **文件**: `extensions/personal-assistant/memory-save.ts` (Modify)
  - **内容**: When `id` present and `index.getAtom(id)` returns null, return `{action:"error", error:"id_not_found", id}`. No writes.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `memory_save overwrite id not found` test PASS: returns id_not_found, DB unchanged.
  - **依赖**: 2.4

- [x] 2.6 **Counter increments on every execute (success or skip)**
  - **文件**: `extensions/personal-assistant/memory-save.ts` (Modify)
  - **内容**: At the end of `execute`, call `incrementSegmentMemorySaveCount()` (regardless of outcome — created / updated / skipped / error all count, per principle "计入调用而不计入成功").
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `segment counter increments on each execute` test PASS: after 3 calls (1 created, 1 skipped, 1 error), `getSegmentMemorySaveCount() === 3`.
  - **依赖**: 2.5

- [x] 2.7 **Embedding down → zero vector fallback**
  - **文件**: `extensions/personal-assistant/memory-save.ts` (Modify)
  - **内容**: When `embedText` returns `null`, use `new Array(1024).fill(0)` as vector (matches `extraction.ts:243, 258` pattern). `reindexOne` still called. Return `embedding: "skipped"` flag in result.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `memory_save embedding down` test PASS: DB 1 row, vector = zero vector, embedding: "skipped".
  - **依赖**: 2.6

## 3. tools.ts integration: register tool + path guard + system prompt

- [x] 3.1 **Register memory_save tool in registerTools**
  - **文件**: `extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: In `registerTools` function (line 823), after the `todowrite` tool (line 1016), call `pi.registerTool({name: "memory_save", label: "Memory Save", description: "Save a fact/rule/process to durable memory.", promptSnippet: "Save to memory.", parameters: MemorySaveParams, async execute(_id, params) { return await executeMemorySave(params, ctx); }})`. `executeMemorySave` lives in memory-save.ts and is called via passing through the loaded `MemoryIndex` constructed from `loadConfig()` defaults. Tool call returns `{content: [{type:"text", text: resultStr}], details: result}`.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `memory_save tool registered with name memory_save` test PASS (mock pi captures the registration).
  - **依赖**: 2.7

- [x] 3.2 **Add memory section to before_agent_start system prompt**
  - **文件**: `extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: In `before_agent_start` handler (line 828), append `memorySection` (5 rules about when to save, what to save, importance 0-1 honesty, tags format) to the existing `planningSection + remotePathsPrompt + transferFilePrompt`. See design.md §"system prompt 增量" for exact text.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `before_agent_start system prompt contains memory section` test PASS: assert returned systemPrompt contains "## Memory" and "memory_save".
  - **依赖**: 3.1

- [x] 3.3 **Implement tool_call path guard for `write`/`edit`**
  - **文件**: `extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: In `tool_call` hook (line 934), after the satellite check (line 938-943), add: when `event.toolName === "write" || event.toolName === "edit"` and `event.input.path` (or `file_path`) resolves under `~/.pi/agent/memory/atoms/**` (after `~` → home expansion), return `{block: true, reason: "memory atoms must be written via the memory_save tool, not direct file write/edit. Use memory_save({type, title, content, ...}) instead."}`. Add helper `isUnderAtomsDir(path, atomsDir)` colocated in tools.ts (or import from memory.ts:233).
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `tool_call blocks write to atoms/process/foo.md`, `tool_call blocks edit to atoms/fact/a-123.md`, `tool_call does not block read of atoms/...` tests PASS.
  - **依赖**: 3.1

- [x] 3.4 **Implement tool_call path guard for `bash` redirect/heredoc**
  - **文件**: `extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: In `tool_call` hook, when `event.toolName === "bash"`, run `looksLikeWriteToAtomsDir(cmd, atomsDir)`: regex match `>(>?)\s*["']?~?/?[^{}<>]*atoms/` or `\btee\b\s+~?/?[^{}<>]*atoms/`. If matched, return block error. Add helper colocated.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `tool_call blocks bash redirect to atoms`, `tool_call blocks bash heredoc`, `tool_call does not block bash read of atom` tests PASS.
  - **依赖**: 3.3

## 4. memory.ts: safety net + counter reset

- [x] 4.1 **Add counter reset at segment boundaries (`session_start` + `session_compact`)**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: Register a new `pi.on("session_start", ...)` hook AND a new `pi.on("session_compact", ...)` hook — both call `resetSegmentMemorySaveCount()` (imported from `./memory-save.ts`). The reset happens at segment boundaries: initial session load (session_start) and after each compact completes (session_compact). **Not** in `before_agent_start` — that fires per turn and would break the per-segment accumulation semantic required by the safety net (S22).
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `segment counter resets on session_start` + `segment counter resets on session_compact` + `segment counter survives between turns within a segment` (S22: turn 1-3 save 3, turn 4-10 no save, turn 11 compact with counter=3) tests PASS.
  - **依赖**: 3.1

- [x] 4.2 **session_before_compact safety net: skip when count >= 1**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: In `session_before_compact` hook (line 336), at the very start of the handler, if `getSegmentMemorySaveCount() >= 1`, return `undefined` directly (skip extraction). Existing `runCompactExtraction` runs only when count == 0.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `safety net skipped when count >= 1` test PASS: mock counter=2, hook returns undefined without calling runCompactExtraction.
  - **依赖**: 4.1

- [ ] 4.3 **session_before_compact graceful failure (no cancel)**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: In `session_before_compact` hook, change the catch block (line 340-353) to: log warning, `notifySafely(ctx, \`memory: safety net skipped — \${msg}\`, "warn")`, return `undefined` (was: `{cancel: true}`). Compact now always proceeds.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — `safety net graceful on extraction failure` test PASS: mock runCompactExtraction throws, hook returns undefined, notify called with "warn".
  - **依赖**: 4.2

## 5. TUI: context hook uses recallPipeline

- [x] 5.1 **Refactor context hook to call recallPipeline**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: In `context` hook (line 726), replace the inline rewrite+recall+rerank+merge block (rewriteQueries at line 821 / 840, then the inline Promise.all recall + rerank + merge around line 858-901, then `mergeByRerankScore(poolResults)` at line 894) with a single call: `recallPipeline(index, {query: current, recent, topK: 20, rerankEnabled, atomsDir, embeddingServiceUrlProbe: false})`. Pass the **single** user message string as `query` — `recallPipeline` does the rewrite internally per design Decision 8.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` — `TUI context hook calls recallPipeline with recent + single query string` test PASS (mock pi captures hook registration; mock recallPipeline called with `query: <single string>`, `recent: ["msg1","msg2","msg3"]`, `topK: 20`).
  - **依赖**: 1.4

- [x] 5.2 **TUI keeps formatMemoryContext + inject into user message**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: After `recallPipeline` returns `results`, the existing `formatMemoryContext(finalResults, 4000)` call + `memoryPrefix = \`[Relevant memory context — atoms at \${atomsDir}]\n\${formatted.text}\n\n[User message]\n\`` + `newMessages[lastUserIdx] = {...}` injection stays. Only the pipeline computation (steps 5-7 in old code) is replaced.
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` — `TUI context hook injects formatted context into last user message` test PASS (mock event.messages assertion).
  - **依赖**: 5.1

## 6. Webui: registerPostSearch uses recallPipeline

- [x] 6.1 **Refactor registerPostSearch to call recallPipeline**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: In `registerPostSearch` handler (line 845+), replace the inline `rewriteQueries` + `Promise.all(subqueries.map(...))` + `mergeByRerankScore` block (line 898-947) with a single call: `const {results, status} = await recallPipeline(index, {query, recent: Array.isArray(req.body?.recent) ? req.body.recent : null, topK: clamp(parseInt(req.body?.topK) || 20, 1, 100), filter: type ? {type} : undefined, rerankEnabled: filtered !== false, atomsDir: deps.atomsDir, embeddingServiceUrl: deps.embeddingServiceUrl, embeddingServiceUrlProbe: true})`.
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` — `webui /api/memory/search calls recallPipeline` test PASS (mock recallPipeline invoked with expected opts).
  - **依赖**: 1.4

- [x] 6.2 **Webui response shape preserved + embeddingServiceStatus from pipeline**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: Keep response shape `{results: results.map(...), recallTimeMs, embeddingServiceStatus, ...(filtered ? {rewriteTimeMs, rerankTimeMs} : {})}`. Map `status.embeddingServiceStatus` (when probed) and `status.recallMs` / `status.rewriteMs` / `status.rerankMs` into response fields. `embeddingServiceStatus` probe removed from inline code (now in recallPipeline).
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` — `webui response includes embeddingServiceStatus from pipeline` test PASS.
  - **依赖**: 6.1

- [x] 6.3 **Webui topK default 20 (was 10)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: Change `const topK = Number.isFinite(rawTopK) ? Math.min(100, Math.max(1, rawTopK)) : 10;` to `... : 20;`. Clamp behavior unchanged.
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` — `webui topK default 20` test PASS: request without topK → recallPipeline receives topK: 20.
  - **依赖**: 6.2

- [x] 6.4 **Webui accepts optional `recent` field in request body**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: Add validation: if `req.body.recent` is present, must be `string[]` (otherwise 400). Pass to recallPipeline as `recent`.
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` — `webui accepts recent: string[]`, `webui rejects recent: number[]`, `webui recent absent → null` tests PASS.
  - **依赖**: 6.3

## 7. Verification

- [ ] 7.1 **Full typecheck + lint pass**
  - **验证**: `npm run check` exits 0 with no errors / warnings / infos.
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4

- [ ] 7.2 **Full vitest suite passes**
  - **验证**: `npm test` exits 0; all pre-existing tests still pass (no regressions).
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4

- [ ] 7.3 **memory-save-tool unit tests pass**
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` — all 7 unit cases pass.
  - **依赖**: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3

- [ ] 7.4 **recall-pipeline unit tests pass**
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` — all 5 unit cases pass.
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4

- [ ] 7.5 **webui memory-routes integration tests pass**
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` — all tests pass including new recent / topK-20 cases.
  - **依赖**: 6.1, 6.2, 6.3, 6.4

- [ ] 7.6 **Regression: extraction pipeline tests pass**
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction.test.ts test/extraction-oldid.test.ts test/extraction-prompt.test.ts` — fingerprint + oldId behavior unchanged.
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4

- [ ] 7.7 **Regression: webui PATCH route tests pass (supersedeIfSimilar 0.65 unchanged)**
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` — `PATCH /api/memory/:id` cases pass.
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4

- [ ] 7.8 **Manual smoke: agent memory_save three outcomes**
  - **验证**: `npm run build` then `./packages/coding-agent/dist/cli.js --help | grep memory_save` confirms tool registered; run interactive session in tmux, call `memory_save` with each outcome path; verify UI / log shows correct action.
  - **依赖**: 3.1, 3.2, 3.3, 3.4

- [ ] 7.9 **Manual smoke: agent direct write blocked**
  - **验证**: in tmux session, agent attempts `write({path: "~/.pi/agent/memory/atoms/process/test.md", content: "x"})` → tool_call returns block error, file not written.
  - **依赖**: 3.1, 3.2, 3.3, 3.4

- [ ] 7.10 **Manual smoke: TUI + webui same query → same recall**
  - **验证**: in tmux session, agent asks "BWA 引物验证"; simultaneously webui MemorySearchTester queries same string; both return identical id list + rrf scores (modulo recent context).
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4