# Design: atom-remigrate

## Context

Personal-assistant 记忆系统当前有 90 个 active atom,典型问题:
- **冗余**: 至少 9 个 cluster 重复 (扩增子/iCAMP/check_seq/RNAVIRUS-DELIVERY-CHECK/smart-sample-find/workMonitor/X101SC26052587/README 各 2-3 个)
- **内容过短**: avg content 199/244/134 字 (fact/process/rule),LLM 召回后只看 summary,大量上下文丢失
- **召回假阳性高**: 用户原 case "修复的脚本和修复逻辑给我" 召回 8 个里 6 个无关 (precision 25%)
- **tag 体系无序**: 90 个 atom 产生 350 unique tag,平均每 tag 出现 1.1 次,基本无召回报警作用

根因不是召回算法 (bge-m3 dense+sparse RRF 是合理的),而是 **atom 文本结构缺乏信号 + extract pipeline 不防止冗余**:

1. title/summary 是自然语言,bge-m3 在 1024 维语义空间里把"修复的脚本"和"脚本位置"算成 0.55 cosine — 0.02 的距离 bge-m3 学到的就是"接近"
2. `EXTRACT_PROMPT_V2` 对 tag 无一致性约束,对"新建 vs 更新"无指导
3. `executeItem` 只有 fingerprint + 0.92 cosine dedup,程序层无法阻止 LLM 持续 emit 相似但 fingerprint 不同的新 atom

召回策略零改动是用户明确要求。本次变更分两路:
- **目标 1 (历史治理)**: 一次性 LLM 批处理 90 个老 atom,只合并不扩张,改完触发 bge-m3 reindex
- **目标 2 (未来预防)**: 改 `EXTRACT_PROMPT_V2`,注入 tag 字典 + 主动更新规则,让 LLM 看到现有 tag 后优先复用、看到可合并的现有 atom 后优先更新

## Goals / Non-Goals

### Goals
**目标 1 (历史治理)**:
- 90 个 active atom 一次性 LLM 批处理,合并冗余 cluster
- 合并后 atom 数量减少 ≥ 20% (90 → ≤ 72)
- id 全保留 (外部引用不破),version +1,updated_at 更新
- bge-m3 向量 reindex 同步
- 可回滚 (迁移前 backup)
- 脚本 idempotent (二次运行检测到 v2 标记就跳过)

**目标 2 (未来预防)**:
- `EXTRACT_PROMPT_V2` 注入 top-50 高频 tag 字典
- `EXTRACT_PROMPT_V2` 添加"主动更新,非扩张"规则
- 程序端 tag 大小写归一 (lowercase, 中文不变)
- 程序端概念性 tag 缺失时 warn
- 新会话 30 天后 corpus tag 重复率 ≥ 2.0 (字典成体系)

### Non-Goals
- 不改召回策略 (search.ts / format.ts / hybrid-search.ts / server.py 全部零改动)
- **不扩张 atom content 长度** (用户明确: 无须扩张新atom)。合并 cluster 后内容可短可长,只看 LLM 自然判断
- 不改 decay / strength / access_count 字段
- 不删 atom (LLM 决定保留就保留)
- 不改 schema (0 列变化)
- 不重建 bge-m3 全量索引 (只对改动的 atom 调 `reindex_one`)
- 不动 webui (UI 自然显示新文本)
- 不回填 source_session (那是另一个 change)
- 不引入 tag 同义词 LLM 自动聚类 (那是另一个独立 change,本次只用字符串归一)

## Decisions

### 1. 合并判定完全交给 LLM (不做 cosine 聚类)
**Decision**: 5 个 batch × 18 atom,每个 batch 一次 LLM 调用,LLM 自己判断哪些 atom 该合并。
**Rationale**: bge-m3 cosine ≥ 0.85 阈值难以选,主题级重复 (check_seq 脚本位置 + check_seq update-seq) cosine 可能 0.7 但语义高度相关。LLM 看完整 title/summary/content 后判断更可靠。
**Alternatives**:
- *Cosine 阈值聚类 + LLM 确认*: 拒。多一层聚类,阈值敏感,工程量翻倍
- *手工 merge list*: 拒。不可扩展,90 个 atom 用户得手动分半天

### 2. 合并后用 supersede 链,新 atom 替代多个旧 atom
**Decision**: LLM 决定 cluster 后,生成 1 个新 atom (复用原 cluster 中某个 id),其他 atom 标 is_latest=0、parent_id 指向新 atom。
**Rationale**: 保留历史,审计可追溯;外部引用 (webui atom URL、tool_result 访问记录) 只要不指向被 supersede 的,继续可用。
**Alternatives**:
- *in-place 改每个被合并 atom (1 个变 N 份)*: 拒,会出现多个相同 id 的伪 atom
- *删旧建新 (id 重生)*: 拒,破坏外部引用,审计断裂

### 3. 迁移 LLM prompt 复用 extract 入口,不引新 prompt
**Decision**: 复用 `extractMemoriesWithCallLlm` 的 LLM call 路径,只把 conversation 文本替换成"90 个 atom 的 title+summary+content 序列化"。**不**改 EXTRACT_PROMPT_V2。
**Rationale**: 改 prompt 是另一个独立 change (目标 2 是 extract 优化,但**优化的是 EXTRACT_PROMPT_V2**,不是 migration prompt),不能借这次 migration 暗改 LLM 行为,导致 audit 难。
**Alternatives**:
- *写专用 migrate prompt*: 拒。短期看更精准,长期维护两份 prompt 容易漂移
- *沿用 extract prompt + 额外 instructions*: 可接受,但 prompt 越长 LLM 越不稳

### 4. bge-m3 reindex 走现有 HTTP endpoint,失败 warn 不中断
**Decision**: 改完一个 atom,POST `http://127.0.0.1:11435/api/atoms/{id}/reindex`,失败 (5xx / timeout 5s) warn + 继续。
**Rationale**: bge-m3 service 临时不可用不应该阻塞整次迁移 (90 个 atom 改完,reindex 失败 1-2 个影响小)。
**Alternatives**:
- *失败就 abort 全 rollback*: 拒。一次网络抖动 rollback 90 个 atom 改动不划算
- *失败用旧向量不 warn*: 拒,用户不知道哪些 atom 是 stale

### 5. 备份 memory.db 全量到 memory.db.bak.YYYYMMDD
**Decision**: 迁移前 `cp memory.db memory.db.bak.YYYYMMDD`,出错用户可手动 cp 回滚。
**Rationale**: 90 个 atom in-place 改没有自动回滚机制,DB 备份是最简单的。
**Alternatives**:
- *git 跟踪 memory.db*: 拒,memory.db 应该在 .gitignore
- *每 atom 改前导出 JSON*: 拒,4MB DB 直接 cp 更快

### 6. 不引入新工具/新依赖
**Decision**: 脚本用 Node + `tsx` (项目已有),HTTP 用 `fetch` (Node 20+ 内置)。不引第三方 LLM client (复用 `completeSimple` from `@earendil-works/pi-ai/compat`)。
**Rationale**: 保持依赖最小,migration 是临时脚本,3 个月后可能不再用。

### 7. (目标 2) tag 字典注入到 extract prompt,in-memory 缓存
**Decision**: 启动时扫 corpus 全 active atom 的 tags 列,统计频次,取 top-50,缓存 in-memory。`buildExtractionPrompt` 调用时把字典注入到 EXTRACT_PROMPT_V2 之后,作为 "## 现有 tag 字典" 段。
**Rationale**: 让 LLM 看到 corpus 现有 tag,优先复用而非发明新近义 tag,从根本上减少 tag 体系无序化。
**Alternatives**:
- *不做字典,让 LLM 自由 emit + 程序端 LLM 二次聚类*: 拒。二次聚类是另一个 change,工程量大
- *字典写进 EXTRACT_PROMPT_V2 静态文本*: 拒。不同用户的 corpus tag 体系不同,字典必须 per-corpus

### 8. (目标 2) 主动更新规则注入到 extract prompt
**Decision**: EXTRACT_PROMPT_V2 新增一段 "## 主动更新,非扩张" 规则,告诉 LLM:
```
- 如果新信息可归入 corpus 已有的 atom (主题/对象/项目相同),优先更新该 atom 的 content,
  不要为这条信息创建新 atom
- 更新方式: 在 content 末尾追加新段落,标注日期
- 仅在信息确实属于新主题/新对象时才创建新 atom
```
**Rationale**: LLM 默认倾向"为每条新信息创建 atom" (因为 LLM 不知道 corpus 现有内容),明确告诉它"先查现有再决定 create"是低成本高收益的引导。
**Alternatives**:
- *完全靠程序端 dedup 兜底*: 现有 0.92 cosine dedup 已存在,但 fingerprint 不同会绕过。"扩增子物种注释结果文件" 和 "扩增子物种注释结果文件路径" 的 fingerprint 不同 (字符串差一字),但语义几乎相同,程序兜不住
- *在 extract pipeline 加 RAG lookup*: 工程量中等 (每次 extract 前查 corpus),LLM 主动看 top-N atom。短期不做,留作未来 change

### 9. (目标 2) 程序端 tag 归一化兜底
**Decision**: `executeItem` 写入前对 LLM emit 的 tags 做归一化:
- lowercase (中文不变,用 Unicode 范围检测)
- 跟 tag 字典做精确匹配,命中的用字典标准形
- 检测概念性 tag 缺失 (0 个 tag 命中 `concept/*` 命名空间): warn + 仍写入 (不强 reject)
**Rationale**: LLM 99% 守规矩但 1% 会 emit 大写或新造 tag,程序兜底保证 corpus 干净。强 reject 会丢失 LLM 偶尔的好 extract。
**Alternatives**:
- *概念性 tag 缺失就 reject 整个 item*: 拒,丢失数据代价大于 tag 质量
- *不做归一化,完全信 LLM*: 拒,LLM 幻觉/大小写漂移不可避免

## Architecture

### 文件改动

| 文件 | 改动 |
|------|------|
| `extensions/personal-assistant/scripts/migrate-legacy-atoms.mts` | **新文件**,目标 1 一次性 migration 脚本 |
| `extensions/personal-assistant/scripts/migrate-report.json` | 运行时生成,迁移结果 (cluster 列表,reindex 失败列表) |
| `extensions/personal-assistant/extraction.ts` | **目标 2**: `EXTRACT_PROMPT_V2` 注入 tag 字典 + 主动更新规则;`buildExtractionPrompt` 构造 tag 字典段 |
| `extensions/personal-assistant/tag-vocab.ts` | **新文件**,目标 2: `loadTagVocabulary(index)` + `normalizeTag(input)` + `conceptTagCount(tags)` |
| `extensions/personal-assistant/CHANGELOG.md` | 加 [Unreleased] entry 说明 migration 工具存在 + extract 优化 |

**不动**: storage.ts, dedup.ts, file-store.ts, search.ts, format.ts, hybrid-search.ts, types.ts, memory.ts, decay.ts, embed.ts, server.py

### 数据流 (目标 1: 迁移)

```
migrate-legacy-atoms.mts (entry)
  │
  ├── 0. 备份 memory.db → memory.db.bak.YYYYMMDD
  │
  ├── 1. 读 MemoryIndex.getActiveAtoms() → 90 atom
  │
  ├── 2. 分 5 个 batch (每批 18 atom),每个 batch:
  │   │
  │   ├── 2a. 序列化 batch 为 prompt:
  │   │     ```
  │   │     以下是 N 个 atom,每个有 id/title/summary/content/tags.
  │   │     任务: 决定合并 cluster,每个 cluster 生成 1 个新 atom (id 选 cluster 第一个).
  │   │     合并后 content 自然保留所有原 atom 关键信息,不必刻意加长.
  │   │     返回 JSON: { clusters: [{ keepId, mergedFields: {title,summary,content,tags}, supersededIds: [id1,id2] }], standalone: [{ id, fields }] }
  │   │     ```
  │   │
  │   ├── 2b. 调 LLM (复用 ctx.modelRegistry.getApiKeyAndHeaders + completeSimple),重试 3 次
  │   │
  │   └── 2c. 对 LLM 返回的每个 cluster / standalone:
  │       ├── 调 index.updateAtom(mergedAtom)  (id 保留,version 自动 +1)
  │       ├── 重算 content_fingerprint (computeFingerprint)
  │       ├── 调 writeAtomToFile 更新 .md 文件
  │       └── 对 supersededIds 调 index.markSupersededTx 链 (parent_id 指 keepId,is_latest=0)
  │
  ├── 3. 对所有改动的 atom (keepId + standalone + merged),并发触发 bge-m3 /api/atoms/{id}/reindex (失败 warn)
  │
  └── 4. 输出 migrate-report.json + stdout 统计
```

### 数据流 (目标 2: Extract 优化)

```
session_before_compact (or any extract trigger)
  │
  ├── loadTagVocabulary(index)  // 扫 active atom.tags 列,top-50 by 频次
  │   → ["amplicon", "16S", "扩增子", "修复", "bug", ...] (cached in-memory)
  │
  ├── buildExtractionPrompt(messages)
  │   在 EXTRACT_PROMPT_V2 之后追加:
  │     "## 现有 tag 字典 (优先复用,不要发明新近义 tag)\n" + tagVocabulary.join(", ")
  │     "\n\n## 主动更新,非扩张\n"
  │     "- 如果新信息可归入 corpus 已有的 atom,优先更新该 atom 的 content (在末尾追加 + 标日期)\n"
  │     "- 仅在信息属于全新主题时才创建新 atom\n"
  │
  ├── LLM 提取 → ExtractionResult.items[]
  │
  └── executePlan (existing, modified)
      对每个 item:
        - 调 normalizeTag() 对 tags 做 lowercase + 字典匹配
        - 调 conceptTagCount() 检测概念性 tag 数量
        - 若 0 概念性 tag, warn 但仍写入
        - 走现有 fingerprint + 0.92 cosine dedup 链
```

### 关键类型 (新文件内,不需要 export)

```typescript
// migrate-legacy-atoms.mts
interface BatchMigrationPlan {
  clusters: Array<{
    keepId: string;
    mergedFields: { title: string; summary: string; content: string; tags: string[] };
    supersededIds: string[];
  }>;
  standalone: Array<{ id: string; fields: { title: string; summary: string; content: string; tags: string[] } }>;
}

interface MigrationReport {
  timestamp: string;
  totalActiveAtoms: number;
  mergedClusters: number;
  mergedAtoms: number;
  unchangedAtoms: number;
  reindexFailed: string[];
  batchErrors: Array<{ batchIdx: number; reason: string }>;
  backupPath: string;
}

// tag-vocab.ts
export function loadTagVocabulary(index: MemoryIndex, topK?: number): string[];

export function normalizeTag(input: string): string;  // lowercase, dict-match

export function conceptTagCount(tags: string[]): number;  // count tags in "concept/*" namespace
```

### Idempotency 设计 (目标 1)

- 脚本入口检查: 若 settings.json 没有 `migration.atomRemigrateV2Done: true` 标记,跑迁移并写标记;否则 exit 0
- 标记字段加在 PersonalAssistantConfig.memory 下: `migration?: { atomRemigrateV2Done?: boolean; atomRemigrateV2At?: number }`
- 用户可手动清标记 (settings.json),重跑

## Existing Code to Reuse

### Reuse: `MemoryIndex.getActiveAtoms()`
- **Path**: `extensions/personal-assistant/storage.ts:306`
- **Why**: 直接拿到 90 个 active atom 列表,过滤 archived=0 + is_latest=1
- **Risk**: 返回的 atom 都是 in-memory 行,需要确认 rowToAtom 解析 tags 数组正确 (已确认 storage.ts:170)
- **Decision**: reuse

### Reuse: `MemoryIndex.updateAtom()`
- **Path**: `extensions/personal-assistant/storage.ts:186`
- **Why**: in-place 改 atom,version +1,自动处理 content_fingerprint 更新。完美适配 "保留 id,只改文本"
- **Risk**: 需传入完整 atom 对象 (会覆盖 title/summary/content/tags/importance/strength)。本脚本只改 4 个文本字段,其他字段保留原值
- **Decision**: reuse,构造新 atom 时 spread 旧 atom 后覆盖 4 字段

### Reuse: `MemoryIndex.markSupersededTx()`
- **Path**: `extensions/personal-assistant/storage.ts:489`
- **Why**: supersede 链式更新,旧 atom 标 is_latest=0 + superseded_at,新 atom (用 keepId) 写入并通过 version 检查
- **Risk**: markSupersededTx 内部会 INSERT 新 row (即使 id 是已存在的 keepId)。需要先 updateAtom(keepId) 改文本,再 markSupersededTx 把其他 atom 链上;或自定义 supersede 路径
- **Decision**: **不直接复用**,本脚本手动做:对 superseded atom 调 index 内部 SQL (UPDATEs is_latest=0 + parent_id + superseded_at),不 insert 新行。**或** 写一个 helper `markSupersededNoInsert(keepId, oldId)` (见 Implementation Notes)

### Reuse: `writeAtomToFile()`
- **Path**: `extensions/personal-assistant/file-store.ts:42`
- **Why**: 写 .md 文件,带 frontmatter,跟现有 atom 文件格式一致
- **Risk**: 无
- **Decision**: reuse

### Reuse: `computeFingerprint()`
- **Path**: `extensions/personal-assistant/extraction.ts:21`
- **Why**: 重算 content_fingerprint
- **Risk**: 必须用同一个 normalizeContent 算法 (已确认 storage.ts:106 注释说明一致)
- **Decision**: reuse

### Reuse: `embedText()` + `buildEmbeddableText()`
- **Path**: `extensions/personal-assistant/embed.ts:64, 150`
- **Why**: 改完一个 atom 后,本地算 embedding 用于 updateAtom (但 bge-m3 reindex 已经算过了,这个 backup)
- **Risk**: 冗余调用,HTTP 失败时备用
- **Decision**: **不直接调用**,bge-m3 reindex 走 HTTP 路径;embedText 仅作为 backup

### Reuse: `completeSimple()` + `modelRegistry.getApiKeyAndHeaders()`
- **Path**: `extensions/personal-assistant/memory.ts:317, 45` (内存引用)
- **Why**: LLM 调用的统一入口,跟 extract 共用配置
- **Risk**: migration 是 standalone script,没有 ExtensionContext。需要自己读 settings.json,模拟 ctx.modelRegistry 的查找逻辑
- **Decision**: **手动写** settings.json 读取 + model 查找逻辑,跟 memory.ts:289-311 一致

### Reuse: bge-m3 service `/api/atoms/{id}/reindex`
- **Path**: `tmp/bge-m3-test/server.py:553` (源码) → live `http://127.0.0.1:11435`
- **Why**: 改完 atom 触发重算 embedding + sparse + content_hash
- **Risk**: 服务 down 整个迁移仍能完成,只是部分 atom 向量是 stale
- **Decision**: reuse via fetch

### Reuse: `SettingsManager` for settings.json
- **Path**: `packages/coding-agent/src/core/settings-manager.ts`
- **Why**: 读 `personalAssistant.memory.extraction.{provider,model}` + `dbPath` + `atomsDir`
- **Risk**: SettingsManager 是 packages/coding-agent 的 API,personal-assistant 是 extensions 下的,可能存在 import boundary
- **Decision**: **手动 fs.readFile + JSON.parse**,模仿 memory.ts:105-119 `loadConfig()` 的实现

### Reuse: `EXTRACT_PROMPT_V2` (扩展,不重写)
- **Path**: `extensions/personal-assistant/extraction.ts:42-106`
- **Why**: 目标 2 不重写 prompt,只在 EXTRACT_PROMPT_V2 之后追加 "## 现有 tag 字典" + "## 主动更新,非扩张" 两段
- **Risk**: 追加段落会让 prompt 变长 ~500 token,单次 LLM call 成本 +5%;90 atom 跑 5 batch + 后续 extract 不影响响应延迟
- **Decision**: extend — 把新内容作为函数返回值的一部分构造,不改 EXTRACT_PROMPT_V2 字符串本身

### Reuse: `buildExtractionPrompt` (改造点)
- **Path**: `extensions/personal-assistant/extraction.ts:287-294`
- **Why**: extract pipeline 唯一构造 prompt 的入口,在它内部加 tag 字典注入最自然
- **Risk**: 该函数当前签名 `buildExtractionPrompt(messages)`,不接收 index/atom 上下文。需要 (a) 把 `tagVocabulary: string[]` 作为参数加进来,(b) 调用方 (`runCompactExtraction` 在 memory.ts) 提前算好 vocabulary
- **Decision**: extend — signature 改为 `buildExtractionPrompt(messages, opts?: { tagVocabulary?: string[] })`,保持向后兼容

### Reuse: `executeItem` (改造点)
- **Path**: `extensions/personal-assistant/extraction.ts:123-149`
- **Why**: 目标 2 的程序端 tag 归一化兜底要在写入前调,executeItem 是唯一写入入口
- **Risk**: 改 executeItem 会影响所有 extract 路径 (`session_before_compact`、webui 的 PATCH 路径)。需要确保归一化对所有路径都安全
- **Decision**: extend — 在 `const newAtom = buildAtomFromItem(item, fingerprint)` 之前加 `const normalizedTags = item.tags.map(normalizeTag)`,然后构造 atom 时用 normalizedTags

### Reuse: `supersedeIfSimilar` (不依赖,仅作 dedup 兜底备份)
- **Path**: `extensions/personal-assistant/dedup.ts:18-41`
- **Why**: 即使 LLM 没遵守"主动更新"规则,程序端 0.92 cosine dedup 仍兜底 (虽然实测对 cluster 0.75-0.80 无效)
- **Risk**: 阈值 0.92 对真正的 cluster case 无效,只能挡 fingerprint 不同 + 文本几乎一样的"重复 emit"。已确认不能依赖
- **Decision**: reuse as-is — 不调阈值,继续作为最后兜底

### Reuse: `completeSimple` (目标 2 复用 LLM 路径)
- **Path**: `@earendil-works/pi-ai/compat` (memory.ts:45 import)
- **Why**: extract 已经在用,目标 2 不引入新 LLM client
- **Risk**: 无
- **Decision**: reuse

## Risks / Trade-offs

### 目标 1 风险 (迁移)

| Risk | Mitigation |
|------|------------|
| LLM 误合并: 语义不同但表面相似的 atom 被合并 | LLM 输出 schema 严格校验,每 cluster 至少 2 个原 atom,LLM 必须给出合并理由 |
| LLM 漏合并: 应合并的没合并 | 验证 acceptance #1 (cluster ≥ 6),不足则人工 review migrate-report.json |
| bge-m3 批量 reindex 拖慢 | 并发 5 个,失败 5s timeout,允许部分失败 |
| 备份文件占双倍空间 (4MB) | 一次性,迁移完成提示用户删除 .bak |
| 迁移中 pi 在跑 → SQLITE_BUSY | busy_timeout=5000ms 已设;再开 WAL 锁 5s 后 abort + 部分迁移 (idempotent) |
| 旧 atom content_fingerprint 重算,UNIQUE 索引报错 (如果新 fingerprint 跟另一个 active atom 重复) | 罕见,先 fingerprint dedup 检查,有冲突就改一两个字 |
| 用户误跑两次 | settings.json 标记 + 标题 "v2" 后缀 双重 idempotency |
| migration 改坏了用户想回滚 | cp memory.db.bak.YYYYMMDD memory.db + bge-m3 reconcile |
| cluster cosine 0.75-0.80,程序层 dedup 完全错过 | 这是已知,目标 1 走 LLM 兜底,程序层 dedup 不再依赖 |

### 目标 2 风险 (extract 优化)

| Risk | Mitigation |
|------|------------|
| tag 字典注入 prompt 让 LLM 倾向"复用旧 tag"过度,新主题 emit 受抑制 | 字典只列 top 50,字典旁白强调"自由 emit 新 tag";程序端不强制 LLM 必须用字典 tag |
| LLM 不遵守"主动更新"规则,继续创建冗余 atom | 程序端 0.92 cosine dedup 仍兜底 (虽然对 cluster case 无效,但能挡 fingerprint 不一样的重复 emit) |
| tag lowercase 把 `MGM` 误转为 `mgm` (项目名 brand) | `normalizeTag` 优先查字典,字典里有 `MGM` 就用 `MGM`,不强制 lowercase;字典没有才 lowercase |
| 概念性 tag 检测 (`concept/*` 命名空间) 误伤 | 暂不强制 reject,只 warn。后续可加更宽松的"动作动词"检测 (e.g. 标签含修复/位置/流程/规则) |
| tag 字典 top-50 计算每次 extract 都跑,延迟 +50ms | 缓存 in-memory 直到 session 结束。首次构建后无开销 |
| 提示词变长,LLM 成本 +5% (单次 extract) | 可接受,extract 本身是低频路径 (session_before_compact 触发) |
| 用户改 `concept/*` 命名空间,程序端 namespace 假设破 | 在 CHANGELOG 标注约定,user 改了 namespace 算 breaking |

## Testing Strategy

### 单元测试
- **`scripts/migrate-legacy-atoms.mts` 内置 self-test** (--dry-run 模式): 跑 LLM 但不写 DB/文件,只输出 plan,人工 review 后 --apply 才真改
- **`migrate-report.json` schema 校验**: TS interface 强制,跟 LLM 输出 schema 一致

### 集成测试
- **`test/migration.test.ts`** (新): 拿真实 90 atom 的备份,跑 dry-run,断言:
  - 至少 6 个 cluster 合并
  - mergedAtoms ≥ 18 (≥ 20% reduction)
  - 每个 standalone 字段都变化 (没有 unchanged)
  - reindex 失败的 atom 数 = 0 (用 mock service)
- **`test/recall-quality.test.ts`** 加 case: 迁移后 precision@5 ≥ 40%

### 目标 2 测试 (`test/extraction-prompt.test.ts`, 新)
- mock LLM,验证 `buildExtractionPrompt` 输出包含:
  - "## 现有 tag 字典" 段 + top-50 tag
  - "## 主动更新,非扩张" 段
- mock LLM,验证 `executeItem` 写入前:
  - 调 `normalizeTag` 对 tags lowercase
  - 字典里有 "Amplicon" → 输出 "amplicon"  
  - 字典里有 "MGM" → 输出 "MGM" (不强制 lowercase 项目名)
- mock LLM emit 0 概念性 tag → 写入但 warn
- mock LLM,验证 fingerprint 同 atom 被 skip (既有逻辑)
- mock LLM,验证 cosine ≥ 0.92 的 emit 走 supersede (既有逻辑)

### 边界条件
- LLM 返回 0 cluster: 脚本 warn + exit 0 (无需迁移)
- LLM 返回所有 standalone: 脚本正常运行 (不强制合并)
- 备份文件已存在: 覆盖,文件名加时间戳后缀
- memory.db 已被另一进程 lock: 5s 后 abort
- corpus 0 atom (新用户首次启动): `loadTagVocabulary` 返回空,prompt 注入空字典段,LLM 自由 emit
- 目标 2 LLM 不遵守"主动更新"规则,继续 emit 相似新 atom: 程序端 0.92 dedup 兜底,部分 case 仍然 create
- 目标 2 LLM emit tag 全部专名: warn 但仍写入,后续可加更严的 reject (留给未来 change)

### 验证
- 迁移前: 跑 `recall-quality.test.ts` 记录 baseline precision
- 迁移后: 跑同一 test 验证 precision 提升
- 手动: 抽 3-5 个典型 query (用户的 "修复的脚本" 那种) 跑 webui 搜索,看 top-5 质量
- 30 天后跑 `test/tag-quality.test.ts`,检查 corpus tag 重复率 ≥ 2.0

## Implementation Notes

### 关键依赖顺序

**目标 1 (迁移)**:
1. 实现 `markSupersededNoInsert()` helper (或在 migration script 内联 SQL) — supersede 链实现的核心
2. 实现 `parseBatchLLMOutput()` — 严格 JSON 校验
3. 实现 `migrateBatch()` — 单 batch 处理流程
4. 实现 `migrateAll()` — 串行 5 batch + report

**目标 2 (extract 优化)**:
1. 先实现 `tag-vocab.ts` (`loadTagVocabulary`, `normalizeTag`, `conceptTagCount`) — 纯函数无依赖
2. `buildExtractionPrompt` 加 `tagVocabulary` 参数 (向后兼容,opts 可选)
3. 调 `buildExtractionPrompt` 的地方 (`runCompactExtraction` in memory.ts) 提前算 vocabulary
4. `executeItem` 在 `buildAtomFromItem` 之前对 tags 调 `normalizeTag`
5. 改 `EXTRACT_PROMPT_V2` 之后追加 "## 主动更新,非扩张" 段 (静态拼接到 prompt)

### gotchas
- **markSupersededTx 会 insert 新 row**: 本脚本不要用这个,改用直接 SQL: `UPDATE memory_index SET is_latest=0, parent_id=?, superseded_at=? WHERE id=?`
- **computeFingerprint 用 normalizeContent (lowercase + collapse whitespace)**: 跟 storage.ts:106 一致
- **UNIQUE 索引 idx_memory_active_fingerprint**: 合并后的新 fingerprint 必须跟其他 active atom 不冲突。罕见,先查再写
- **bge-m3 并发 reindex**: 5 个并发,不要更多 (服务单 worker 处理 encode 任务)
- **settings.json 标记**: 写 `personalAssistant.memory.migration.atomRemigrateV2Done = true` + `atomRemigrateV2At = ISO 字符串`,schema 已在 memory.ts:67-84,加 2 个字段即可 (typescript type)
- **tag 字典 top-50 扫描要快**: 90 atom × 4.2 tag/atom × JSON.parse ≈ 50ms,可接受;但 corpus 1000+ atom 时要考虑加索引或缓存
- **normalizeTag 字典匹配要严格** (exact match),不做模糊匹配 (e.g. "Amplicon" 命中 "amplicon",但 "amp" 不命中 "amplicon")
- **目标 2 prompt 长度增加 ~500 token**: 测过 4 个 cluster case LLM 仍能正确 emit,无 token 超限风险
- **buildExtractionPrompt 签名变化** `buildExtractionPrompt(messages, opts?)`: 调用方 (memory.ts:runCompactExtraction) 必须传入 opts,否则 dict 段为空,不报错但失去目标 2 效果

### 未来 cleanup
- 3 个月后所有用户都迁移过,目标 1 脚本可标记为 deprecated,只在 docs 里保留引用
- 备份文件 `memory.db.bak.YYYYMMDD` 用户应手动删除
- 未来如果还要再迁移 (v3),需要清 `atomRemigrateV2Done` 标记
- 目标 2 的 `EXTRACT_PROMPT_V2` 追加段未来可移到主 prompt 字符串内 (避免函数动态拼接),等 LLM 行为稳定后
- 未来 corpus 大到 1000+ atom 时,tag 字典应改为 persistent (SQLite 表) + 增量更新,而非每次 session 重算

### 不在本次范围
- tag 同义词表 LLM 自动聚类 (那是另一个独立 change)
- extract prompt 其他方面优化 (e.g. importance 校准、scope/template 字段)
- webui 显示版本标记 — 不必要,UI 自然显示新文本
- LLM 调用别的 prompt 路径 (e.g. webui 的 PATCH memory check)
- 回填 source_session (那是另一个 change)
