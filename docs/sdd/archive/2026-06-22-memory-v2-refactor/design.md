# Design: memory-v2-refactor

## Context

### 当前系统状态

`extensions/personal-assistant/memory.ts` (1928 行) 是 v1 架构,在生产环境跑了 ~1 个月。Production 数据 (`~/.pi/agent/data/memory.db`):

- 48 active atom + 129 archived = 177 总 atom
- 仅 3 个 active atom 有 stored embedding (6.25% 覆盖率)
- 36 个 stored embedding 几乎都是 archived 阶段算的,新 atom 永不算
- 同 title 3 组 collision ("Amplicon result check workflow" ×3, "多选..." ×2, "Cron..." ×2)
- Live API 实测:query="图片" 返 10 atom,无 1 个含"图片" (FTS 中文 tokenization 失败 + LLM 改写错位)

### 已知问题 (38 个)

**压缩/提取侧 (12)**: 输入截断 (8000 字符), 输出限制 (2048 tokens), "summary: one-sentence summary" 强制一句话, "Skip routine conversation" 主动劝少提, type 描述 1 行无区分准则, LLM 自决 create/update/skip 经常选错, create 路径无去重, content 默认 = summary, **新 atom 不算 embedding**, update 路径 `...changes` 全覆盖 tags/strength, 无并发锁, existingAtoms 仅 FTS top-5。

**编辑侧 (3)**: webui PATCH `...body` 全字段覆盖, 用户清空 tags input 丢失 tags, `invalidateEmbedding` 不重算。

**检索侧 (10)**: FTS5 unicode61 CJK 失败, FTS 不索引 summary/content, FTS 0 命中 `return []` 无 fallback, 新 atom 无 stored embedding → cosine=0, 不现场算, simpleKeywordExtraction 中文瞎, 无 query expansion, 无同义词, 无结果多样化, 无 token budget。

**注入侧 (5)**: 只展示 summary, hard cap maxInjection, 无 token budget, 无 multi-block, 无 recency 排序。

**衰减/归档侧 (5)**: importance=0 不衰减, 触发在 session_start, constraint 永不 archive, access_count 不衰减, markArchived 不删 file。

**存储/数据侧 (3)**: slug collision 覆盖文件, 无 title UNIQUE, migration 时 fingerprint/id 错配。

### 为什么需要这次变更

痛点不再是"修小 bug",是**架构**问题:
1. LLM 角色错位 — 让 LLM 决定 create/update,但 LLM 没足够上下文
2. 检索错误范式 — FTS + 混合评分无法解决中文语义
3. 闭环缺失 — embedding 永远不算,新 atom 永远找不到
4. 文件路径脆弱 — slug collision = silent overwrite

## Goals / Non-Goals

### Goals

1. **更高质量记忆**: 200k token session 产出 20-50 个 atom,每个 2-4 段详细 content
2. **准确中文召回**: bge-m3 语义级,中文 query 直接命中中文 atom
3. **存储零碰撞**: id-based file path,content-based fingerprint
4. **Embedding 闭环**: 写入同步算 + 编辑重算 + 归档删
5. **3 类 type 简化**: rule / fact / process,LLM 认知负担降低
6. **L0/L1 双层注入**: top-3 看完整 content,其余看 summary,token budget 控制

### Non-Goals

- 不迁移旧数据 (177 atom 废弃)
- 不做 webui 前端 (后续 change)
- 不引入外部向量数据库 (sqlite-vec 单文件)
- 不做 query expansion / 同义词 / 多样化
- 不做 multi-block 注入 (slots/profile/lessons)
- 不切换 extraction model (仍用 MiniMax-M3)
- 不重做 decay 公式

## Decisions

### 1. 纯向量检索,删除 FTS5

**Decision**: 完全删除 `memory_fts` 表和所有 BM25/FTS5 相关代码。检索只用 sqlite-vec KNN。

**Rationale**: 
- FTS5 unicode61 对 CJK tokenization 失败,中文 query 几乎 0 命中
- LLM 改写 query 把中文译英文,加剧错位
- bge-m3 是多语言 embedding 模型,直接 embed 原文即可
- 混合检索(FTS + Vector)复杂度高,效果不如纯 vector

**Alternatives considered**:
- **Trigram tokenizer** (`tokenize='trigram'`): 任何 substring 都能匹配,但索引 ×3,查询 ×10 慢
- **Jieba 中文分词**: npm 包大,需 C++ 编译,跨平台麻烦
- 放弃: bge-m3 语义级已经够好,不需要词袋级匹配

### 2. LLM 只输出 content,代码决定存储

**Decision**: 去掉 LLM 输出 schema 的 `action`/`id`/`changes` 字段。LLM 只返 `{type, title, content, summary, tags, importance}`。代码基于 content fingerprint + cosine 决定 skip / supersede / create。

**Rationale**:
- LLM 经常选错 create/update (production 数据实证)
- 内容指纹 (sha256 normalized) + cosine 相似度是确定性的
- 同 content → 同 fingerprint → 同 atom (idempotent)
- 相似 content → cosine > 0.92 → 自动 supersede

**Alternatives considered**:
- **保留 LLM update + Jaccard dedup**: Jaccard 词袋瞎,中文 compound 永远 0
- **保留 LLM update + embedding dedup**: 让 LLM 选 update 但用 embedding 验 → 复杂,且 supersede 链需手工建
- 放弃: 让代码全权决定

### 3. 3 大类 type 替代 8 类

**Decision**: 把 constraint/preference/workflow/knowledge/event/solution/insight/bug 合并为 rule/fact/process 三大类。

**Rationale**:
- LLM 8 选 1 容易错,3 选 1 不易错
- 用户的 prompt 描述 8 类时容易混淆 (e.g., "修法" 是 solution 还是 knowledge?)
- 新架构下 type 功能降级为 informational (除 rule 例外)
- rule 例外: 用户硬规则/偏好,Decay 不应自动归档

**Mapping**:

| 旧 type | 新 type | 说明 |
|---------|---------|------|
| constraint | rule | 硬规则 |
| preference | rule | 偏好 |
| workflow | process | 流程 |
| knowledge | fact | 知识 |
| event | fact | 事件 |
| solution | process | 解决方案 |
| insight | process | 模式 |
| bug | fact | 已知 bug |

### 4. 文件路径用 atom.id,不再用 slug

**Decision**: 写 `atoms/<type>/<randomUUID>.md`。删除 `slugify()` 逻辑。

**Rationale**:
- id 是 UUID,无 collision 风险
- title 可变 (用户编辑),不应影响文件路径
- 同 title 多 atom 用不同 UUID,各自独立

**Alternatives considered**:
- **`<type>/<slug>-<id-prefix>.md`**: 人类可读但路径丑陋
- **`<type>/<content-fingerprint>.md`**: id 耦合 content,content 改了路径错
- 放弃: 简洁 UUID 路径

### 5. L0/L1 双层注入

**Decision**: 默认注入 L0 (title + summary + tags)。Top-3 atom 升级到 L1 (title + summary + content + tags)。Token budget 控制总大小 (默认 4000 tokens)。

**Rationale**:
- OpenViking L0/L1/L2 分层太复杂,3 层 → 2 层
- 读 .md 是 I/O,top-K 5 个全读 = 50ms 慢,只读 top-3 = 30ms OK
- L0 已覆盖大部分信息 (summary 一句话 + tags),L1 是补充
- Token budget 而非硬限 top-K,灵活

**L0 块**:
```xml
<memory type="rule" importance="0.95">
  <title>服务器操作必须用 tmux</title>
  <summary>用户硬规则:...</summary>
  <tags>tmux, 服务器</tags>
</memory>
```

**L1 块**:
```xml
<memory type="rule" importance="0.95">
  <title>服务器操作必须用 tmux</title>
  <summary>用户硬规则:...</summary>
  <content>完整 markdown body...</content>
  <tags>tmux, 服务器</tags>
</memory>
```

### 6. Embedding 写入同步算 + Embed 完整文本

**Decision**: 
1. 每次创建/编辑 atom 时,**同步**调 `embedText(embeddableText)`,写入 `memory_vectors`。删除"fire-and-forget" 模式。
2. **`embeddableText` = `title + "\n\n" + summary + "\n\n" + content + "\n\n" + tags.join(" ")`,NOT 仅 title**。

**Rationale**:
- **只 embed title 召回率差**: 实验和直觉都显示 (agentmemory benchmark 已验证),仅 title 的语义向量召回率远低于 full content。用户已明确指出这个风险。
- **embed full text**: agentmemory 用 `text: memory.title + ' ' + memory.content` 验证可行。我们用类似组合,但额外加 summary + tags 以提升 query 命中时的语义覆盖。
- **bge-m3 单次 ~50ms**: 30 atom 一次性 extraction = 1.5s,可接受
- **同步保证**: 写入后立即可被检索,无 "新 atom 永远找不到" 风险
- **失败降级**: ollama 不可用 → atom 仍写入,但 vector 列空 → recall 时该 atom 不命中 (但 fingerprint dedup 仍工作)

**Embeddable text 构造**:
```typescript
function buildEmbeddableText(atom: MemoryAtom): string {
  return [
    atom.title,
    atom.summary,
    atom.content,
    atom.tags.join(" "),
  ].filter(Boolean).join("\n\n");
}
```

**Search query embed**: query 直接 embed (已经是自然语言),不拼接 metadata。

**Alternatives considered**:
- **Fire-and-forget async**: 优点快,缺点新 atom 找不到 (production 实证问题)
- **Background batch job**: 复杂,引入队列
- **只 embed title**: 召回率差,已被否定
- 放弃: 同步 + full text 简单,延迟可接受,召回率高

### 7. SQLite 事务保证 supersede 原子性

**Decision**: supersede 旧 atom + 插入新 atom 用 `BEGIN IMMEDIATE` 包成一个事务。指纹唯一索引防并发重复。

**Rationale**:
- 旧 atom 标 `is_latest=0` 和 新 atom INSERT 必须原子,否则 DB 半状态
- fingerprint UNIQUE INDEX 让重复 content 自动 fail
- SQLite 串行写,事务隔离足够

### 8. 不做 fallback

**Decision**: ollama 不可用 → recall 返回空,extraction 跳过 dedup 但仍写入 (无 embedding)。

**Rationale**:
- 用户明确决策
- Fallback 路径复杂,且无法根本解决中文问题
- 显式失败 = 显式信号,运维看到 ollama 挂了就修

## Architecture

### 组件划分

```
extensions/personal-assistant/
├── memory.ts                    # 入口,导出 API
├── types.ts                     # MemoryAtom, MemoryAtomType, QueryRewriteResult (deprecated)
├── storage.ts                   # MemoryIndex (better-sqlite3 + sqlite-vec)
├── file-store.ts                # writeAtomToFile / readAtomFromFile
├── extraction.ts                # extractMemories + executePlan + helpers
├── search.ts                    # recallAtoms + vectorSearch
├── format.ts                    # formatMemoryContext L0/L1
├── decay.ts                     # runDecay
├── audit.ts                     # memory_audit helpers
├── embed.ts                     # embedText + buildEmbeddableText (唯一 ollama 调用点)
└── test/
    ├── extraction.test.ts
    ├── search.test.ts
    ├── storage.test.ts
    ├── decay.test.ts
    ├── supersede.test.ts
    └── fingerprint.test.ts

packages/webui/server/routes/
└── memory.ts                    # 7 REST routes (list/stats/get/patch/archive/search/extract)
```

### 数据流

**Write (extraction)**:
```
session_before_compact → extractMemories
  ↓
LLM (MiniMax-M3) call with prompt v2
  ↓
Plan items: {type, title, content, summary, tags, importance}
  ↓ (per item)
normalizeContent + sha256 fingerprint
  ↓
DB has fingerprint? → skip
  ↓ (no)
embedText(content) → 1024-dim vector
  ↓
findMostSimilarEmbedding(vector, 0.92) → {atom, distance}
  ↓
BEGIN TX:
  similar? → markSuperseded(old) + insertAtom(new, parent_id=old.id) + insertVector(new)
  else     → insertAtom(new, parent_id=null) + insertVector(new)
COMMIT
  ↓
writeAtomToFile(atom, atomsDir) → atoms/<type>/<id>.md
```

**Recall (主对话)**:
```
before_agent_start (prompt) → pendingMemorySearch = recallAtoms(...)
  ↓
embedText(prompt) → query_vector
  ↓
sqlite-vec KNN: SELECT id, distance FROM memory_vectors WHERE embedding MATCH ? AND k=10
  ↓
JOIN memory_index WHERE archived=0 AND is_latest=1 (optional type IN ...)
  ↓
Hydrate 5 atoms
  ↓
updateAccess(id) for each
  ↓
For top-3: readAtomFromFile(file_path, content_hash) → full content
For others: use DB row (content="")
  ↓
Return RecallResult[] with tier "L1" / "L0"
```

**Inject (context handler)**:
```
context event → Promise.race([recallAtoms, timeout(8000)])
  ↓
formatMemoryContext(results, tokenBudget=4000)
  ↓
For each result (sorted by distance):
  block = formatMemoryBlock(atom, tier)
  if used_tokens + block_tokens > tokenBudget: stop
  add block
  ↓
<memory-context>\n{block1}\n{block2}...\n</memory-context>
  ↓
Inject into last user message
```

**Edit (Webui PATCH)**:
```
PATCH /api/memory/:id → merge body with existing
  ↓
tags: union (existing + body)
content: body.content ?? existing.content
importance: body.importance ?? existing.importance
  ↓
BEGIN TX:
  updateAtom(merged) → memory_index
  embedText(merged.content) → new_vector
  updateVector(id, new_vector) → memory_vectors
COMMIT
  ↓
writeAtomToFile(merged, atomsDir) → .md file
```

**Decay (session_start)**:
```
session_start → if 1h since last decay:
  for active atom:
    new_strength = strength * exp(-lambda * deltaDays / denom)
    updateStrength(atom.id, new_strength)
    if new_strength < threshold AND type != 'rule':
      markArchived(atom.id)
      deleteVector(atom.id)  ← 新增
```

### 接口定义

```typescript
// types.ts
export type MemoryAtomType = "rule" | "fact" | "process";

export interface MemoryAtom {
  id: string;                        // randomUUID
  type: MemoryAtomType;
  title: string;
  summary: string;                   // L0 注入用
  content: string;                   // L1 注入用 (load from .md)
  tags: string[];
  importance: number;                // 0.0-1.0
  strength: number;                  // 0.0-1.0 (decay)
  access_count: number;
  last_access: string;               // ISO
  created_at: string;
  updated_at: string;
  version: number;
  archived: boolean;
  file_path: string;                 // atoms/<type>/<id>.md
  content_hash: string;              // sha256(content+frontmatter)
  is_latest: boolean;                // supersede 链最新
  parent_id: string | null;          // supersede 链父
  content_fingerprint: string;       // sha256(normalize(content))[:16]
  superseded_at: string | null;
}

export interface RecallResult {
  atom: MemoryAtom;
  tier: "L0" | "L1";
  distance: number;                  // L2 from sqlite-vec
  cosine: number;                    // 1 - distance/2 (normalized)
}

export interface ExtractionItem {
  type: MemoryAtomType;
  title: string;
  content: string;                   // 2-4 段
  summary: string;
  tags: string[];
  importance: number;
}

export interface ExtractionResult {
  created: Array<{ id: string; title: string }>;
  superseded: Array<{ oldId: string; newId: string; title: string }>;
  skipped: Array<{ title: string; reason: "fingerprint"; existingId: string }>;
}

// embed.ts
export async function embedText(text: string, config?: PersonalAssistantConfig): Promise<number[] | null>;

// storage.ts
export class MemoryIndex {
  constructor(dbPath: string);
  async init(): Promise<void>;
  // atom CRUD
  insertAtom(atom: MemoryAtom): void;
  updateAtom(atom: MemoryAtom): void;
  getAtom(id: string): MemoryAtom | null;
  getActiveAtomByFingerprint(fp: string): MemoryAtom | null;
  getActiveAtoms(): MemoryAtom[];
  // supersede (transactional)
  markSupersededTx(oldId: string, newId: string): void;
  // embedding
  insertVector(id: string, embedding: number[]): void;
  updateVector(id: string, embedding: number[]): void;
  deleteVector(id: string): void;
  // search
  vectorSearch(embedding: number[], k: number, filter?: VectorFilter): Array<{id: string, distance: number}>;
  findMostSimilarEmbedding(embedding: number[], threshold: number): {atom: MemoryAtom; distance: number} | null;
  // stats
  updateAccess(id: string): void;
  updateStrength(id: string, strength: number): void;
  markArchived(id: string): void;
}

// extraction.ts
export async function extractMemories(
  messages: Array<{role: string; content: unknown}>,
  index: MemoryIndex,
  ctx: ExtensionContext,
  config: PersonalAssistantConfig,
): Promise<ExtractionResult>;

export async function runMemoryExtraction(opts: RunMemoryExtractionOptions): Promise<RunMemoryExtractionResult>;

// search.ts
export async function recallAtoms(
  index: MemoryIndex,
  query: string,
  config?: PersonalAssistantConfig,
): Promise<RecallResult[]>;

// format.ts
export function formatMemoryContext(results: RecallResult[], tokenBudget: number): string;
```

### 数据库 Schema

```sql
CREATE TABLE memory_index (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('rule', 'fact', 'process')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  strength REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  is_latest INTEGER NOT NULL DEFAULT 1,
  parent_id TEXT,
  content_fingerprint TEXT NOT NULL,
  superseded_at TEXT
);

CREATE UNIQUE INDEX idx_memory_active_fingerprint
  ON memory_index(content_fingerprint)
  WHERE archived = 0 AND is_latest = 1;

CREATE INDEX idx_memory_active_recent
  ON memory_index(last_access DESC)
  WHERE archived = 0;

CREATE VIRTUAL TABLE memory_vectors USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[1024]
);

CREATE TABLE memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 配置文件

```json
{
  "personalAssistant": {
    "memory": {
      "enabled": true,
      "embedding": { "provider": "local", "model": "bge-m3:latest" },
      "extraction": { "provider": "minimax", "model": "MiniMax-M3" },
      "decay": { "base_decay": 0.025, "archive_threshold": 0.1 },
      "injection": {
        "topK": 5,
        "tokenBudget": 4000,
        "topNL1": 3,
        "dedupThreshold": 0.92
      }
    }
  }
}
```

### 依赖变更

```json
// extensions/personal-assistant/package.json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "0.1.9"
  }
}
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| sqlite-vec 跨平台二进制不兼容 | 用 better-sqlite3 prebuilt (Win/Mac/Linux),npm install 验证 |
| bge-m3 维度写死 (1024),切换 model 需 re-embed | 文档明示,提供 re-embed script |
| cosine 0.92 阈值不准 | 暴露为 config,默认 0.92,user 可调 |
| 同步 embed 写入延迟 (~50ms × N) | N=30 时 ~1.5s,可接受;若 N>50 切 async |
| Token budget 估算粗 (2.5 char/token) | 用 char 估算对中英混合够用 |
| BEGIN IMMEDIATE 长事务锁 DB | 短事务 (< 100ms),无明显影响 |
| recall 超时 8s | 已实现,主对话正常进行 |
| production 旧数据丢失 | 用户已确认,新 DB 从零 |

## Testing Strategy

### 单元测试

**storage.test.ts** (≥10 测试):
- MemoryIndex 初始化建表
- insertAtom / updateAtom / getAtom 正确
- markSupersededTx 原子性
- vectorSearch 返 top-K by distance
- findMostSimilarEmbedding 阈值过滤
- updateAccess / updateStrength / markArchived
- content_fingerprint UNIQUE INDEX 防重复

**extraction.test.ts** (≥8 测试):
- LLM 返空 plan → 不写入
- LLM 返 1 个 item,fingerprint 不命中 → create
- LLM 返 1 个 item,fingerprint 命中 → skip
- LLM 返 1 个 item,cosine > 0.92 → supersede + transfer signals
- LLM 返 1 个 item,cosine < 0.92 → create
- LLM 返 plan JSON parse fail → 静默 skip
- executePlan 写入 .md 文件
- ollama 不可用 → skip dedup 但仍写入

**search.test.ts** (≥6 测试):
- recallAtoms 返 top-K
- type filter 工作
- archived 排除
- is_latest=0 排除
- .md 缺失 → 降级 L0
- hash mismatch → 降级 L0

**supersede.test.ts** (≥3 测试):
- 旧 atom.strength transfer 到新
- 旧 atom.access_count transfer 到新
- 旧 atom.created_at 保留

**fingerprint.test.ts** (≥3 测试):
- normalizeContent 去多余空白
- 同 content → 同 fingerprint
- normalize 移除 case/标点 差异

**decay.test.ts** (≥4 测试):
- runDecay 计算 new_strength
- rule 类型永不 archive
- fact 类型 strength < threshold → archive
- deleteVector on archive

**embed.test.ts** (≥3 测试):
- embedText 成功 → 返 1024-dim vector
- embedText 失败 → 返 null
- embedText timeout → 返 null
- **buildEmbeddableText 包含 title + summary + content + tags** (防止回归到只 embed title)

### 集成测试

- extraction 端到端:mock LLM → executePlan → DB 验证
- recall 端到端:extraction → embedding → search 命中
- Webui PATCH 端到端:list → get → patch → search 验证新 content

### 召回质量评估 (`test/recall-quality.test.ts`) — 关键!

参考 agentmemory `benchmark/quality-eval.ts` 设计,**必须有 labeled dataset + 量化指标**:

#### 测试流程

```typescript
// 1. 准备小规模 labeled dataset (10-20 atom, 5-10 labeled query)
// 真实场景模拟: 不同 type 的 atom,中英文混合
const dataset = {
  atoms: [
    { id: "a1", type: "rule", title: "服务器操作必须用 tmux",
      content: "所有远程命令必须用 tmux,不能用 nohup &",
      tags: ["tmux", "服务器"], relatedQueries: ["tmux", "远程命令"] },
    { id: "a2", type: "process", title: "Amplicon pipeline workflow",
      content: "1) check input 2) run pipeline 3) verify output",
      tags: ["amplicon", "pipeline"], relatedQueries: ["amplicon", "生信流程"] },
    { id: "a3", type: "fact", title: "PDF 图片提取必须用 pymupdf",
      content: "pypdf 无法处理 CMYK 嵌入图片,必须用 pymupdf",
      tags: ["pdf", "pymupdf"], relatedQueries: ["pdf", "图片提取"] },
    // ...
  ],
  queries: [
    { query: "服务器 tmux", relevantIds: ["a1"], category: "exact" },
    { query: "amplicon 流程", relevantIds: ["a2"], category: "semantic" },
    { query: "PDF 提取", relevantIds: ["a3"], category: "semantic" },
    { query: "图片", relevantIds: ["a3"], category: "semantic" },  // 中文
    // ...
  ],
};

// 2. 注入 dataset 到 test index
// 3. 对每 query 调 recallAtoms
// 4. 计算 metrics
function recall(retrieved, relevant, k): number {
  const topK = new Set(retrieved.slice(0, k));
  let hits = 0;
  for (const id of relevant) if (topK.has(id)) hits++;
  return hits / relevant.size;
}

// 5. 断言 metrics 满足阈值
expect(metrics.recall_at_5).toBeGreaterThanOrEqual(0.7);  // 70% 召回率
expect(metrics.recall_at_10).toBeGreaterThanOrEqual(0.85);
```

#### Mock Embedding (避免依赖 ollama)

测试用 deterministic mock embedding (hash-based, 同 agentmemory):

```typescript
function mockEmbedding(text: string, dims = 1024): Float32Array {
  const arr = new Float32Array(dims);
  // 用文本 hash 算 embedding
  // 同文本 → 同 vector (供 fingerprint)
  // 不同但语义近的文本 → 距离近 (靠 token overlap)
  // ...
}
```

#### 必须验证的场景

- **Exact match**: title 直接命中 query 关键词
- **Semantic match**: content 包含 query 含义 (e.g., "tmux" ↔ "远程命令")
- **Chinese match**: 中文 query 命中英文/中文 content
- **Type filter**: 只查 rule type → 不返 process type
- **No false positive**: 不相关 atom 不应被 recall

#### 最低质量门槛 (必须达到,否则不进 review)

- `recall@5 ≥ 0.7` (top 5 召回率 ≥ 70%)
- `recall@10 ≥ 0.85` (top 10 召回率 ≥ 85%)
- `precision@5 ≥ 0.5` (top 5 准确率 ≥ 50%)

### Live API 验证

```bash
# Extraction 后搜索
curl -sS -X POST -H "Content-Type: application/json" -d '{"query":"PDF","topK":5}' http://127.0.0.1:8741/api/memory/search

# 中文 query 命中中文 atom
curl -sS -X POST -H "Content-Type: application/json" -d '{"query":"图片提取","topK":5}' http://127.0.0.1:8741/api/memory/search

# Webui route 集成测试
npm test -- --run test/memory-routes.test.ts
```

### Lint / Type check

```bash
npm run check
```

exit 0 必须。

## Implementation Notes

### 实施顺序

1. **Phase 1 — Storage layer**:
   - 新 `storage.ts` (better-sqlite3 + sqlite-vec)
   - 新 schema 初始化
   - 单元测试 storage.test.ts

2. **Phase 2 — Embed + file-store**:
   - `embed.ts` (unified ollama call)
   - `file-store.ts` (id-based path)
   - 单元测试 embed.test.ts

3. **Phase 3 — Extraction**:
   - 新 `extraction.ts` (executePlan with dedup)
   - 新 prompt v2
   - `audit.ts`
   - 单元测试 extraction.test.ts, supersede.test.ts, fingerprint.test.ts

4. **Phase 4 — Search + Format**:
   - `search.ts` (recallAtoms + vectorSearch)
   - `format.ts` (L0/L1)
   - 单元测试 search.test.ts

5. **Phase 5 — Decay**:
   - `decay.ts` (保留 + 改 deleteVector)
   - 单元测试 decay.test.ts

6. **Phase 6 — Webui REST routes**:
   - `packages/webui/server/routes/memory.ts` (7 routes)
   - 注册到 server/index.ts
   - 单元测试 memory-routes.test.ts

7. **Phase 7 — Decay + lifecycle**:
   - registerMemory 整合所有路径
   - session_before_compact / before_agent_start hooks
   - 集成测试

8. **Phase 8 — Cleanup + CHANGELOG**:
   - 删除旧函数 (searchByFts, rewriteQuery, ...)
   - 旧 CHANGELOG entry
   - npm run check + lint

### 依赖关系

- Phase 1 (storage) 是基础
- Phase 2 (embed + file-store) 依赖 Phase 1 (storage.writeAtomToFile 调 storage)
- Phase 3 (extraction) 依赖 Phase 1+2
- Phase 4 (search + format) 依赖 Phase 1+2
- Phase 5 (decay) 依赖 Phase 1
- Phase 6 (webui routes) 依赖 Phase 1-4 (用 storage + format)
- Phase 7 (lifecycle) 依赖 Phase 1-6
- Phase 8 (cleanup) 依赖全部

### 注意事项

1. **better-sqlite3 是 native binding**: `npm install` 时需要 build tools。CI 必须 prebuild。
2. **sqlite-vec 是预编译二进制**: 通常 npm 装完就能用,跨平台。
3. **bge-m3 维度**: 1024 写死。若换 model,需 re-embed 所有 atom。
4. **transaction 短事务**: 不要在 BEGIN..COMMIT 之间 await (e.g., ollama call),否则长锁。
5. **cosine 阈值**: 暴露为 config,默认 0.92。如果发现误判多,可调到 0.95。
6. **legacy 兼容**: 完全不兼容,旧 API 路径全部废弃。

<!-- archived-with: 2026-06-22-memory-v2-refactor | status: final -->
