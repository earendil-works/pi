# Tasks: memory-v2-refactor

> **Design:** design.md | **Base:** 3956c586dadd9c60807fcc7fe8d9d418567b9541

**Goal**: 用纯向量检索 (sqlite-vec + bge-m3) + 内容指纹 dedup + 3 大类 type + L0/L1 双层注入,完全替换 v1 memory 模块。

**Architecture**: 单一 SQLite (better-sqlite3 + sqlite-vec) 存储 atom 元数据 + 向量。LLM 只产出 content,代码基于 fingerprint + cosine 决定 skip/supersede/create。检索纯 cosine KNN,top-3 L1 其余 L0。完全无 fallback,失败即空。

**Tech Stack**: better-sqlite3, sqlite-vec, ollama (bge-m3:latest), TypeScript, vitest

## Notes

- **`依赖`** = execution order
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs that must complete first
- **每个 task 内**: TDD — 写失败测试 → 跑验证失败 → 实现 → 跑验证通过 → commit
- **每 commit 前**: `npm run check` exit 0
- **旧分支 webui-memory-page**: 不动,等本次完成后单独 archive

---

## 1. Dependencies & Package

- [x] 1.1 **新增 npm 依赖 (better-sqlite3 + sqlite-vec)**
  - **文件**: `extensions/personal-assistant/package.json` (Modify)
  - **内容**: 加 `"better-sqlite3": "^12.11.1"` 和 `"sqlite-vec": "0.1.9"` 到 dependencies (Node 26 要求 12.x+,sqlite-vec 0.1.9 已 pin)。确保 `npm install` 跑通。
  - **验证**: `cd extensions/personal-assistant && npm install && node -e "const sqliteVec = require('sqlite-vec'); const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.loadExtension(sqliteVec.getLoadablePath()); console.log('OK')"` 输出 OK
  - **依赖**: 无

---

## 2. Storage Layer

- [x] 2.1 **新建 types.ts**
  - **文件**: `extensions/personal-assistant/types.ts` (Create)
  - **内容**: 定义 `MemoryAtom` interface (含 is_latest/parent_id/content_fingerprint/superseded_at 新字段), `MemoryAtomType` union (`"rule" | "fact" | "process"`), `RecallResult`, `ExtractionItem`, `ExtractionResult`。导出供其他模块用。
  - **验证**: `cd extensions/personal-assistant && node -e "import('./types.ts').then(m => console.log(Object.keys(m)))"` 输出包含 `MemoryAtom, MemoryAtomType, RecallResult, ExtractionItem`
  - **依赖**: 1.1

- [x] 2.2 **实现 MemoryIndex 类基础 + 新 schema 初始化**
  - **文件**: `extensions/personal-assistant/storage.ts` (Create)
  - **内容**: `MemoryIndex` 类,`constructor(dbPath)`, `async init()` 建 `memory_index` + `memory_vectors` (vec0) + `memory_audit` 表 + 索引 (`UNIQUE idx_memory_active_fingerprint`, `idx_memory_active_recent`)。`close()` 方法。
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/storage.test.ts -t "init creates all tables"` 通过
  - **依赖**: 2.1

- [x] 2.3 **实现 atom CRUD + fingerprint 查重**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: `insertAtom(atom)`, `updateAtom(atom)`, `getAtom(id)`, `getActiveAtomByFingerprint(fp)`, `getActiveAtoms()`, `getActiveAtomsByType(type)`。`content_fingerprint` 唯一索引防重复 active+latest 同 fingerprint。
  - **验证**: `npx vitest run test/storage.test.ts -t "atom CRUD"` 通过 (≥5 测试)
  - **依赖**: 2.2

- [ ] 2.4 **实现 vectorSearch + findMostSimilarEmbedding**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: `vectorSearch(embedding, k, filter?)` 用 sqlite-vec KNN, JOIN memory_index 过滤 `archived=0 AND is_latest=1` (可选 type)。返 `[{id, distance}]`。`findMostSimilarEmbedding(embedding, threshold)` 返 top-1 if cosine > threshold else null。
  - **验证**: `npx vitest run test/storage.test.ts -t "vector search"` 通过 (≥3 测试)
  - **依赖**: 2.3

- [ ] 2.5 **实现 markSupersededTx 事务 + audit 写入**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: `markSupersededTx(oldId, newId)` 用 `BEGIN IMMEDIATE` UPDATE old is_latest=0/superseded_at=now + INSERT new。事务失败自动 rollback。`insertAudit(atom_id, action, details?)` 写 `memory_audit`。
  - **验证**: `npx vitest run test/storage.test.ts -t "supersede transaction"` 通过 (≥3 测试,验证原子性 + rollback + audit)
  - **依赖**: 2.3

- [ ] 2.6 **实现 updateAccess + updateStrength + markArchived + deleteVector**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify)
  - **内容**: `updateAccess(id)` (access_count+1, last_access=now), `updateStrength(id, strength)`, `markArchived(id)` (set archived=1, superseded_at 不变), `deleteVector(id)` (DELETE FROM memory_vectors)。
  - **验证**: `npx vitest run test/storage.test.ts -t "access and decay"` 通过 (≥4 测试)
  - **依赖**: 2.3

- [ ] 2.7 **所有 storage 测试全绿**
  - **文件**: `extensions/personal-assistant/test/storage.test.ts`
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/storage.test.ts` 通过 (≥18 测试累计)
  - **依赖**: 2.3, 2.4, 2.5, 2.6

---

## 3. Embed & File Store

- [x] 3.1 **实现 embed.ts**
  - **文件**: `extensions/personal-assistant/embed.ts` (Create)
  - **内容**: `embedText(text, config?)` 单函数调 ollama `/v1/embeddings`,返 `number[] | null`,15s timeout。`buildEmbeddableText(atom)` 拼 `title + summary + content + tags`。`loadConfig()` 复用。
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/embed.test.ts` 通过 (≥3 测试,含 buildEmbeddableText)
  - **依赖**: 2.1

- [x] 3.2 **实现 file-store.ts (id-based path)**
  - **文件**: `extensions/personal-assistant/file-store.ts` (Create)
  - **内容**: `writeAtomToFile(atom, baseDir)` 写 `atoms/<type>/<atom.id>.md`。frontmatter 含所有 atom 字段。`readAtomFromFile(filePath, expectedHash?)` 读 + 校验 hash。`normalizeMarkdown(s)` 工具函数 (frontmatter 分离)。
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/file-store.test.ts` 通过 (≥4 测试)
  - **依赖**: 2.1

---

## 4. Extraction

- [x] 4.1 **实现 fingerprint + normalizeContent helpers**
  - **文件**: `extensions/personal-assistant/extraction.ts` (Create)
  - **内容**: `normalizeContent(content)` 去多余空白 + trim + lowercase。`computeFingerprint(content)` 返回 `sha256(normalizeContent(content)).slice(0, 16)`。
  - **验证**: `npx vitest run test/fingerprint.test.ts` 通过 (≥3 测试)
  - **依赖**: 2.1

- [x] 4.2 **新 extraction prompt v2 (3 类 type + 2-4 段 content)**
  - **文件**: `extensions/personal-assistant/extraction.ts` (Modify)
  - **内容**: `EXTRACT_PROMPT_V2` 常量,含 3 类 type 标准 (rule/fact/process) + 内容格式要求 (2-4 段) + strategy (dedup 自动处理,emit 不担心重复) + output schema (无 action/id/changes,只有 type/title/content/summary/tags/importance)。
  - **验证**: prompt 字符串包含 "rule", "fact", "process", "2-4 段", 不含 "one-sentence"
  - **依赖**: 4.1

- [ ] 4.3 **实现 executePlan with dedup**
  - **文件**: `extensions/personal-assistant/extraction.ts` (Modify)
  - **内容**: `executePlan(index, config, atomsDir, plan)` 函数,对每 item: normalizeContent + fingerprint → DB 查 → skip;否则 embedText + findMostSimilarEmbedding → supersede (BEGIN TX + markSupersededTx) 或 create (BEGIN TX + insertAtom)。写 .md 文件 + audit。
  - **验证**: `npx vitest run test/extraction.test.ts` 通过 (≥8 测试:skip/supersede/create/transfer signals/parse fail/ollama fail/file write)
  - **依赖**: 2.4, 2.5, 2.6, 3.1, 3.2, 4.1, 4.2

- [ ] 4.4 **实现 supersede 转移 signals 测试**
  - **文件**: `extensions/personal-assistant/test/supersede.test.ts` (Create)
  - **内容**: 测试 supersede 时,旧 atom.strength / access_count / created_at transfer 到新 atom。新 atom.version=1,但 importance 取 max(old, new)。
  - **验证**: `npx vitest run test/supersede.test.ts` 通过 (≥3 测试)
  - **依赖**: 4.3

- [ ] 4.5 **实现 extractMemories + extractMemoriesWithCallLlm + runMemoryExtraction**
  - **文件**: `extensions/personal-assistant/extraction.ts` (Modify)
  - **内容**: 
    - `extractMemories(messages, index, ctx, config)` (ExtensionContext 版本)
    - `extractMemoriesWithCallLlm(callLlm, messages, index, config, atomsDir)` (callLlm 版本)
    - `runMemoryExtraction(opts: RunMemoryExtractionOptions)` (exported for webui,统一 opts 签名:`{ callLlm, config, messages, dbPath, atomsDir }`)
    - `writeExtractionReport(plan: ExtractionPlan, logDir?: string)` — 写 JSON report 到 `~/.pi/agent/logs/extraction-report-<timestamp>.json`,含 plan 内容 + timestamp + 调用的 model 信息。**该函数被 Task 8.1 (registerMemory) 调用**,不实现此函数会导致 8.1 编译失败。
  - **验证**: 三个 extraction 函数 + writeExtractionReport 全部 export,webui Task 7.7 用 `runMemoryExtraction({ callLlm, ... })` 调用
  - **依赖**: 4.3

---

## 5. Search & Format

- [ ] 5.1 **实现 recallAtoms (纯向量 KNN)**
  - **文件**: `extensions/personal-assistant/search.ts` (Create)
  - **内容**: `recallAtoms(index, query, config?)`: embedText(query) → vectorSearch(index, queryEmb, k=topK*2, filter) → hydrate → updateAccess → top-3 sync 读 .md (L1 tier),其余 L0。返 `RecallResult[]` with distance, cosine (1 - distance/2)。
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/search.test.ts` 通过 (≥6 测试:top-K/filter/archived 排除/is_latest=0 排除/file 缺失降级/hash 错位降级)
  - **依赖**: 2.4, 3.1, 3.2

- [ ] 5.2 **实现 formatMemoryContext L0/L1 + token budget**
  - **文件**: `extensions/personal-assistant/format.ts` (Create)
  - **内容**: `formatMemoryContext(results, tokenBudget)` 按 distance 排序,逐个加入 (估算 `Math.ceil(text.length / 2.5)` tokens),超 budget 停。`formatMemoryBlock(atom, tier)`: L0 = title+summary+tags; L1 = L0 + content。
  - **验证**: `npx vitest run test/format.test.ts` 通过 (≥4 测试:L0 块格式/L1 块格式/token budget 截断/empty input)
  - **依赖**: 5.1

---

## 6. Decay

- [ ] 6.1 **更新 runDecay 用新 schema + deleteVector**
  - **文件**: `extensions/personal-assistant/decay.ts` (Create)
  - **内容**: `runDecay(index, baseDecay, archiveThreshold)` 沿用旧公式 (strength * exp(-lambda * deltaDays / denom)),`rule` 类型永不 archive,`fact`/`process` strength < threshold → markArchived + deleteVector。
  - **验证**: `npx vitest run test/decay.test.ts` 通过 (≥4 测试:new_strength 计算/rule 不 archive/fact/archive 触发 deleteVector)
  - **依赖**: 2.6

---

## 7. Webui REST Routes

- [ ] 7.1 **实现 GET /api/memory 列表 + filter + mountMemoryRoutes**
  - **文件**: `packages/webui/server/routes/memory.ts` (Create, 重写)
  - **内容**: 
    1. **export function mountMemoryRoutes(app: express.Express, deps: MemoryDeps)** — 注册全部 7 个 route,在文件底部调用
    2. `MemoryDeps` interface: `{ dbPath, atomsDir, settings: PersonalAssistantConfig, callLlm: (prompt: string) => Promise<string> }`
    3. GET /api/memory,支持 `?archived=active|archived|all`、`?type=`、`?tag=`、`?q=`、`?limit=200`、`?offset=0`。从 MemoryIndex.getActiveAtoms() hydrate 返 JSON array。
  - **验证**: `cd packages/webui && npm test -- --run test/memory-routes.test.ts -t "list endpoint"` 通过
  - **依赖**: 2.3

- [ ] 7.2 **实现 GET /api/memory/stats**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: GET /api/memory/stats 返 `{total, archived, byType: {rule: N, fact: M, process: K}}`。
  - **验证**: `npm test -- --run test/memory-routes.test.ts -t "stats"` 通过
  - **依赖**: 7.1

- [x] 7.3 **实现 GET /api/memory/:id 详情 (含 .md body)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: GET /api/memory/:id 返完整 atom JSON 含 content (从 .md 读)。404 if not found。File 缺失或 hash mismatch → content="",不 500。
  - **验证**: `npm test -- --run test/memory-routes.test.ts -t "get detail"` 通过 (≥3 测试)
  - **依赖**: 3.2

- [ ] 7.4 **实现 PATCH /api/memory/:id 编辑**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: PATCH /api/memory/:id merge body:tags union,content 用 body.content ?? currentBody,importance 用 body.importance ?? existing。**先 await embedText(merged.content) → 再 BEGIN TX updateAtom + updateVector + COMMIT → 最后 writeAtomToFile**。事务中不 await ollama call (避免长锁)。
  - **验证**: `npm test -- --run test/memory-routes.test.ts -t "patch"` 通过 (≥3 测试:union tags/recompute embedding/version+1)
  - **依赖**: 2.3, 3.1, 3.2, 7.3

- [ ] 7.5 **实现 POST /api/memory/:id/archive**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: POST /api/memory/:id/archive toggle archived field (default toggle,body.archived 显式 set)。markArchived + deleteVector。**unarchive 不自动 re-compute vector** (scenarios.md:179 明确)。
  - **验证**: `npm test -- --run test/memory-routes.test.ts -t "archive"` 通过 (≥2 测试)
  - **依赖**: 2.6, 7.3

- [ ] 7.6 **实现 POST /api/memory/search (召回 + token budget)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: POST /api/memory/search body `{query, topK?, tokenBudget?}` → recallAtoms → formatMemoryContext。返 `{results, recallTimeMs, tokenBudgetUsed}`。
  - **验证**: `npm test -- --run test/memory-routes.test.ts -t "search"` 通过 (≥2 测试)
  - **依赖**: 5.1, 5.2, 7.1

- [ ] 7.7 **实现 POST /api/memory/extract (手动触发)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: POST /api/memory/extract body `{messages: [...]}` → `runMemoryExtraction({ callLlm, config, messages, dbPath, atomsDir })` (统一签名,见 Task 4.5)。返 `{plan, created, superseded, skipped}`。
  - **验证**: `npm test -- --run test/memory-routes.test.ts -t "extract"` 通过 (≥1 测试)
  - **依赖**: 4.5

- [ ] 7.8 **注册 routes 到 server/index.ts**
  - **文件**: `packages/webui/server/index.ts` (Modify)
  - **内容**: `import { mountMemoryRoutes } from "./routes/memory.ts"`, 在 register routes 区域调 `mountMemoryRoutes(app, { dbPath, atomsDir, settings, callLlm })`。**(mountMemoryRoutes 函数在 Task 7.1 中定义并 export,该函数注册全部 7 个 route)**。
  - **验证**: server 启动后 `curl http://127.0.0.1:8741/api/memory/stats` 返 200 + JSON
  - **依赖**: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7

---

## 8. Lifecycle Integration

- [ ] 8.1 **实现 registerMemory + session_before_compact hook**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify, 重写)
  - **内容**: `registerMemory(pi)` 注册 `session_before_compact` 调 `extractMemories` + writeExtractionReport。`session_start` 调 `runDecay`(每小时最多一次)。
  - **验证**: vitest mock pi ExtensionAPI,验证 hook 注册 + session_before_compact 触发 extractMemories
  - **依赖**: 4.5, 6.1

- [ ] 8.2 **实现 before_agent_start + context 注入**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: `before_agent_start` 异步启动 `recallAtoms` 存 `pendingMemorySearch`。`context` handler await Promise.race with 8s timeout,`formatMemoryContext` 注入到最后一个 user message。
  - **验证**: vitest mock ExtensionContext,验证 hook + formatMemoryContext 调用
  - **依赖**: 5.1, 5.2, 8.1

- [ ] 8.3 **集成测试: end-to-end extraction → embedding → recall 链路**
  - **文件**: `extensions/personal-assistant/test/integration.test.ts` (Create)
  - **内容**: mock LLM 返 plan → extractMemories → recallAtoms(query related to plan content) → 验证新 atom 在 top-K
  - **验证**: `npx vitest run test/integration.test.ts` 通过 (≥3 测试)
  - **依赖**: 4.5, 5.1, 8.1, 8.2

---

## 9. Recall Quality Evaluation (新!)

- [ ] 9.1 **新建 recall-quality.test.ts 用 labeled dataset 验证召回质量**
  - **文件**: `extensions/personal-assistant/test/recall-quality.test.ts` (Create)
  - **内容**:
    - 定义 `dataset.atoms` (10-20 个,跨 rule/fact/process,中英文混合,含 query 的 ground truth mapping)
    - 定义 `dataset.queries` (5-10 个,含 exact/semantic/chinese/type-filter/no-false-positive 5 类场景,每 query 含 `relevantIds`)
    - **Mock embedding 必须用 character n-gram overlap 策略** (不是纯 hash):
      ```typescript
      function mockEmbed(text: string, dims = 1024): Float32Array {
        const arr = new Float32Array(dims);
        // 字符 2-gram 切分 (中英文都能切)
        const normalized = text.toLowerCase().replace(/\s+/g, " ");
        for (let i = 0; i < normalized.length - 1; i++) {
          const bigram = normalized.slice(i, i + 2);
          // 简单 hash 到维度
          const idx = (bigram.charCodeAt(0) * 31 + bigram.charCodeAt(1) * 37 + i * 13) % dims;
          arr[idx] += 1;
        }
        // L2 normalize
        const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
        if (norm > 0) for (let i = 0; i < dims; i++) arr[i] /= norm;
        return arr;
      }
      ```
      这样 cosine similarity 与 character overlap 成正比,中英文都能用。
    - 对每 query 调 recallAtoms,计算 `recall@k`, `precision@k`, `ndcg@k`, `mrr`
    - 断言: `avg_recall_at_5 >= 0.7`, `avg_recall_at_10 >= 0.85`, `avg_precision_at_5 >= 0.5`
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/recall-quality.test.ts` 通过,且 metrics 满足阈值。console.log 输出每次 query 的 metrics。
  - **依赖**: 5.1

- [ ] 9.2 **添加 chinese query 召回 case (关键!)**
  - **文件**: `extensions/personal-assistant/test/recall-quality.test.ts` (Modify)
  - **内容**: dataset 含中文 atom (e.g., title="PDF图片提取必须用pymupdf", content 详细)。queries: `"图片"` / `"PDF提取"` / `"CMYK处理"`。验证:中文 query 命中中文 atom,recall ≥ 0.5 (因中文数据集小,门槛低)。
  - **验证**: 9.1 测试通过,中文 case recall@5 ≥ 0.5
  - **依赖**: 9.1

---

## 10. Cleanup & Index

- [ ] 10.1 **更新 index.ts 导出新 API**
  - **文件**: `extensions/personal-assistant/index.ts` (Modify)
  - **内容**: 导出 `MemoryIndex`, `MemoryAtom`, `MemoryAtomType`, `RecallResult`, `ExtractionItem`, `extractionPlanSchema`, `runMemoryExtraction`, `runMemoryExtractionFromPlan` (新), `recallAtoms`, `formatMemoryContext`, `writeAtomToFile`, `readAtomFromFile`, `embedText`, `getMemoryConfig`, `loadConfig`。删除旧导出 (searchByFts, searchAtoms, expandCjkKeywords 等)。
  - **验证**: `cd extensions/personal-assistant && node -e "import('./index.ts').then(m => console.log(Object.keys(m).sort()))"` 输出新 API 名
  - **依赖**: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 6.1

- [ ] 10.2 **删除旧 functions (searchByFts, rewriteQuery 等)**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 删除: `searchByFts`, `searchAtoms`, `searchAtomsWithScores`, `rewriteQuery`, `rewriteQueryWithCallLlm`, `callOllamaRewrite`, `simpleKeywordExtraction`, `dedupeRedundantKeywords`, `dedupeAgainstQuery`, `expandCjkKeywords`, `isEmbeddingServiceAvailable`, `searchEmbeddings`, `parseRewriteJson`, `getEmbedding`。memory.ts 只保留 entry points (registerMemory, extractMemories, runMemoryExtraction)。
  - **验证**: `grep -n "searchByFts\|rewriteQuery\|simpleKeywordExtraction\|expandCjkKeywords" memory.ts` 输出空
  - **依赖**: 10.1

- [ ] 10.3 **CHANGELOG 更新**
  - **文件**: `extensions/personal-assistant/CHANGELOG.md` (Modify), `packages/webui/CHANGELOG.md` (Modify)
  - **内容**: Unreleased 段加 Breaking/Added/Changed/Fixed/Removed entries,说明 v1→v2 变化。
  - **验证**: 两个 CHANGELOG 都有新 entry
  - **依赖**: 10.2

---

## Verification

- [ ] 全量测试: `cd extensions/personal-assistant && npx vitest run` (≥80 测试全绿)
- [ ] 全量测试: `cd packages/webui && npm test -- --run` (≥21 测试全绿)
- [ ] 全量测试: `cd packages/webui/web && node node_modules/vitest/dist/cli.js --run src/lib/useAutoSave.test.ts` (保证其他测试无回归)
- [ ] Lint + Type check: `npm run check` exit 0
- [ ] 召回质量: `cd extensions/personal-assistant && npx vitest run test/recall-quality.test.ts` 通过, metrics 满足阈值
- [ ] Live API 验证: server 启动后,curl 7 个 endpoint 都 200 + 正确响应
- [ ] Live 中文召回: `curl -X POST .../api/memory/search {"query":"图片"}` 返包含中文 atom

---

## 总任务数

- Section 1 (Dependencies): 1
- Section 2 (Storage): 7
- Section 3 (Embed & File): 2
- Section 4 (Extraction): 5
- Section 5 (Search & Format): 2
- Section 6 (Decay): 1
- Section 7 (Webui Routes): 8
- Section 8 (Lifecycle): 3
- Section 9 (Quality Eval): 2
- Section 10 (Cleanup): 3

**Total: 34 tasks**
