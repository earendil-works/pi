# Design: atom-remigrate

## Context

Personal-assistant 记忆系统当前有 90 个 active atom,典型问题:
- **冗余**: 至少 9 个 cluster 重复 (扩增子/iCAMP/check_seq/RNAVIRUS-DELIVERY-CHECK/smart-sample-find/workMonitor/X101SC26052587/README 各 2-3 个)
- **内容过短**: avg content 199/244/134 字 (fact/process/rule),LLM 召回后只看 summary,大量上下文丢失
- **召回假阳性高**: 用户原 case "修复的脚本和修复逻辑给我" 召回 8 个里 6 个无关 (precision 25%)

根因不是召回算法 (bge-m3 dense+sparse RRF 是合理的),而是 **atom 文本结构缺乏信号**: title/summary 是自然语言,bge-m3 在 1024 维语义空间里把"修复的脚本"和"脚本位置"算成 0.55 cosine — 0.02 的距离 bge-m3 学到的就是"接近"。

召回策略零改动是用户明确要求。本次变更只动 atom 文本: 一次性 LLM 批处理 90 个老 atom,合并语义级重复,合并后内容自然变长。改完触发 bge-m3 reindex,新向量跟新文本对齐,召回端看到的是"更结构化、更自洽"的 atom 文本,bge-m3 自己能算得更准。

## Goals / Non-Goals

### Goals
- 90 个 active atom 一次性 LLM 批处理,合并冗余 cluster
- 合并后 atom 平均 content 长度 ≥ 350 字
- id 全保留 (外部引用不破),version +1,updated_at 更新
- bge-m3 向量 reindex 同步
- 可回滚 (迁移前 backup)
- 脚本 idempotent (二次运行检测到 v2 标记就跳过)

### Non-Goals
- 不改召回策略 (search.ts / format.ts / hybrid-search.ts / server.py 全部零改动)
- 不改 extract prompt (`EXTRACT_PROMPT_V2` 保持现状,后续可单独 change)
- 不改 decay / strength / access_count 字段
- 不删 atom (LLM 决定保留就保留)
- 不改 schema (0 列变化)
- 不重建 bge-m3 全量索引 (只对改动的 atom 调 `reindex_one`)
- 不动 webui (UI 自然显示新文本)
- 不回填 source_session (那是另一个 change)

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

### 3. 用 extract prompt 同款 LLM 路径,不改 prompt
**Decision**: 复用 `extractMemoriesWithCallLlm` 的 LLM call 路径,只把 conversation 文本替换成"90 个 atom 的 title+summary+content 序列化"。**不**改 EXTRACT_PROMPT_V2。
**Rationale**: 改 prompt 是另一个独立 change (extract 质量优化),不能借这次 migration 暗改 LLM 行为,导致 audit 难。
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

## Architecture

### 文件改动

| 文件 | 改动 |
|------|------|
| `extensions/personal-assistant/scripts/migrate-legacy-atoms.mts` | **新文件**,一次性 migration 脚本 |
| `extensions/personal-assistant/scripts/migrate-report.json` | 运行时生成,迁移结果 (cluster 列表,reindex 失败列表) |
| `extensions/personal-assistant/CHANGELOG.md` | 加 [Unreleased] entry 说明 migration 工具存在 + 推荐用法 |

**不动**: extraction.ts, storage.ts, dedup.ts, file-store.ts, search.ts, format.ts, hybrid-search.ts, types.ts, memory.ts, decay.ts, embed.ts, server.py

### 数据流

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
  │   │     合并后 content 必须包含所有原 atom 的关键信息,长度建议 350+ 字.
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

### 关键类型 (新文件内,不需要 export)

```typescript
// 单 batch LLM 输出
interface BatchMigrationPlan {
  clusters: Array<{
    keepId: string;  // 选 cluster 中某个原 atom 的 id
    mergedFields: { title: string; summary: string; content: string; tags: string[] };
    supersededIds: string[];  // cluster 中除 keepId 外的 id
  }>;
  standalone: Array<{  // LLM 决定不合并,只扩充
    id: string;
    fields: { title: string; summary: string; content: string; tags: string[] };
  }>;
}

// migrate-report.json
interface MigrationReport {
  timestamp: string;  // ISO 8601
  totalActiveAtoms: number;
  mergedClusters: number;
  mergedAtoms: number;  // 被 supersede 的 atom 总数
  expandedAtoms: number;  // 字段有变化但没合并的
  unchangedAtoms: number;
  reindexFailed: string[];  // bge-m3 reindex 失败的 atom id
  batchErrors: Array<{ batchIdx: number; reason: string }>;
  backupPath: string;  // memory.db.bak.YYYYMMDD 路径
}
```

### Idempotency 设计

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

## Risks / Trade-offs

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

### 边界条件
- LLM 返回 0 cluster: 脚本 warn + exit 0 (无需迁移)
- LLM 返回所有 standalone: 脚本正常运行 (不强制合并)
- 备份文件已存在: 覆盖,文件名加时间戳后缀
- memory.db 已被另一进程 lock: 5s 后 abort

### 验证
- 迁移前: 跑 `recall-quality.test.ts` 记录 baseline precision
- 迁移后: 跑同一 test 验证 precision 提升
- 手动: 抽 3-5 个典型 query (用户的 "修复的脚本" 那种) 跑 webui 搜索,看 top-5 质量

## Implementation Notes

### 关键依赖顺序
1. 实现 `markSupersededNoInsert()` helper (或在 migration script 内联 SQL) — supersede 链实现的核心
2. 实现 `parseBatchLLMOutput()` — 严格 JSON 校验
3. 实现 `migrateBatch()` — 单 batch 处理流程
4. 实现 `migrateAll()` — 串行 5 batch + report

### gotchas
- **markSupersededTx 会 insert 新 row**: 本脚本不要用这个,改用直接 SQL: `UPDATE memory_index SET is_latest=0, parent_id=?, superseded_at=? WHERE id=?`
- **computeFingerprint 用 normalizeContent (lowercase + collapse whitespace)**: 跟 storage.ts:106 一致
- **UNIQUE 索引 idx_memory_active_fingerprint**: 合并后的新 fingerprint 必须跟其他 active atom 不冲突。罕见,先查再写
- **bge-m3 并发 reindex**: 5 个并发,不要更多 (服务单 worker 处理 encode 任务)
- **settings.json 标记**: 写 `personalAssistant.memory.migration.atomRemigrateV2Done = true` + `atomRemigrateV2At = ISO 字符串`,schema 已在 memory.ts:67-84,加 2 个字段即可 (typescript type)

### 未来 cleanup
- 3 个月后所有用户都迁移过,这个脚本可标记为 deprecated,只在 docs 里保留引用
- 备份文件 `memory.db.bak.YYYYMMDD` 用户应手动删除
- 未来如果还要再迁移 (v3),需要清 `atomRemigrateV2Done` 标记

### 不在本次范围
- extract prompt 优化 (EXTRACT_PROMPT_V2) — 单独 change
- tag 字典 / tag 质量改进 — 之前用户已拒绝 (不改召回)
- webui 显示版本标记 — 不必要,UI 自然显示新文本
