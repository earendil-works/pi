# 变更提案: memory-v2-refactor

## 动机

当前 `extensions/personal-assistant/memory.ts` 是 v1 架构,有 38 个已知问题 (生产实证),核心痛点:

1. **记忆质量差**: Extraction prompt 限制输入 8000 字符 / 输出 2048 tokens / "one-sentence summary",200k token session 只能挤出 5-10 个一句话 atom
2. **检索召回差**: FTS5 unicode61 中文 tokenization 失败,中文 query 几乎 0 命中;query 经常被 LLM 翻译成英文 keywords 跟中文 title 错位
3. **存储 collision**: 同 title atom 用 slug 路径,后写者覆盖前写者文件,产生 "file hash mismatch" banner
4. **Embedding 永不算**: 新 atom 创建后从不调 `upsertEmbedding`,只有 nanobot migration 时一次性算的 36 个老 atom 有 embedding (其中 33 个是 archived 的,active 中仅 3 个)
5. **LLM 决定存储**: LLM 自决 create/update/skip,经常选错

参考了 `/home/qjh/workspace/learn/agent-memroy/agentmemory` (OpenViking 风格 + supersede 链 + content fingerprint + Jaccard dedup) 和 OpenViking 的 L0/L1/L2 分层,但用更简化的实现 (sqlite-vec + bge-m3,不用外部服务)。

用户明确决策: 不做存储迁移 (旧数据废弃),不做 fallback (失败即空),纯语义检索,3 大类。

## 影响范围

- **新增 Capability**: `memory-v2` (纯向量检索 + 3 大类 type + L0/L1 双层注入 + 内容指纹去重 + supersede 链)
- **修改 Capability**:
  - `personal-assistant` (扩展,改 memory 模块)
  - `webui-server-memory-api` (新增 REST 路由,memory-routes.ts 改写)
- **删除 Capability**:
  - FTS5 索引 (`memory_fts` 表)
  - `searchByFts` / `searchAtoms` / `searchAtomsWithScores` (混合检索函数)
  - `rewriteQuery` / `rewriteQueryWithCallLlm` / `callOllamaRewrite` (LLM 改写 query)
  - `simpleKeywordExtraction` / `dedupeRedundantKeywords` / `dedupeAgainstQuery` (关键词 dedup)
  - `expandCjkKeywords` (CJK 拆字,改用 embedding 语义)
  - `isEmbeddingServiceAvailable` (badge,失败即空)
  - slug 文件路径 (`<type>/<slug>.md` 改 `<type>/<id>.md`)

## 非目标

- **不迁移旧数据**: production 的 177 atom 废弃,新 DB 从零开始
- **不做 webui 前端**: MemoryPage / MemoryList / MemoryDetail / MemoryEditor / MemorySearchTester 等组件本次不动 (后续 change 处理)
- **不引入外部向量数据库**: 仅用 better-sqlite3 + sqlite-vec 扩展,本地单文件
- **不做 query expansion / 同义词 / 结果多样化**: 纯 cosine KNN,简单
- **不做 multi-block 注入**: 仅 L0/L1 两层,无 profile/lessons/slots
- **不做 token-budget 全局 LLM 预算**: 仅控制 memory-context 块大小
- **不重做 decay 公式**: 保留现有公式,只调架构
- **不切换 extraction model**: 仍用 MiniMax-M3

## 验收标准

1. **新 schema 启动正常**: `bun:sqlite` + sqlite-vec 加载,`memory_index` + `memory_vectors` + `memory_audit` 表创建
2. **Extraction 端到端工作**: session_before_compact 触发 → LLM extraction prompt v2 → 至少 5 个 atom 产出 (用 mock LLM 测) → 每 atom content > 200 字符
3. **Dedup 工作**:
   - 同 content emit 两次 → 第 2 次 skip (fingerprint match)
   - cosine > 0.92 的相似 content → supersede (旧 is_latest=0,新 parent_id=old.id)
4. **Retrieval 工作**:
   - 中文 query → 命中中文 title atom (验证 bge-m3 语义级)
   - 英文 query → 命中英文 atom
   - Type filter 工作 (`?type=rule` 只返 rule)
5. **L0/L1 注入**:
   - Top-3 atom 输出 `<content>` (L1)
   - 其余 atom 只输出 `<summary>` (L0)
   - Token budget 截断生效 (4000 tokens 默认)
6. **Webui REST routes**:
   - GET /api/memory (list+filter)
   - GET /api/memory/stats
   - GET /api/memory/:id (load .md body)
   - PATCH /api/memory/:id (union tags + async embed)
   - POST /api/memory/:id/archive
   - POST /api/memory/search (recall + token budget)
   - POST /api/memory/extract (runMemoryExtraction standalone)
7. **Tests 全绿**:
   - `memory-exports.test.ts`: ≥ 30 测试
   - `memory-routes.test.ts`: ≥ 21 测试
   - `npm run check` exit 0
8. **Decay 保留旧行为**:
   - runDecay 每小时跑一次,session_start 触发
   - `rule` 类型永不 auto-archive
   - markArchived 后从 recall 排除
9. **审计**:
   - 每次 create/supersede/archive 写 memory_audit
   - 审计可查 (新增 `GET /api/memory/audit?atom_id=...` 不在 v2 scope,只保证写入了)
10. **失败处理**:
    - ollama 不可用 → recall 返空,extraction skip dedup 但仍写入
    - .md 文件丢失 → 该 atom 降级到 L0 (无 content)
    - 8 秒超时 → recall 静默失败,主对话无注入

## 技术选型

| 项 | 选型 | 原因 |
|----|------|------|
| SQLite driver | better-sqlite3 | 支持 sqlite-vec 扩展加载 |
| 向量扩展 | sqlite-vec | 单文件存储,跨平台,官方 (alex.garcia) |
| Embedding | ollama bge-m3 (1024 dim) | 多语言,本地,已在 production 用 |
| Extraction model | MiniMax-M3 | 不变 |
| 测试 | vitest | 不变 |
| Type | TypeScript | 不变 |

## 不在此次范围但后续要做

- Webui MemoryPage / MemoryList 等前端组件 (后续 change)
- Query expansion (LLM 多 reformulation)
- Result diversification (maxPerSession)
- Multi-block injection (slots/profile/lessons)
- Graph retrieval (实体关系图)
- Embedding model hot-swap (切换 model 时 re-embed all)
