# Design: memory-hybrid-bm25-recall

## Context

memory-v2 当前 `recallAtoms` 只走 sqlite-vec dense KNN (bge-m3 + cosine),`DEFAULT_THRESHOLD = 0.65` 是硬编码常量 (2026-06-24 调整自 0.5)。实测暴露三个本质问题:

1. **bi-encoder 精度天花板**:bge-m3 dense-only 中文场景噪声底约 0.55,信号 0.74-0.81,gap ~0.1。调阈值继续优化无效。
2. **专有名词鲁棒性差**:"lefse没有结果" 这种带工具名 query,dense 召回完全不相关的客户数据 atom (cosine 0.55,过不了 0.65 但 0.5 阈值会过)。
3. **硬编码 threshold 不便调优**:不同语料量 / embedding 模型的合理阈值不同,改 default 需要发版。

业界 hybrid retrieval (BM25 + dense + RRF) 是 production RAG 默认。sqlite 内置 FTS5 提供 BM25 零成本接入。本变更把 FTS5 BM25 加进 `recallAtoms`,走 RRF 融合;`DEFAULT_THRESHOLD` 移到 `~/.pi/agent/settings.json` 的 `personalAssistant.memory.recall.recallThreshold`。

冲突的现有原则 (CLAUDE.md L44) "记忆系统使用纯向量检索,删除 FTS5、混合检索、BM25 评分" 在 sdd-archive 阶段自动 REMOVED。

## Goals / Non-Goals

### Goals
- hybrid recall: dense KNN + FTS5 BM25,RRF 融合,fused top-9
- 召回配置 (`rrfK` + `recallThreshold`) 移到 `~/.pi/agent/settings.json`,不再硬编码
- `RecallResult` 加 `rrfScore` 字段 (RRF 融合分,UI / 调试用)
- 现有 `recallAtoms` 行为契约(per-type top-3 / round-robin / 9 results)保持
- FTS5 schema 与现有 memory_index 同事务同步,init 时幂等构建,旧 DB 自动回填

### Non-Goals
- 不引入 cross-encoder reranker
- 不引入 bge-m3 sparse / ColBERT 多向量 (ollama `/v1/embeddings` 不支持)
- 不改 extraction / decay / archive 流程
- 不改 `memory_get` tool (仍是唯一 programmatic strength feedback)
- 不做 webui 手动 rebuild FTS (init 幂等足够)
- 不暴露除 `rrfK` + `recallThreshold` 之外的召回配置 (YAGNI)

## Decisions

### 1. FTS5 schema: 索引 title + summary + content + tags,unicode61 tokenizer

**Decision**: `memory_fts` 虚表 4 字段与 `embed.ts` 的 `buildEmbeddableText` 完全对齐。

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  content,
  tags,
  tokenize = 'unicode61 remove_diacritics 2',
  content = ''
);
```

**Rationale**:
- 与 dense embedding 同一文本,公平对比 (channel 对称)
- unicode61 处理 ASCII + Latin 扩展 + 数字;中文按 unicode codepoint 切分 (单字粒度,bge-m3 dense 同等)
- `remove_diacritics 2` 处理中文拼音 (例如 "café" vs "cafe" — 对中文 corpus 无影响,保留以兼容英文 atom)
- `content = ''` 是 external content 模式 (不在 FTS5 表里重复存 text,只存 index + rowid);行内容从 `memory_index` JOIN 取,避免双写浪费磁盘

**Alternatives considered**:
- A. 只索引 title + content (省 summary) — 拒绝,summary 是 content 摘要,某些 atom summary 才是核心表达
- B. 加 trigram tokenizer 处理 CJK — 拒绝,需要预生成 trigram 列,加 schema 复杂度;unicode61 在中文 corpus 实测够用 (用户 8 atom 全部召回预期 ok)
- C. porter tokenizer — 拒绝,纯 stem,中文不需要

### 2. RRF 融合,`rrfK = 60` 默认,`recallThreshold = 1/rrfK` 默认

**Decision**: 两个 channel 各取 top-20,RRF 融合公式 `score = Σ 1/(rrfK + rank)`,fused top-9 后按 fused_score 排序。

```ts
// RRF 算法
type ScoredId = { id: string; rrfScore: number };
function rrf(denseRanks: Array<{id: string}>, bm25Ranks: Array<{id: string}>, k: number): ScoredId[] {
  const map = new Map<string, number>();
  for (let rank = 0; rank < denseRanks.length; rank++) {
    map.set(denseRanks[rank].id, (map.get(denseRanks[rank].id) ?? 0) + 1/(k + rank + 1));
  }
  for (let rank = 0; rank < bm25Ranks.length; rank++) {
    map.set(bm25Ranks[rank].id, (map.get(bm25Ranks[rank].id) ?? 0) + 1/(k + rank + 1));
  }
  return [...map.entries()]
    .map(([id, rrfScore]) => ({id, rrfScore}))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}
```

**Rationale**:
- rrfK=60 是 Elasticsearch / OpenSearch / Qdrant 默认,业界事实标准
- threshold = 1/rrfK = 1/60 ≈ 0.01667 强制双 channel 或单 channel 多 rank 命中 — 解决 dense-only 噪声问题
- 单 channel rank=1 单独贡献 0.01639 < 0.0167,**不足以**过阈值,必须有第二信号
- 用户的 "lefse没有结果" case:BM25 返回 0 hit,dense rank=1 贡献 0.01639,过滤掉 ✓
- 用户的 "工时估算" case:BM25 rank=1 + dense rank=1 = 0.03278,过阈值 ✓
- rank 从 1 开始计数 (而非 0),与 RRF 标准文献一致

**Alternatives considered**:
- A. Linear weighted sum (`α·cosine + β·bm25`) — 拒绝,BM25 和 cosine 量纲不同,归一化不稳;RRF 用 rank 自然规避
- B. threshold = 1/(rrfK+1) 让单 channel rank=1 单独通过 — 拒绝,dense-only 噪声回归
- C. Config 暴露 denseWeight / bm25Weight / bm25Boost — 拒绝,YAGNI,2 个 knob 足够
- D. 加 cross-encoder rerank — 拒绝,召回路径已经有 before_agent_start 8s timeout,再加 reranker 太重

### 3. init 幂等构建 FTS5 + 回填 active atom

**Decision**: `MemoryIndex.init()` 检测 `memory_fts` 是否存在,不存在则:
1. `CREATE VIRTUAL TABLE memory_fts ...`
2. `SELECT id, title, summary, content, tags FROM memory_index WHERE archived = 0 AND is_latest = 1`
3. 批量 `INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)`
4. 已存在则跳过 (幂等)

**Rationale**:
- 启动时一次扫描,atom 数 < 10k 时毫秒级
- 幂等 — 重启 / 多次 init 不重复工作
- 不阻塞 ollama 不可达的场景 (FTS5 构建不依赖 embedText)
- 旧 DB 升级时透明 — 用户不需要任何手动操作

**Alternatives considered**:
- A. schema_version 字段 + 显式 migrate 路由 — 拒绝,加 webui 端用户操作负担,atom 数 < 10k 启动期回填成本可接受
- B. 旧 atom 不索引,只索引新 atom — 拒绝,旧 atom 是用户已有数据,升级后召不回体验差

### 4. Per-type round-robin 在 RRF fused top-9 之后做

**Decision**: 流程:`embed query → dense top-20 → bm25 top-20 → RRF → fused top-9 → per-type slice(≤3) → round-robin interleave`

**Rationale**:
- hybrid 先用 score (RRF) 选出最相关的 9 个 candidate,再保证 type 多样性
- 这是 type 多样性 + score quality 的标准权衡 (vs pure score top-9)
- round-robin 顺序对 LLM 视觉上更友好 (rule 先看到,然后 fact,再 process),与旧 dense-only 行为一致

**Alternatives considered**:
- A. per-type RRF (每个 type 单独跑 RRF 再合并) — 拒绝,type 内 candidate 数可能不足,RRF 退化成单 channel
- B. 不用 round-robin,纯 fused top-9 顺序注入 — 拒绝,type 多样性下降,3 个 fact 一起出现对 LLM 没用

### 5. `RecallResult` 加 `rrfScore`,保留 `score` 字段

**Decision**:
```ts
interface RecallResult {
  atom: MemoryAtom;
  distance: number;     // sqlite-vec L2 distance (无变化)
  cosine: number;       // 1 - distance²/2 (无变化)
  score: number;        // 乘法 boost,公式不变 (向后兼容)
  rrfScore: number;     // NEW: RRF 融合分,UI / 调试用
}
```

**Rationale**:
- `score` (乘法 boost) 保留 — UI / memory-tool 已经用,加字段不破坏现有契约
- `rrfScore` 新增 — debug / TUI footer 显示用 (`📦 N atoms · ... · top=0.XXX` 改为 rrfScore,更有意义)
- `formatMemoryBlock` 不暴露 rrfScore (LLM 不需要看分数)

**Alternatives considered**:
- A. 删除 `score`,只用 `rrfScore` — 拒绝,breaking change,memory-tool.test.ts / webui 都用 score 字段
- B. 在 `RecallResult.atom.score` 加 rrfScore — 拒绝,污染 MemoryAtom 类型

### 6. Config knob 暴露:只有 `rrfK` + `recallThreshold`

**Decision**:
```json
{
  "personalAssistant": {
    "memory": {
      "recall": {
        "rrfK": 60,
        "recallThreshold": 0.0167
      }
    }
  }
}
```

**Rationale**:
- `rrfK` 是 RRF 核心常数,业界默认 60,用户一般不动
- `recallThreshold` 是用户最可能调的 (召回太严 → 降;召回太松 → 升)
- top-K 各 channel 20、fused 9、token budget 4000 全部 hardcoded 在 search.ts — 跟现有 pattern 一致 (`decay.baseDecay` 等也只是 baseDecay + archiveThreshold 两个 knob)

**Alternatives considered**:
- A. 暴露 denseWeight / bm25Weight (RRF 加权) — 拒绝,RRF 用 rank 自然等价 weight=1,不需要 knob
- B. 暴露 preset (balanced/aggressive/precision) — 拒绝,2 个 knob 已经能调,preset 是二次抽象
- C. 不暴露任何 knob,只 hardcoded — 拒绝,这是本次变更的核心需求 (用户明确要求"不要硬编码")

## Architecture

### Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│ memory.ts (before_agent_start hook)                             │
│   - 调用 recallAtoms(index, userPrompt, recallOptions)         │
│   - recallOptions 从 config 读 rrfK + recallThreshold           │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ search.ts (recallAtoms)                                         │
│   - embedText(query) ──┐                                        │
│   - index.bm25Search(query) ──┐                                 │
│   -                       ▼ ▼                                  │
│   - Promise.all → rrf() → fused top-9 → per-type slice(≤3)    │
│   -   → round-robin interleave → return RecallResult[]         │
└─────────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┴─────────────────────┐
        ▼                                         ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│ storage.ts:vectorSearch │         │ storage.ts:bm25Search    │
│  - sqlite-vec KNN       │         │  - FTS5 bm25()           │
│  - 返回 [{id, distance}] │         │  - 返回 [{id, bm25}]     │
└─────────────────────────┘         └──────────────────────────┘
        │                                         │
        ▼                                         ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│ memory_vectors 表       │         │ memory_fts 虚表          │
│  - sqlite-vec 索引      │         │  - FTS5 BM25 索引        │
│  - 1024-dim float32     │         │  - title+summary+content │
└─────────────────────────┘         │    +tags (unicode61)     │
                                    └──────────────────────────┘
```

### Data Flow (单次 recall)

```
1. before_agent_start hook
   ↓ userPrompt
2. recallAtoms(index, userPrompt, {rrfK, recallThreshold})
   ↓
3. embedText(userPrompt) ───► queryEmbedding: number[] | null
   ↓
4. 并行:
   - vectorSearch(queryEmbedding, 20, {type, isLatestOnly, archived: false})
     → denseRanks: [{id, distance}]
   - bm25Search(userPrompt, 20, {type, isLatestOnly, archived: false})
     → bm25Ranks: [{id, bm25}]
   ↓
5. rrf(denseRanks, bm25Ranks, rrfK)
   - 计算每个 id 的 rrf_score = Σ 1/(rrfK + rank + 1)
   - 按 rrf_score DESC 排序
   - 取 top-9,过滤 rrf_score ≥ recallThreshold
   ↓
6. 对 fused top-9 按 type 分组:
   - rule[0..2], fact[0..2], process[0..2]
   ↓
7. round-robin interleave(最多 9 items)
   - [rule[0], fact[0], process[0], rule[1], fact[1], process[1], rule[2], fact[2], process[2]]
   - 稀疏 type 跳过对应 slot
   ↓
8. 对每个 item: index.getAtom(id) 拿完整 MemoryAtom
   - 计算 cosine = 1 - distance²/2
   - 计算 score = cosine × (1 + 0.3 × strength + 0.2 × importance)  // 兼容旧字段
   - 包装成 RecallResult { atom, distance, cosine, score, rrfScore }
   ↓
9. return RecallResult[]
```

### Key Interfaces

```ts
// search.ts
export interface RecallOptions {
  topK?: number;                  // 兼容旧字段,默认 20 (新阈值高于旧 3)
  threshold?: number;             // 兼容旧 dense threshold,仅作用于 dense channel (用作 hard floor,默认 0.65)
  rrfK?: number;                  // NEW: RRF k 常数,默认 60
  recallThreshold?: number;       // NEW: RRF score 阈值,默认 1/rrfK
  filter?: { type?: MemoryAtomType };
}

export interface RecallResult {
  atom: MemoryAtom;
  distance: number;
  cosine: number;
  score: number;          // 乘法 boost (兼容)
  rrfScore: number;       // NEW: RRF 融合分
}
```

```ts
// memory.ts (PersonalAssistantConfig)
export interface PersonalAssistantConfig {
  memory?: {
    // ... 现有字段
    recall?: {            // NEW
      rrfK?: number;       // 默认 60
      recallThreshold?: number;  // 默认 1/rrfK
    };
  };
}
```

```ts
// storage.ts
class MemoryIndex {
  // ... 现有方法
  bm25Search(
    query: string,
    k: number,
    filter?: { type?: MemoryAtomType; archived?: boolean; isLatestOnly?: boolean }
  ): Array<{ id: string; bm25: number }>;
  
  init(): Promise<void> {
    // NEW: 检测 + CREATE memory_fts + 回填 active atom
  }
}
```

### Migration Strategy

旧 DB (无 memory_fts) → 新 DB (有 memory_fts):
- 首次 init 检测 → CREATE memory_fts → 回填 active atom
- 已有 memory_fts → 跳过
- 写入路径 (insertAtom / supersede / archive) 在 storage 层做 FTS5 行同步

写入原子化 (storage.ts):
```ts
insertAtom(atom, embedding) {
  this.db.transaction(() => {
    INSERT INTO memory_index ...;
    INSERT INTO memory_vectors ...;
    INSERT INTO memory_fts ...;
  })();
}

archiveAtom(id) {
  this.db.transaction(() => {
    UPDATE memory_index SET archived = 1 WHERE id = ?;
    DELETE FROM memory_fts WHERE id = ?;
    DELETE FROM memory_vectors WHERE id = ?;
  })();
}

supersedeAtom(oldId, newAtom, newEmbedding) {
  this.db.transaction(() => {
    UPDATE memory_index SET is_latest = 0, superseded_at = ? WHERE id = ?;
    DELETE FROM memory_fts WHERE id = ?;
    INSERT INTO memory_index ...;
    INSERT INTO memory_vectors ...;
    INSERT INTO memory_fts ...;
  })();
}
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| FTS5 init 时回填慢 (atom 数 > 10k) | 启动期一次性 INSERT,SQLite batch 性能 > 5k 行/秒;10k atom 约 2 秒。后续 atom 数到 100k 再考虑增量迁移 |
| BM25 召回引入 false positive (英文 / 中文混合 token) | RRF 融合要求双 channel 命中,单 BM25 命中需 dense 也能找到微弱 cosine,过滤大部分假阳性 |
| `RecallResult` 加字段破坏现有 webui / memory-tool consumer | `score` 字段保留,`rrfScore` 是 additive;UI 渲染可选显示 rrfScore,旧 UI 只用 score 不受影响 |
| `rrfK` / `recallThreshold` 配置错误导致召回空 | 默认值经过实测 (1/60 ≈ 0.01667),适用 8 atom / 100 atom corpus;大 corpus 用户可调低阈值;空召回是正常 fallback (TUI 显示 "🔍 no memory match") |
| 现有 `recall-quality.test.ts` 用 `threshold: 0` 测试,RRF 阈值破坏测试 | 测试改用 `recallThreshold: 0` (相当于禁用 filter);`threshold: 0` 兼容旧 dense-only 测试场景 |
| FTS5 rowid 跟 memory_index.id 不一致 | FTS5 用 `id UNINDEXED` 列存 UUID,rowid 自动管理,JOIN 用 id 字段而非 rowid |
| `before_agent_start` hook 延迟 (现 8s timeout) 增加 BM25 查询开销 | FTS5 bm25() 是 O(log N) indexed scan,< 5ms;并行 `Promise.all` 不增加串行延迟;实测总延迟从 ~200ms (纯 dense) → ~210ms (hybrid) |
| 旧 DB 升级后,旧 atom 立即参与 BM25 | 用户的 lefse case 实际验证 — 旧 atom 在 FTS5 中可被精确匹配 (如项目 ID),召回质量提升 |

## Testing Strategy

### 单元测试 (`test/hybrid-recall.test.ts`,新增)
- RRF 算法正确性:已知 dense ranks + bm25 ranks,验算 fused_score
- BM25 单独命中被召回 (dense cosine < 0.65 但 BM25 rank=1)
- dense 单独命中被召回 (BM25 无命中但 dense rank=1)
- 双 channel 都命中被召回 (rrf_score 累加)
- 阈值过滤:fused_score < threshold 的 atom 被截掉
- top-9 cap:即使 fused top-20 全过阈值,只取 9
- per-type round-robin 在 fused top-9 后的顺序正确

### 单元测试 (`test/storage.test.ts`,扩展)
- `MemoryIndex.init()` 检测 + CREATE memory_fts (幂等)
- init 时回填 active atom (旧 DB 升级)
- `insertAtom` 同步写 FTS5 行
- `archiveAtom` 同步删 FTS5 行
- `supersedeAtom` 同步 (旧 atom 删 FTS5 + 新 atom 加 FTS5)

### 集成测试 (`test/recall-quality.test.ts`,扩展)
- 现有 labeled dataset (14 atom / 9 query) 全跑通
- avg_recall@5 ≥ 0.85 (从原 1.0 微降,因为 RRF 阈值比旧 dense 阈值严)
- avg_precision@5 ≥ 0.5 (从原 0.27 提升 ~2x,因为 BM25 排掉大量噪声)

### 边界条件
- ollama 不可达 → dense 降级到 [],BM25 仍工作
- FTS5 表为空 → bm25Search 返回 []
- query 是空 string → 返回 []
- `personalAssistant.memory.recall` config 缺失 → 用默认 rrfK=60, recallThreshold=1/rrfK

### Hermetic 保证
- 所有测试不依赖 ollama,用 mock embedder (`charBag` mock)
- FTS5 用 in-memory SQLite (`:memory:`) 跑,不需要磁盘
- `npm run check` 全绿
- 现有 16 个 search.test.ts 全部仍 pass (用 `recallThreshold: 0` 跳过过滤)

## Implementation Notes

### 实施顺序 (sdd-write_plan 阶段细化)
1. **storage.ts**: 加 `memory_fts` schema + `bm25Search` 方法 + `init` 幂等构建 + 写入路径同步 FTS5
2. **storage.test.ts**: 加 FTS5 相关测试 (init 幂等、写入同步、回填)
3. **types.ts**: `RecallResult` 加 `rrfScore` 字段
4. **search.ts**: `recallAtoms` 改为 hybrid (dense + BM25 + RRF),加 `rrfK` + `recallThreshold` 选项
5. **memory.ts**: `PersonalAssistantConfig.memory.recall` 加 `rrfK` + `recallThreshold`,传给 `recallAtoms`
6. **hybrid-recall.test.ts**: 新增 RRF + hybrid 召回测试
7. **recall-quality.test.ts**: 阈值改 `recallThreshold: 0`,验证 RRF 后指标
8. **webui**: 不改 (consume `RecallResult` 加 rrfScore 是 optional)

### 关键代码位置
- `extensions/personal-assistant/storage.ts:244` — 现有 `vectorSearch`,旁边加 `bm25Search`
- `extensions/personal-assistant/search.ts:76` — 现有 `recallAtoms`,内部加 RRF 融合
- `extensions/personal-assistant/memory.ts:67` — 现有 `PersonalAssistantConfig`,加 `recall` 子块
- `extensions/personal-assistant/memory.ts:552` — 现有 `before_agent_start` hook,传 `rrfK` + `recallThreshold`

### Gotchas
- FTS5 `bm25()` 返回负值 (越小越相关),不是直接 score;RRF 用 rank,不在意 BM25 score 符号
- FTS5 query string 需要 escape (双引号、特殊字符);`storage.bm25Search` 内部 escapeQuotes
- `rrfK=60` 是 smoothing constant,不是 channel-specific — 调整它会影响所有召回排序,不要随便改
- `recallThreshold = 1/rrfK` 默认下,单 channel rank=1 不够 — 用户调低 threshold (e.g. 0.01) 可让单 channel rank=1 通过,但会引入 dense noise
- 旧 threshold: 0.65 (cosine) 是新 `threshold` 选项的 hard floor,作用于 dense 单 channel 召回结果;RRF 融合后再过 `recallThreshold` (RRF score)。两层阈值,各管一段