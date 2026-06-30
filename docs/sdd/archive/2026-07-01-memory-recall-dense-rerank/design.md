# 设计文档: memory-recall-dense-rerank

## Context

记忆召回管道当前是 hybrid 架构(dense KNN + BM25 FTS5 + RRF 融合)。实测发现 BM25 通道对中文 query 存在系统性缺陷:`escapeFtsQuery` 白名单正则把 CJK 全替换成空格,中文 query 塌缩成剩余英文 token,特异性丢失;FTS5 仍索引 `content` 列(embedding v2 已去 content),正文偶然同现 token 即命中;rank-only RRF 放行单通道 rank-0,无 BM25 绝对分下限。

此外,`queryRewrite` 配置字段是死代码(`before_agent_start` 从不读取),`CLAUDE.md` 引用已删函数,`spec.md` 存在 hybrid vs 纯向量检索的矛盾段落。

本变更将召回架构从 hybrid 改为纯 dense 单通道 + 严格 cosine floor 门控,同步清理 BM25/FTS/RRF 全部代码和文档残留。

## Goals / Non-Goals

**Goals**:
- 删除 BM25/FTS5/RRF 通道,消除中文 query 误命中
- cosine floor 从 0.65 提到 0.7,作为唯一门控
- 清理 query rewrite 死代码 + CLAUDE.md/spec.md 失效段落
- 保留 scoring 公式 / per-type top-3 + round-robin / L0 discovery-only 不变

**Non-Goals**:
- 不加 rerank(ollama 不支持 cross-encoder,对当前规模过度工程)
- 不换 ollama(embedding 继续走 ollama)
- 不动 DB schema 主体(仅删 `memory_fts` 虚拟表)
- 不动 extraction pipeline / format / inject

## Decisions

### Decision 1: 纯 dense 单通道替代 hybrid

**Rationale**: BM25 在当前场景是净负贡献 — FTS5 `unicode61` tokenizer 对连续 CJK 生成单 token,`escapeFtsQuery` 白名单正则把 CJK 全剥光,中文 query 塌缩成剩余英文 token。tagOverlap(`scoring.ts:37`)已做精确 tag 匹配,是比 FTS 全文倒排更可控的精确匹配通道。atom 库规模小(几百条),dense topK=20/类型 足够覆盖。

**Alternatives**:
- 修 BM25 中文分词(jieba-wasm / bigram)— 增加依赖,且 BM25 在小库上价值有限
- 加 cross-encoder rerank — ollama 不支持,需引入 Xinference/ONNX,过度工程

### Decision 2: cosine floor 0.65 → 0.7

**Rationale**: 删 BM25 后 dense 是唯一通道,cosine floor 是唯一召回门控。bge-m3 对同语种跨概念中文的 cosine 基线偏高(0.5-0.7),0.65 挡不住误命中。0.7 是 bge-m3 多语言场景的合理 cutoff,挡住跨概念噪声同时保留同概念命中。tagOverlap 提供精确匹配补充。

### Decision 3: 删 splitQuery,直接 embed 原文

**Rationale**: `splitQuery` 按 ASCII/CJK 边界拆段,目的是让每段独立 embed + BM25。纯 dense 下 bge-m3 是多语言模型,直接 embed 混合文本质量 OK(`embed.ts` Decision 6 / CLAUDE.md 已确认)。删 splitQuery / splitQueryRaw / mergeResults 简化管道。

### Decision 4: init() DROP 旧 memory_fts 表

**Rationale**: 现有 DB 可能有 `memory_fts` 表(旧版本创建)。`init()` 新增 `DROP TABLE IF EXISTS memory_fts` 清理旧 schema,不再 CREATE 新表。`memory_index` / `memory_vectors` 保留不动。

## Architecture

### 召回管道(简化后)

```
User prompt
   │
   ▼
embedText(bge-m3, 原文不拆段)        ← embed.ts:54, 不变
   │  null → return [] (ollama 不可用降级)
   ▼
per-type KNN(sqlite-vec, topK=20)    ← storage.ts:525 vectorSearch, 不变
   │  3 类型并行: rule / fact / process
   ▼
cosine floor 0.7 过滤                ← search.ts, 0.65 → 0.7
   │  cosine = 1 - distance²/2 (L2-normalized)
   │  c >= 0.70 通过, < 0.70 丢弃
   ▼
computeScore(乘法 boost)             ← scoring.ts:111, 不变
   │  score = cosine × (1 + 0.3s + 0.2i)
   │      + 0.10 × tagOverlap
   │      + 0.05 × freshness
   ▼
per-type top-3 截断                  ← DEFAULT_TOP_K = 3, 不变
   │  稀疏 type 自动降到实际数量
   ▼
round-robin 交错合并                  ← 不变
   │  rule[0], fact[0], process[0], rule[1], ...
   ▼
formatMemoryContext(4000 token)      ← format.ts:55, 不变
   │  distance ASC 排序后装入 budget
   ▼
injectMemoryContext                  ← memory.ts:846, 不变
   │  注入 last user message 前缀
   ▼
LLM 看到 [Relevant memory context] + [User message]
   │  通过 memory_get(id) 取全文 → bump access_count
```

### recallAtomsSingleSegment 简化

```typescript
// 简化后伪代码
async function recallAtomsSingleSegment(index, query, options) {
    const cosineFloor = options.threshold ?? 0.7;  // 从 0.65 提升
    const topK = options.topK ?? 20;

    const queryEmbedding = await embedText(query);
    if (!queryEmbedding) return [];  // ollama 不可用

    const perTypeResults = await Promise.all(
        TYPES.map(async (type) => {
            const denseHits = index.vectorSearch(queryEmbedding, topK, {
                type, isLatestOnly: true, archived: false,
            });
            // cosine floor 过滤(唯一门控)
            const filtered = denseHits.filter((d) => {
                const c = 1 - (d.distance * d.distance) / 2;
                return c >= cosineFloor;
            });
            // computeScore + hydrate
            const scored = filtered.map((d) => {
                const atom = index.getAtom(d.id);
                if (!atom) return null;
                const cosine = 1 - (d.distance * d.distance) / 2;
                const scoredAtom = computeScore(cosine, atom, query, {
                    tagOverlapWeight: options.tagOverlapWeight,
                    freshnessWeight: options.freshnessWeight,
                    tagAliases: options.tagAliases,
                });
                return { atom, distance: d.distance, cosine,
                         score: scoredAtom.score,
                         tagOverlap: scoredAtom.tagOverlap,
                         freshness: scoredAtom.freshness };
            }).filter(Boolean);
            // score DESC 排序 + top-3 截断
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, DEFAULT_TOP_K);
        }),
    );
    // round-robin 交错(不变)
    return interleave(perTypeResults);
}
```

### recallAtoms 简化

```typescript
// 不再有 splitQuery 分支,直接调单段
export async function recallAtoms(index, query, options = {}) {
    if (!query || query.trim().length === 0) return [];
    return recallAtomsSingleSegment(index, query, options);
}
```

### RecallOptions 精简

```typescript
export interface RecallOptions {
    topK?: number;
    threshold?: number;           // cosine floor, 默认 0.7
    filter?: { type?: MemoryAtom["type"] };
    tagOverlapWeight?: number;
    freshnessWeight?: number;
    tagAliases?: Record<string, string> | null;
    // 删除: rrfK, recallThreshold
}
```

## Existing Code to Reuse

### Reuse: embedText
- **Path**: `extensions/personal-assistant/embed.ts:54`
- **Why**: ollama /v1/embeddings 调用 + AbortController 超时 + null 降级,已是召回管道的 embedding 基础,纯 dense 仍依赖它
- **Risk**: 无 — 调用方式不变,仍是 `embedText(text) → number[] | null`
- **Decision**: reuse

### Reuse: vectorSearch
- **Path**: `extensions/personal-assistant/storage.ts:525`
- **Why**: sqlite-vec KNN 查询 + buildActiveFilter WHERE 子句,是纯 dense 检索的唯一数据库入口
- **Risk**: 无 — 签名/行为不变,仍是 `vectorSearch(embedding, k, filter) → [{id, distance}]`
- **Decision**: reuse

### Reuse: buildActiveFilter
- **Path**: `extensions/personal-assistant/storage.ts:491`
- **Why**: 构建 `archived=0 AND is_latest=1 AND type=?` WHERE 子句,vectorSearch 依赖它
- **Risk**: 无 — 纯函数,行为不变
- **Decision**: reuse

### Reuse: computeScore
- **Path**: `extensions/personal-assistant/scoring.ts:111`
- **Why**: 乘法 boost 公式 `cosine × (1 + 0.3s + 0.2i) + 0.10×tagOverlap + 0.05×freshness`,是 score 计算的核心,与召回通道无关
- **Risk**: 无 — 签名/公式不变
- **Decision**: reuse

### Reuse: computeTagOverlap
- **Path**: `extensions/personal-assistant/scoring.ts:37`
- **Why**: tag 精确匹配 + alias folding,是 BM25 删除后的精确匹配补充
- **Risk**: 无 — 纯函数,行为不变
- **Decision**: reuse

### Reuse: computeFreshness
- **Path**: `extensions/personal-assistant/scoring.ts:57`
- **Why**: `exp(-daysSinceUpdate / 30)` freshness 衰减,scoring 公式的 additive 项
- **Risk**: 无 — 纯函数,行为不变
- **Decision**: reuse

### Reuse: formatMemoryContext
- **Path**: `extensions/personal-assistant/format.ts:55`
- **Why**: distance ASC 排序 + token budget 装入 + block 格式化,是 L0 注入的格式化层,与召回通道无关
- **Risk**: 无 — 签名/行为不变
- **Decision**: reuse

### Reuse: injectMemoryContext
- **Path**: `extensions/personal-assistant/memory.ts:846`
- **Why**: context hook 注入逻辑(8s race + last user message 前缀),与召回通道无关
- **Risk**: 无 — 签名/行为不变
- **Decision**: reuse

### Reuse: DEFAULT_TOP_K / TYPES
- **Path**: `extensions/personal-assistant/search.ts:95` / `search.ts:121`
- **Why**: per-type top-3 截断 + 类型列表 `["rule","fact","process"]`,round-robin 交错依赖
- **Risk**: 无 — 常量不变
- **Decision**: reuse

### Delete: rrfFuse
- **Path**: `extensions/personal-assistant/search.ts:163`
- **Why**: 单通道无融合需求
- **Decision**: delete

### Delete: splitQuery / splitQueryRaw / mergeResults
- **Path**: `extensions/personal-assistant/search.ts:328` / `search.ts:259` / `search.ts:368`
- **Why**: bge-m3 多语言直接 embed 原文,不需要按 ASCII/CJK 分段;单 query 不需要 OR-merge
- **Decision**: delete

### Delete: bm25Search / escapeFtsQuery / MEMORY_FTS_SCHEMA
- **Path**: `extensions/personal-assistant/storage.ts:575` / `storage.ts:81` / `storage.ts:1123`
- **Why**: BM25 通道删除
- **Decision**: delete

### Delete: DEFAULT_RRF_K / DEFAULT_RECALL_THRESHOLD / MAX_SPLIT_SEGMENTS
- **Path**: `extensions/personal-assistant/search.ts:125` / `search.ts:139` / `search.ts:110`
- **Why**: RRF / splitQuery 相关常量,不再使用
- **Decision**: delete

### Delete: DEFAULT_DENSE_COSINE_FLOOR
- **Path**: `extensions/personal-assistant/search.ts:118`
- **Why**: 值从 0.65 改为 0.7,语义不变但值变;内联为新常量或直接改值
- **Decision**: modify (0.65 → 0.7)

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| 纯 dense 对"必须精确出现的 token"(项目 ID / 文件路径)检索力弱 | tagOverlap 精确匹配补充;extraction 应给 atom 打精确 tag |
| cosine floor 0.7 可能漏召同概念但表述不同的 atom | bge-m3 同概念 cosine 通常 ≥ 0.75,0.7 留有余量;tagOverlap 提供额外命中路径 |
| 删 FTS 后旧 DB 的 `memory_fts` 表残留 | `init()` 新增 `DROP TABLE IF EXISTS memory_fts` |
| `spec.md` 编辑范围大 | 只删矛盾段(hybrid/RRF/BM25),保留纯向量检索段(line 1420) |

**Trade-off accepted**: 放弃 BM25 的精确匹配能力,换取中文检索的可靠性。tagOverlap 是更可控的精确匹配通道(人工/LLM 策展的 tags vs FTS 全文倒排)。

## Testing Strategy

### Unit tests (修改)
- `extensions/personal-assistant/test/search.test.ts` — 删 RRF/splitQuery/mergeResults 测试,改 recallAtoms 为纯 dense 断言
- `extensions/personal-assistant/test/storage.test.ts` — 删 `memory_fts` / `bm25Search` / `escapeFtsQuery` 全部测试,新增 `DROP TABLE IF EXISTS memory_fts` 测试

### Regression test (新增)
- `extensions/personal-assistant/test/regressions/recall-dense-floor.test.ts` — 重现 `然后制做成为novo skill → BMK 报告品牌替换` 误命中场景,验证 cosine < 0.7 被门控

### Boundary tests (新增/修改)
- cosine 恰好 0.70 通过 `>=`
- ollama 不可用 → `[]`
- 空 query → `[]`
- 所有候选 < 0.7 → `[]`
- 某一 type 无候选 → round-robin 跳过

### 验证命令
```bash
./test.sh                                    # 非 e2e 全量
node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts   # 单文件
node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts
npm run check                                # 类型 + lint
```

## Implementation Notes

### 执行顺序(给 sdd-write_plan)

1. **storage.ts FTS 清理** — 删 `escapeFtsQuery` / `bm25Search` / `MEMORY_FTS_SCHEMA` + init/insert/supersede/archive 中的 FTS 同步逻辑 + 新增 `DROP TABLE IF EXISTS memory_fts`
2. **search.ts 召回简化** — 删 `rrfFuse` / `splitQuery` / `splitQueryRaw` / `mergeResults` + 简化 `recallAtomsSingleSegment` + cosine floor 0.7 + 精简 `RecallOptions`
3. **memory.ts 死代码清理** — 已提前删除 `queryRewrite` 字段;清理 `recall` 配置中的 `rrfK` / `recallThreshold` 读取
4. **CLAUDE.md 清理** — 删 line 63 "必重建 FTS 行" / line 65 rewriteQuery 引用 / line 86-92 hybrid 原则段
5. **spec.md 消除矛盾** — 删 line 1129-1206 v1 search 路由 spec / line 1687-1730 hybrid/RRF/BM25 要求段
6. **测试更新** — 删 FTS/RRF 测试,新增 dense floor regression 测试

### 注意事项

- `PersonalAssistantConfig.memory.recall` 里的 `rrfK` / `recallThreshold` 字段也要删(死配置)
- `registerPostSearch` (`packages/webui/server/routes/memory.ts:793`) 读取 `m?.recall?.rrfK` / `m?.recall?.recallThreshold`,要同步删
- `before_agent_start` hook (`memory.ts:694`) 传 `rrfK` / `recallThreshold`,要同步删
- `buildEmbeddableText` / `CURRENT_EMBEDDABLE_TEXT_VERSION` 不动(embedding 层不受影响)

<!-- archived-with: 2026-07-01-memory-recall-dense-rerank | status: final -->
