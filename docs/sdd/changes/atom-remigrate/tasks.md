# Tasks: atom-remigrate

> **Design:** design.md | **Base:** 5a40488ad

**Goal:** 一举治理 90 atom 历史 corpus (programmatic 0.65 dedup, no LLM) + 改 extract pipeline 防止未来再产生冗余 (LLM 二次确认 dedup + tag 字典注入 + tag 归一化)。

**Architecture:** 双目标并行 — 目标 1 复用 `findMostSimilarEmbedding` + 新加 `markSupersededNoInsert` helper 做 0.65 程序层 dedup, 写一个一次性脚本 `migrate-legacy-atoms.mts`, 天然 idempotent; 目标 2 改 `executeItem` 在 cosine ≥ 0.65 命中时调 LLM 二次确认, 加 `tag-vocab.ts` 注入 tag 字典 + 归一化 tags + 检测概念性 tag。跨两目标共享 `dedup.ts:29` 阈值 0.92 → 0.65 改动。

**Tech Stack:** TypeScript (Node 20+, tsx), better-sqlite3 + sqlite-vec, zod, vitest, fetch (Node 内置), bge-m3 service (HTTP client)。

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs. **Comma is the ONLY delimiter** (no spaces, semicolons, or `and`).
  - **Task ID format:** `<section>.<task>[letter]`
- **`前置阅读`** = context only (not execution order; orthogonal to parallelism)
- **目标 1 + 目标 2 共享 Task 1.1** (dedup 阈值降到 0.65)。其他任务可并行 (3.* 与 2.* 互不依赖)。

## 1. 跨目标基础设施: dedup 阈值 0.65 (Decision 10)

- [ ] 1.1 **dedup.ts 默认 threshold 0.92 → 0.65**
  - **文件**: `extensions/personal-assistant/dedup.ts:29` (Modify)
  - **内容**: `supersedeIfSimilar` 函数内 `findMostSimilarEmbedding` 调用的默认 fallback `0.92` 改为 `0.65`。同步更新文件顶部注释 (line 8-10 提的 "0.92-cosine" 改为 "0.65-cosine", line 9 提的 "design.md Decision 2" 改为 "Decision 10")。
  - **验证**: `grep -n "0.92" extensions/personal-assistant/dedup.ts` 应 0 行
  - **依赖**: 无

- [ ] 1.2 **dedup-threshold.test.ts 新增: 验证 0.65 默认值 + 边界**
  - **文件**: `extensions/personal-assistant/test/dedup-threshold.test.ts` (Create)
  - **内容**: 4 个 it() block: (a) `supersedeIfSimilar(index, dir, newAtom, vec)` 不传 threshold 时, 内部调 `findMostSimilarEmbedding(vec, 0.65)`,用 spy on `index.findMostSimilarEmbedding` 验证传入 0.65; (b) cosine 0.64 不被 merge; (c) cosine 0.66 被 merge; (d) self-match guard (cosine 1.0 返回 create 而非 supersede)。Mock embedder, 用 1024 维控制向量 (跟 dedup.test.ts 一致)。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/dedup-threshold.test.ts` 全 4 个 case pass
  - **依赖**: 1.1

- [ ] 1.3 **dedup.test.ts 更新现有 case 适配 0.65 阈值**
  - **文件**: `extensions/personal-assistant/test/dedup.test.ts` (Modify)
  - **内容**: 现有 5 个 it() 中, 显式传 `0.92` 的 case 改为传 `0.65` (确保测原 0.65 行为); 用 `// @ts-expect-error` 或显式调用,保证不传 threshold 时也走 0.65。test header 注释 (line 10 提的 "0.92" 改为 "0.65")。任一 case 失败则读原 test 看 context 调整。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/dedup.test.ts` 全 5 个 case pass
  - **依赖**: 1.1

## 2. 目标 1: Migration 脚本 (程序驱动 0.65 dedup, 无 LLM)

- [ ] 2.1 **storage.ts 新加 markSupersededNoInsert helper**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify, 在 `markSupersededTx` 之后追加)
  - **内容**: 公开方法 `markSupersededNoInsert(oldId: string, parentId: string, now: number): MemoryAtom`。**只** UPDATE `memory_index` SET `is_latest=0, parent_id=?, superseded_at=?` WHERE id=?,**不** INSERT 新 row, **不** 改 vector (content 没变, vector 仍正确)。返回被改的旧 atom (getAtom 重读)。**不要**包 transaction,单个 UPDATE 即可 (并发安全: better-sqlite3 串行化)。**关键**: parentId 是"赢" atom 的 id (新规则 — 旧 atom 的 parent_id 指向保留方)。
  - **验证**: `cd extensions/personal-assistant && grep -n "markSupersededNoInsert" storage.ts` 找到 1 行定义
  - **依赖**: 1.1

- [ ] 2.2 **markSupersededNoInsert 单元测试**
  - **文件**: `extensions/personal-assistant/test/migration.test.ts` (Create, 但本 task 只测 helper)
  - **内容**: 在真实 MemoryIndex 上插入 atom A, B; 调 `markSupersededNoInsert(B.id, A.id, now)`, 断言: (a) B 的 is_latest=0, parent_id=A.id, superseded_at=now; (b) A 不变; (c) memory_vectors 表 B 的 vector 仍存在 (没动); (d) A,B 都还能 getAtom (B is_latest=0 但 row 还在)。3 个 it()。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/migration.test.ts` 3 个 case pass
  - **依赖**: 2.1

- [ ] 2.3 **scripts/migrate-legacy-atoms.mts 脚本主体**
  - **文件**: `extensions/personal-assistant/scripts/migrate-legacy-atoms.mts` (Create)
  - **内容**: 单文件 `#!/usr/bin/env tsx` 入口; `import { MemoryIndex } from "../storage.ts"`; 主函数 `main()`: (1) `loadConfig()` 读 `dbPath`/`atomsDir`, 兜底用 `DEFAULT_DB_PATH`/`DEFAULT_ATOMS_DIR` (from memory.ts:92,95); (2) 备份 `cp dbPath dbPath+".bak."+YYYYMMDD`, 失败 throw "backup failed, refusing to migrate"; (3) `new MemoryIndex(dbPath)` + `init()`; (4) `const active = index.getActiveAtoms()`; (5) SQL 直接排序 (避免 JS in-memory sort): `db.prepare("SELECT * FROM memory_index WHERE is_latest=1 AND archived=0 ORDER BY access_count DESC, COALESCE(last_access, 0) DESC, created_at DESC")`; (6) for loop: 从 `memory_vectors` 读 embedding (新 helper `getEmbedding(id)`, 在 storage.ts 加, 见 2.4), 调 `index.findMostSimilarEmbedding(emb, 0.65)`, 若是 hit 且 hit.id !== atom.id 调 `index.markSupersededNoInsert(hit.id, atom.id, Date.now())`; (7) 写 `migrate-report.json` (`{timestamp, totalActiveAtoms, archivedCount, unchangedCount, backupPath, threshold: 0.65}`); (8) close index, 打印 summary; (9) wrap try/finally 关闭 index。**支持** CLI `--threshold=N` (用 `process.argv` 解析), 默认 0.65。
  - **验证**: `cd extensions/personal-assistant && npx tsx scripts/migrate-legacy-atoms.mts --help` 打印 usage (脚本用 if (process.argv.includes("--help")) printUsage(); return)
  - **依赖**: 2.1

- [ ] 2.4 **storage.ts 加 getEmbedding helper**
  - **文件**: `extensions/personal-assistant/storage.ts` (Modify, 在 `getAtom` 附近追加)
  - **内容**: `getEmbedding(id: string): number[] | null` — 从 `memory_vectors` 表 SELECT embedding WHERE id=?,返回 number[] (用 `Float32Array.from` 转换) 或 null (无 row)。SQLite-vec 列是 BLOB, 直接 fetchall。
  - **验证**: `cd extensions/personal-assistant && grep -n "getEmbedding" storage.ts` 找到 1 行定义
  - **依赖**: 1.1 (无 markSupersededNoInsert 依赖, 可与 2.1 并行)

- [ ] 2.5 **migration 集成测试 (含 idempotency)**
  - **文件**: `extensions/personal-assistant/test/migration.test.ts` (Modify, 追加到 2.2 之后)
  - **内容**: 用 tmpdir 真实 MemoryIndex, 插入 90 个 atom (fixture 用 5-10 个真实 cluster pair + 1-2 个异类即可,不需要 90 个); 跑 `migrate-legacy-atoms.mts` (用 child_process.spawnSync + tsx); 断言: (a) backup 文件存在; (b) active atom 数减少 ≥ 17%; (c) 二次跑, 改动数 = 0; (d) 二进制 idempotent (重跑 0 个 markSupersededNoInsert 调用, 0 个 reindex); (e) 手动 spot-check 1-2 个 archived atom 的"赢"是否合理 (access_count 更高)。3-5 个 it()。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/migration.test.ts` 全 5+ case pass
  - **依赖**: 2.3, 2.4

## 3. 目标 2: Extract Pipeline 优化 (LLM 二次确认 dedup + tag 字典 + tag 归一化)

- [ ] 3.1 **tag-vocab.ts 新文件: loadTagVocabulary + normalizeTag + conceptTagCount**
  - **文件**: `extensions/personal-assistant/tag-vocab.ts` (Create)
  - **内容**: 3 个 export 函数: (a) `loadTagVocabulary(index: MemoryIndex, topK = 50): string[]` — 扫 `index.getActiveAtoms()`, 收集所有 tags (JSON.parse `tags` 列 → string[]), 频次统计, sort by count DESC, 取 top K; (b) `normalizeTag(input: string, dictionary?: Set<string>): string` — trim + 字典精确匹配优先; 字典命中 → 用字典标准形 (e.g. "Amplicon" 命中 "amplicon"); 不命中 → lowercase (用 Unicode range 检测, 中文不变: `/[\u4e00-\u9fff]/` 跳过 lowercase); 空串返回空串; (c) `conceptTagCount(tags: string[]): number` — 计数 `tags.filter(t => t.startsWith("concept/")).length`。**纯函数, 无副作用**。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/tag-vocab.test.ts` 全 case pass (test 文件在 3.2 task 创建)
  - **依赖**: 无

- [ ] 3.2 **tag-vocab 单元测试**
  - **文件**: `extensions/personal-assistant/test/tag-vocab.test.ts` (Create)
  - **内容**: describe `loadTagVocabulary`: (a) 空 corpus → []; (b) 5 atom 各有 ["amplicon", "16S"], 2 atom 各有 ["amplicon", "修复"] → top 2 = ["amplicon" (7), "16S" (5)]; describe `normalizeTag`: (c) "Amplicon" + 字典含 "amplicon" → "amplicon"; (d) "MGM" + 字典含 "MGM" → "MGM" (不强制 lowercase); (e) "amplicon" 无字典 → "amplicon"; (f) "扩增子" 无字典 → "扩增子" (中文不变); (g) "" → ""; (h) "  amplicon  " → "amplicon" (trim); describe `conceptTagCount`: (i) ["concept/fix", "amplicon"] → 1; (j) ["amplicon", "16S"] → 0; (k) [] → 0。共 10+ 个 it()。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/tag-vocab.test.ts` 全 case pass
  - **依赖**: 3.1

- [ ] 3.3 **EXTRACT_PROMPT_V2 追加 "## 主动更新,非扩张" 段**
  - **文件**: `extensions/personal-assistant/extraction.ts:42-106` (Modify, 在 EXTRACT_PROMPT_V2 字符串末尾追加)
  - **内容**: 在 EXTRACT_PROMPT_V2 模板字符串的 `## Output Schema` 段**之前**插入:
  ```
  ## 主动更新,非扩张 (重要!)
  
  - 如果新信息可归入 corpus 已有的 atom (主题/对象/项目相同), 优先更新该 atom 的 content, 不要为这条信息创建新 atom
  - 更新方式: 在 content 末尾追加新段落, 标注日期 (e.g. "2026-07 新增 JSON 格式支持")
  - 仅在信息属于全新主题/新对象/新项目时才创建新 atom
  - 这是 corpus 持续精炼的关键: 主动合并而非堆叠
  ```
  注意: 不破坏现有 prompt 结构,只追加段。
  - **验证**: `grep -n "主动更新,非扩张" extensions/personal-assistant/extraction.ts` 找到 ≥ 1 行
  - **依赖**: 无

- [ ] 3.4 **buildExtractionPrompt 改造: 加 tagVocabulary opts 参数**
  - **文件**: `extensions/personal-assistant/extraction.ts:287-294` (Modify)
  - **内容**: 签名改 `buildExtractionPrompt(messages, opts?: { tagVocabulary?: string[] }): string`。在 EXTRACT_PROMPT_V2 拼接后, `toneHint` 之前,插入条件段:
  ```typescript
  const tagDictSection = opts?.tagVocabulary && opts.tagVocabulary.length > 0
    ? `\n\n## 现有 tag 字典 (优先复用, 不要发明新近义 tag)\n${opts.tagVocabulary.join(", ")}`
    : "";
  return `${EXTRACT_PROMPT_V2}${tagDictSection}\n\n${toneHint}## Messages\n\n${messagesText}\n\n## Output (JSON only)`;
  ```
  关键: 字典为空时**不**注入 "## 现有 tag 字典" 段 (避免给 LLM 假信号)。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction-prompt.test.ts` 原 case 仍 pass + 新 case (传 tagVocabulary 后输出含字典) pass
  - **依赖**: 3.1, 3.3

- [ ] 3.5 **memory.ts 调 buildExtractionPrompt 时传 tagVocabulary**
  - **文件**: `extensions/personal-assistant/memory.ts:448-457` (Modify)
  - **内容**: 在 `extractMemoriesWithCallLlm(callLlm, messages, index, { atomsDir, model: ... })` 调用前, 加:
  ```typescript
  const tagVocabulary = loadTagVocabulary(index, 50);
  const result = await extractMemoriesWithCallLlm(callLlm, messages, index, {
    atomsDir,
    model: `${extractionCfg.provider}/${extractionCfg.model}`,
    tagVocabulary,
  });
  ```
  `extractMemoriesWithCallLlm` 的 opts 类型加 `tagVocabulary?: string[]` 字段(见 3.6)。`loadTagVocabulary` import 从 tag-vocab.ts。
  - **验证**: `cd extensions/personal-assistant && grep -n "loadTagVocabulary" memory.ts` 找到 ≥ 1 行
  - **依赖**: 3.4

- [ ] 3.6 **extractMemoriesWithCallLlm 签名扩展 (加 tagVocabulary)**
  - **文件**: `extensions/personal-assistant/extraction.ts:341-356` (Modify)
  - **内容**: 函数 `extractMemoriesWithCallLlm` 的 `config` 参数加字段 `tagVocabulary?: string[]`; 在 `buildExtractionPrompt(messages)` 调用处改为 `buildExtractionPrompt(messages, { tagVocabulary: config.tagVocabulary })`。`RunMemoryExtractionOptions` 同步加字段(若 webui 也用此接口)。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction.test.ts` 既有 case pass
  - **依赖**: 3.4

- [ ] 3.7 **executeItem 改造: 加 normalizeTag + 概念性 tag 检测 + cosine 命中分支**
  - **文件**: `extensions/personal-assistant/extraction.ts:123-149` (Modify)
  - **内容**: 改 `executeItem` 函数。完整新逻辑:
  1. **指纹 dedup (既有)**: `computeFingerprint` + `getActiveAtomByFingerprint` → skip
  2. **新增: tag 归一化 + 概念性 tag 检测**: 在 buildAtomFromItem 之前加:
     ```typescript
     const normalizedTags = item.tags.map(t => normalizeTag(t));  // 字典从 index.tags 历史统计注入,本期不传 dict
     const conceptCount = conceptTagCount(normalizedTags);
     if (conceptCount === 0) {
       console.warn(`[extract] item "${item.title}" lacks concept tag (0/${normalizedTags.length} tags are concept/*)`);
     }
     const itemWithNormTags = { ...item, tags: normalizedTags };
     ```
  3. **cosine 命中 + LLM 二次确认 (新核心)**: 把现有 `supersedeIfSimilar(index, atomsDir, newAtom, embedding)` 调用拆开:
     - 算 embedding (既有)
     - `const similar = embedding ? index.findMostSimilarEmbedding(embedding, 0.65) : null`
     - **若** similar && similar.atom.id !== newAtom.id && similar.cosine >= 0.65:
       - 调 `confirmDedupAction(callLlm, similar.atom, itemWithNormTags)` (新函数, 见 3.8)
       - 根据返回的 action 走不同路径:
         - `"update"`: 拿 merged 调 `index.updateAtom(merged, embedding)` + `writeAtomToFile(merged, atomsDir)` (这里需要 bge-m3 reindex — 走 HTTP,见 3.9)
         - `"supersede"`: 调 `index.markSupersededTx(similar.atom.id, newAtom, embedding)` + `writeAtomToFile(finalNew, atomsDir)` (既有 path)
         - `"create"`: 走 `index.insertAtom(newAtom, vector)` + `writeAtomToFile` (既有 path)
         - `"skip"`: 返回 `{ status: "skip", atom: similar.atom }` (新 status, 已有 skip 字段)
     - **否则** (no similar or self-match): 走既有 `supersedeIfSimilar` (create path) — 但因为改完不再调 `supersedeIfSimilar`(它内部有重复工作), 直接 `index.insertAtom(newAtom, vector)` + `writeAtomToFile`
  - **关键约束**:
    - **不传 callLlm 到 executeItem 当前签名**, 需要扩展 (executeItem 加 `callLlm` 参数, 或新建内部函数)
    - 由于 `executePlan` 调 `executeItem`, 需要把 callLlm 透传: `executePlan(index, atomsDir, plan, callLlm?)` 新参数, 透传到 executeItem
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction-dedup-confirm.test.ts` 5 个边界 case pass (test 文件 3.10 task 创建)
  - **依赖**: 3.1, 3.5, 3.6, 3.8

- [ ] 3.8 **confirmDedupAction 函数: LLM 二次确认 (新核心)**
  - **文件**: `extensions/personal-assistant/extraction.ts` (Modify, 在 `executeItem` 之后追加, 或放新文件 `extraction-dedup-confirm.ts`)
  - **内容**: 导出函数 `confirmDedupAction(callLlm, hitAtom: MemoryAtom, newItem: ExtractionItem): Promise<{ action: "update" | "supersede" | "create" | "skip", merged?: { title: string; summary: string; content: string; tags: string[] } }>`。完整实现:
  1. 构造 prompt (DEDUP_CONFIRM_PROMPT 字符串, ~300 字):
     ```
     你是 memory dedup agent。判断"新信息"和"已有 atom"的关系, 决定如何处理。
     
     ## 已有 atom (cosine {cosine} 命中)
     标题: {hitAtom.title}
     摘要: {hitAtom.summary}
     内容: {hitAtom.content}
     Tags: {hitAtom.tags.join(", ")}
     
     ## 新信息
     标题: {newItem.title}
     摘要: {newItem.summary}
     内容: {newItem.content}
     Tags: {newItem.tags.join(", ")}
     
     ## 决策选项
     - update: 新信息可归入已有 atom (同主题/同对象), 在末尾追加 + 标日期
     - supersede: 新信息与已有 atom 几乎完全相同, 标 archive + 创建新 atom
     - create: 新信息主题与已有 atom 不同, 应该独立 (忽略 hit, 正常创建)
     - skip: 完全重复, 啥也不做
     
     ## 输出 (JSON only)
     {"action": "update|supersede|create|skip", "merged"?: {"title": "...", "summary": "...", "content": "...", "tags": [...]}}
     ```
  2. 调 `callLlm(prompt)` (5s timeout — 失败 throw 触发 fallback)
  3. 解析 JSON: `try { JSON.parse(response) } catch { throw new Error("non-JSON") }`
  4. Zod validate 决策 schema
  5. 返回 `{ action, merged }`
  
  **Fallback (调用方处理)**: 若 throw (timeout / JSON parse / validation fail), executeItem 走保守 `"supersede"` (程序认定的重复) + warn "LLM dedup confirm failed for item X (hit Y), fell back to supersede"
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction-dedup-confirm.test.ts` mock callLlm 验证 4 个 action + fallback
  - **依赖**: 3.1 (用 normalizeTag)

- [ ] 3.9 **bge-m3 reindex_one HTTP 客户端 (新文件)**
  - **文件**: `extensions/personal-assistant/scripts/reindex-one.mts` (Create) **或** 新加 `extensions/personal-assistant/bge-reindex.ts`
  - **内容**: 导出函数 `reindexOne(atomId: string, baseUrl = "http://127.0.0.1:11435"): Promise<{ ok: boolean; error?: string }>`。POST `${baseUrl}/api/atoms/${atomId}/reindex`, 5s timeout (AbortController), 失败返回 `{ ok: false, error: "..." }`, 不 throw。
  - **验证**: `cd extensions/personal-assistant && grep -n "reindexOne" bge-reindex.ts` 找到定义
  - **依赖**: 无

- [ ] 3.10 **extraction-dedup-confirm.test.ts 新文件: 5 个边界 case + tag 归一化**
  - **文件**: `extensions/personal-assistant/test/extraction-dedup-confirm.test.ts` (Create)
  - **内容**: describe "executeItem cosine 命中 + LLM 二次确认" — 5 个 it():
  - (a) cosine 0.65+ 命中 + LLM 返回 `update` → 旧 atom 字段更新, version+1 (mock `index.updateAtom` 验证调用)
  - (b) cosine 0.65+ 命中 + LLM 返回 `supersede` → 旧 atom 标 archived, 新 atom 独立 (mock `index.markSupersededTx` 验证调用)
  - (c) cosine 0.65+ 命中 + LLM 返回 `create` → 旧 atom 不动, 新 atom 独立 (mock `index.insertAtom` 验证调用)
  - (d) cosine 0.65+ 命中 + LLM 返回 `skip` → 旧 atom 不动, 新 item 丢弃 (断言: `result.status === "skip"`, 0 个 insert/update/markSuperseded 调用)
  - (e) cosine 0.65+ 命中 + LLM call timeout → 走 fallback `supersede` + warn (mock callLlm 抛 AbortError, 断言 markSupersededTx 被调)
  
  describe "executeItem cosine 不命中" — 1 个 it():
  - (f) cosine < 0.65 无二次 LLM, 直接 insert (mock callLlm, 断言 callLlm 0 次调用)
  
  describe "executeItem tag 归一化" — 3 个 it():
  - (g) LLM emit ["Amplicon", "16S"] → normalize 后 ["amplicon", "16s"]
  - (h) LLM emit ["Amplicon", "16S"] + 字典含 "MGM" → 输出不含字典干扰, 只做大小写归一
  - (i) LLM emit 0 概念性 tag → warn 但仍 insert (mock spy on console.warn)
  
  describe "buildExtractionPrompt tag 字典注入" — 2 个 it():
  - (j) opts.tagVocabulary = ["amplicon", "16S"] → 输出含 "## 现有 tag 字典" 段 + 字典内容
  - (k) opts.tagVocabulary = [] 或 undefined → 输出不含字典段
  
  describe "confirmDedupAction LLM 输出解析" — 3 个 it():
  - (l) valid JSON `{action: "update", merged: {...}}` → 解析成功
  - (m) invalid JSON → throw "non-JSON"
  - (n) valid JSON but wrong schema (action 不是 4 个之一) → throw validation fail
  
  共 14+ 个 it()。Mock pattern: 用 vitest `vi.fn()` 替换 `index.findMostSimilarEmbedding` / `index.updateAtom` / `index.markSupersededTx` / `index.insertAtom` / `callLlm`。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction-dedup-confirm.test.ts` 全 case pass
  - **依赖**: 3.7, 3.8

- [ ] 3.11 **executePlan 透传 callLlm 到 executeItem**
  - **文件**: `extensions/personal-assistant/extraction.ts:189-214` (Modify)
  - **内容**: `executePlan` 加 `callLlm?: (prompt: string) => Promise<string>` 参数 (向后兼容, undefined 时不传 executeItem 二次确认逻辑)。在 `for` loop 调 executeItem 时把 callLlm 透传:`executeItem(index, atomsDir, planItem.item, callLlm)`。同步更新 `executeParsedPlan` (line 304+) 调 `executePlan` 处, 把 extractMemoriesWithCallLlm 的 callLlm 传入 (已有)。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction.test.ts` 既有 case pass (callLlm 可选, 老 case 不传也能跑)
  - **依赖**: 3.7

- [ ] 3.12 **recall-quality test: precision@5 验证 (目标 1 验证)**
  - **文件**: `extensions/personal-assistant/test/recall-quality.test.ts` (Modify, 新加 case; 或新建 `test/recall-quality.test.ts`)
  - **内容**: 用真实 90 atom corpus (备份到 test/fixtures/memory-90.db): 跑 (a) baseline (无 dedup) precision@5; (b) 跑 migration 脚本 (调 child_process.spawnSync); (c) 重跑同一 query, precision@5 ≥ 40%。10 个 query case, 跑 5 个真相关 query 验证。用户原 case "修复的脚本和修复逻辑给我" 包含在内。3 个 it()。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-quality.test.ts` precision assertion pass
  - **依赖**: 2.5

- [ ] 3.13 **CHANGELOG 更新**
  - **文件**: `extensions/personal-assistant/CHANGELOG.md` (Modify)
  - **内容**: 在 `## [Unreleased]` 下追加:
  ```
  ### Added
  - Migration script `migrate-legacy-atoms.mts` for one-time 0.65-cosine dedup of legacy atoms (idempotent, 天然 — re-run shows 0 changes).
  - Extract pipeline LLM 二次确认 dedup: cosine ≥ 0.65 命中时调 LLM 判定 update/supersede/create/skip, 防止 future redundancy.
  - `tag-vocab.ts`: tag 字典加载 + 归一化 + 概念性 tag 计数, 注入到 `EXTRACT_PROMPT_V2` 顶部.

  ### Changed
  - `supersedeIfSimilar` default threshold 0.92 → 0.65 (matches recall floor 0.55 + 0.10 buffer, 90 atom sweep showed 0 false positives).
  - `EXTRACT_PROMPT_V2` adds "## 主动更新,非扩张" 段 instructing LLM to update existing atoms when possible.
  - `executeItem` adds normalizeTag + conceptTagCount guard + LLM 二次确认 dedup on cosine ≥ 0.65 hit.
  ```
  格式跟现有 CHANGELOG 风格一致 (revert 0.60→0.55 entry 保留, 见 [Unreleased] 已存在的 decay + search entries)。
  - **验证**: `cd extensions/personal-assistant && head -50 CHANGELOG.md` 应看到 [Unreleased] 下新 entries
  - **依赖**: 1.1, 3.7, 3.8 (主要实现完才能写 changelog)

## 4. 文档与验证 (Verification & Docs)

- [ ] 4.1 **运行 npm run check (全量 lint + typecheck)**
  - **文件**: 无 (验证任务)
  - **内容**: 从 repo 根跑 `npm run check`, 确认 0 error / 0 warning / 0 info。涉及的所有新文件 (tag-vocab.ts, scripts/migrate-legacy-atoms.mts, bge-reindex.ts) 都通过 tsgo 检查。
  - **验证**: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | tail -20` 输出末尾有 "0 errors, 0 warnings, 0 infos" 类信息
  - **依赖**: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13

- [ ] 4.2 **跑 test.sh (目标 1+2 全量单元 + 集成测试)**
  - **文件**: 无 (验证任务)
  - **内容**: 从 repo 根跑 `./test.sh`, 确认所有 extensions/personal-assistant/test/*.test.ts 全部 pass (除预存在的 search.test.ts mock issue)。特别检查新增的: dedup-threshold.test.ts, migration.test.ts, tag-vocab.test.ts, extraction-dedup-confirm.test.ts。
  - **验证**: `cd /home/qjh/workspace/personal/pi && bash test.sh 2>&1 | tail -20` 输出末尾 "0 failed"
  - **依赖**: 4.1

- [ ] 4.3 **手动 smoke test migration script (真实 corpus)**
  - **文件**: 无 (验证任务)
  - **内容**: 在 real 90 atom corpus (备份 `/home/qjh/.pi/agent/memory/memory.db` → `/tmp/memory-pre-migration.db`) 跑:
  1. `cd extensions/personal-assistant && npx tsx scripts/migrate-legacy-atoms.mts`
  2. 验证 `cat scripts/migrate-report.json` 看到 archivedCount ≥ 15
  3. 跑 `webui` 召回用户原 case "修复的脚本和修复逻辑给我" → top-5 至少 2 个真相关
  4. 二次跑同脚本 → archivedCount 增量 = 0
  5. 回滚: `cp /tmp/memory-pre-migration.db /home/qjh/.pi/agent/memory/memory.db` + 重启 bge-m3
  - **验证**: smoke test 4 步全部成功
  - **依赖**: 2.5, 3.12

## Verification

- [ ] 全量测试: `cd /home/qjh/workspace/personal/pi && bash test.sh 2>&1 | tail -20` (目标: "0 failed")
- [ ] Lint: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | tail -20` (目标: 0 error/warning/info)
- [ ] Migration script: `cd extensions/personal-assistant && npx tsx scripts/migrate-legacy-atoms.mts` 输出 "archived N atoms"
- [ ] Idempotency: 同命令二次跑 "0 changes"
- [ ] Recall quality: webui 跑 "修复的脚本和修复逻辑给我" → top-5 precision ≥ 40%
- [ ] LLM dedup confirm: 跑 1 次真实 extract, 检查 extraction-report.json 看到 "dedup-confirm: update" 或 "supersede" 路径
