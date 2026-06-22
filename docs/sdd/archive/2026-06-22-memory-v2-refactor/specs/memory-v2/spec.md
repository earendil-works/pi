# memory-v2 Specification

## ADDED Requirements

### Requirement: MemoryAtom 3 大类 (rule/fact/process)
MemoryAtom SHALL 用 `"rule" | "fact" | "process"` 三种类型。rule 包含用户的硬规则和偏好;fact 包含客观事实、时间事件、已知 bug;process 包含可执行流程、解决方案、跨 case 模式。

#### Scenario: type 字段只能是 3 选 1
- **GIVEN** extension 加载 `MemoryAtomType`
- **WHEN** 读取 `atom.type` 字段
- **THEN** 字段值是 `"rule"` 或 `"fact"` 或 `"process"`

#### Scenario: rule 类型永不因 strength 低而 archive
- **GIVEN** atom.type="rule",strength=0.05 (远低于 archiveThreshold)
- **WHEN** `runDecay(index, baseDecay, archiveThreshold)` 执行
- **THEN** atom.archived 仍为 false

#### Scenario: DB schema 强制 type CHECK 约束
- **GIVEN** `memory_index` 表已创建
- **WHEN** 尝试 `INSERT INTO memory_index (type, ...) VALUES ('constraint', ...)`
- **THEN** SQLite 抛 CHECK constraint failed 错误

### Requirement: 内容指纹 dedup (sha256 normalize)
MemoryIndex SHALL 用 `content_fingerprint = sha256(normalizeContent(content)).slice(0, 16)` 作为精确去重的唯一标识,DB 唯一索引防并发重复。

#### Scenario: 同 normalized content 写入第二次被 UNIQUE INDEX 拦截
- **GIVEN** atom A 已存在,content_fingerprint="abc123def456"
- **WHEN** 尝试 INSERT 新 atom B, content_fingerprint="abc123def456"
- **THEN** SQLite 抛 UNIQUE constraint failed 错误 (idx_memory_active_fingerprint)
- **AND** INSERT 自动回滚

#### Scenario: normalizeContent 折叠空白 + lowercase
- **GIVEN** content = "PDF 图片  提取  \n\n"
- **WHEN** `normalizeContent(content)` 执行
- **THEN** 返回 `"pdf 图片 提取"` (多个空格折叠成 1,小写,trim)

### Requirement: 余弦相似度去重阈值默认 0.92
executePlan SHALL 用 cosine 相似度阈值 0.92 判定 supersede。cosine > 0.92 → supersede 旧 atom 并新建带 parent_id 的 atom;cosine ≤ 0.92 → 新建独立 atom。

#### Scenario: cosine > 0.92 触发 supersede
- **GIVEN** atom A 已存在,embedding=[0.1, 0.2, ..., 0.5] (1024-dim)
- **AND** 新 item.content 算出的 embedding=[0.11, 0.21, ..., 0.51]
- **AND** cosine(A_emb, new_emb) = 0.93 > 0.92
- **WHEN** executePlan 处理该 item
- **THEN** atom A.is_latest=0
- **AND** 新 atom B.is_latest=1, B.parent_id=A.id
- **AND** A.strength transfer 到 B.strength
- **AND** A.access_count transfer 到 B.access_count

#### Scenario: cosine ≤ 0.92 创建独立 atom
- **GIVEN** 现有 atom 都不与新 item 相似 (cosine 都 ≤ 0.92)
- **WHEN** executePlan 处理新 item
- **THEN** 新 atom C.is_latest=1, C.parent_id=null
- **AND** DB 中现存 atom 的 is_latest 字段不变

### Requirement: SQLite 事务保证 supersede 原子性
supersede 旧 atom (UPDATE is_latest=0) + 插入新 atom (INSERT) + 写 audit 必须用 `BEGIN IMMEDIATE` 包成一个事务。事务失败自动 rollback,DB 不留半状态。

#### Scenario: 事务中插入新 atom 失败 → 旧 atom is_latest 仍是 1
- **GIVEN** BEGIN TX 已执行,旧 atom A 已 UPDATE is_latest=0
- **AND** INSERT 新 atom B 抛错 (e.g., UNIQUE 冲突)
- **WHEN** 事务回滚
- **THEN** atom A.is_latest 仍是 1 (rollback 恢复)
- **AND** 新 atom B 不存在

#### Scenario: 成功提交事务后两 atom 状态正确
- **GIVEN** atom A is_latest=1,parent_id=null
- **WHEN** markSupersededTx(A.id, B.id) 成功执行
- **THEN** A.is_latest=0, A.superseded_at 不为空
- **AND** B.is_latest=1, B.parent_id=A.id
- **AND** memory_audit 有 2 条记录 (A action='mark_superseded', B action='create')

### Requirement: Extraction prompt 移除 LLM 决策字段
Extraction prompt SHALL 不让 LLM 决定 create/update/skip,只让 LLM 输出 `{type, title, content, summary, tags, importance}`。LLM 不知道也不关心 dedup。

#### Scenario: prompt 不含 "action" 或 "update" 关键词
- **GIVEN** EXTRACT_PROMPT_V2 常量
- **WHEN** 检查 prompt 文本
- **THEN** 不含 `"action"` / `"create"` / `"update"` / `"skip"` / `"id"` (除了 reference to existing atoms id)

#### Scenario: prompt 要求 2-4 段 content
- **GIVEN** EXTRACT_PROMPT_V2
- **WHEN** 读取 "content" 字段说明
- **THEN** 含 "2-4 段" 或等效描述 (e.g., "detailed description covering multiple paragraphs")
- **AND** 不含 "one-sentence"

#### Scenario: prompt 含 3 类 type 标准
- **GIVEN** EXTRACT_PROMPT_V2
- **WHEN** 读取 "Memory Type" 段
- **THEN** 含 rule / fact / process 三个 type 的定义
- **AND** 每个 type 有 trigger words + example

### Requirement: Embedding 输入是完整 atom 文本
`embedText(embeddableText)` SHALL 接受 `title + summary + content + tags` 拼接的文本作为输入,而非仅 title。

#### Scenario: buildEmbeddableText 包含所有字段
- **GIVEN** atom.title="X", atom.summary="Y", atom.content="Z", atom.tags=["A", "B"]
- **WHEN** `buildEmbeddableText(atom)` 执行
- **THEN** 返回字符串包含 "X", "Y", "Z", "A", "B"
- **AND** 至少包含 1 个 `\n\n` 分隔符

#### Scenario: 写入 atom 时 embedding 内容是完整文本
- **GIVEN** executePlan 写入新 atom
- **WHEN** 调 `embedText(buildEmbeddableText(newAtom))`
- **THEN** 调 ollama 时 `input` 字段含 atom 所有字段拼接 (不只 title)

### Requirement: 纯向量检索 (无 FTS,无混合)
recallAtoms SHALL 用 sqlite-vec KNN 单向量检索,不做 FTS 匹配,不做 BM25 + Vector hybrid scoring。

#### Scenario: recallAtoms 不调 searchByFts
- **GIVEN** memory.ts / search.ts 源码
- **WHEN** `grep -n "searchByFts\|FTS5\|bm25" extensions/personal-assistant/search.ts`
- **THEN** 无匹配 (0 行)

#### Scenario: recallAtoms 走 sqlite-vec KNN
- **GIVEN** DB 有 50 atom,memory_vectors 表有对应 embedding
- **WHEN** recallAtoms(index, query) 执行
- **THEN** sqlite-vec 收到 KNN 查询 (`SELECT id, distance FROM memory_vectors WHERE embedding MATCH ? AND k = ?`)
- **AND** 不走任何 FTS MATCH 查询

### Requirement: L0/L1 双层注入 + Token budget
formatMemoryContext SHALL 按 distance 排序遍历 results,每个 result:
- Top-3 (i < topNL1) → L1 tier (含 `<content>` 字段)
- 其余 → L0 tier (仅 `<title>` + `<summary>` + `<tags>`)
且总 token 数 (估算 `Math.ceil(text.length / 2.5)`) 不超过 tokenBudget。

#### Scenario: Top-3 atom 输出 L1 块
- **GIVEN** recallAtoms 返 5 atoms (按 distance asc 排序)
- **WHEN** formatMemoryContext(results, tokenBudget=4000, topNL1=3)
- **THEN** output 含 3 个 `<memory>` 块带 `<content>` 标签
- **AND** output 含 2 个 `<memory>` 块不带 `<content>` 标签
- **AND** 总 token 估算 ≤ 4000

#### Scenario: token budget 完全不够 (1 个 atom 都装不下)
- **GIVEN** tokenBudget=100,5 个 atom 每个 L0 块 ~150 tokens
- **WHEN** formatMemoryContext 执行
- **THEN** output 是空 `<memory-context>\n</memory-context>`
- **AND** 不抛错

#### Scenario: 加下一个 atom 会超 budget 时停止
- **GIVEN** 已加 3 个 L0 block (累计 300 tokens),tokenBudget=400
- **AND** 第 4 个 block ~150 tokens (加超 400)
- **WHEN** formatMemoryContext 继续遍历
- **THEN** 第 4 个 block 不加入
- **AND** output 只含前 3 个 block

### Requirement: 文件路径用 atom.id (不用 slug)
writeAtomToFile SHALL 写 `atoms/<type>/<atom.id>.md`,不使用基于 title 的 slug 路径。

#### Scenario: 文件名是 randomUUID
- **GIVEN** atom.id = "018ebaad-114c-4585-87d4-10d2c05e50c2"
- **AND** atom.type = "constraint"
- **WHEN** writeAtomToFile(atom) 执行
- **THEN** 文件创建在 `atoms/constraint/018ebaad-114c-4585-87d4-10d2c05e50c2.md`
- **AND** 路径不含 "slug" / "title" 衍生

#### Scenario: 同 title 两个 atom 写到不同文件
- **GIVEN** atom A.id="uuid-1", title="X"
- **AND** atom B.id="uuid-2", title="X" (title 相同)
- **WHEN** writeAtomToFile(A) 后 writeAtomToFile(B)
- **THEN** 写两个独立文件 (uuid-1.md, uuid-2.md)
- **AND** 无 "file hash mismatch" 错误

### Requirement: 召回失败无 fallback
recallAtoms SHALL 在 ollama 不可用时返回空数组,不退回到 FTS、关键词提取或其他检索方式。

#### Scenario: ollama 不可用 → recallAtoms 返空
- **GIVEN** ollama 进程未运行
- **AND** DB 有 atom,memory_vectors 有 embedding
- **WHEN** recallAtoms(index, query)
- **THEN** `embedText(query)` 返 null
- **AND** recallAtoms 立即返 `[]`
- **AND** 不调 searchByFts / simpleKeywordExtraction / 任何 fallback

#### Scenario: 主对话 recall 失败 → 无注入
- **GIVEN** ollama 不可用
- **WHEN** `before_agent_start` 触发 recallAtoms
- **THEN** pendingMemorySearch.promise 解析为 `[]`
- **AND** `context` handler 不注入任何 memory 块
- **AND** 主对话照常进行 (无 error)

### Requirement: Extraction ollama 失败时降级写入 (无 embedding)
executePlan SHALL 在 ollama 不可用时,跳过 dedup 检测但仍写入 atom (DB + .md),但不调 insertVector (memory_vectors 无对应行)。

#### Scenario: extraction 期间 ollama 挂 → atom 写入但无 vector
- **GIVEN** ollama 不可用
- **AND** executePlan 处理 1 个 fingerprint 不命中的 item
- **WHEN** executePlan 跑
- **THEN** fingerprint 检查 skip
- **AND** embedText 失败 → skip cosine dedup
- **AND** 新 atom C 写入 memory_index (is_latest=1)
- **AND** C 的 file_path 指向 .md 文件
- **AND** memory_vectors 表无 C.id 对应行 (后续 recall 不会找到 C)

### Requirement: Webui REST routes (7 个)
memory.ts route SHALL 暴露以下 endpoint:
- `GET /api/memory` (list + filter)
- `GET /api/memory/stats`
- `GET /api/memory/:id` (含 .md body)
- `PATCH /api/memory/:id` (union tags + recompute embedding)
- `POST /api/memory/:id/archive` (toggle)
- `POST /api/memory/search` (recall + token budget)
- `POST /api/memory/extract` (manual extraction)

#### Scenario: GET /api/memory 列表
- **GIVEN** DB 有 12 active + 3 archived atom
- **WHEN** `GET /api/memory?archived=active`
- **THEN** 返 12 个 atom JSON array,按 updated_at DESC 排序
- **AND** HTTP 200

#### Scenario: GET /api/memory/:id 含 content
- **GIVEN** atom X.file_path 指向有效 .md
- **WHEN** `GET /api/memory/X`
- **THEN** 返 atom JSON 含 `content` 字段 (从 .md 读)
- **AND** content_hash 校验通过
- **AND** HTTP 200

#### Scenario: PATCH union tags
- **GIVEN** atom Y.tags=["foo"]
- **WHEN** `PATCH /api/memory/Y` with `{tags: ["bar"]}`
- **THEN** merged atom.tags = ["foo", "bar"] (union)
- **AND** merged atom.version = old.version + 1
- **AND** recompute embedding + write .md + upsert

#### Scenario: POST /api/memory/search 返 results
- **GIVEN** recallAtoms 可用
- **WHEN** `POST /api/memory/search {query: "PDF", topK: 5}`
- **THEN** 返 `{results: [...], recallTimeMs: N, tokenBudgetUsed: M}`
- **AND** HTTP 200

### Requirement: Decay rule 类型永不 archive
runDecay SHALL 在 atom.type='rule' 时**永远不**调用 markArchived,即使 strength 已衰减到 archiveThreshold 以下。

#### Scenario: rule 类型 strength=0.01 不 archive
- **GIVEN** atom.type='rule', strength=1.0, last_access=100 天前
- **AND** archiveThreshold=0.1
- **WHEN** runDecay 跑
- **THEN** new_strength ≈ 1.0 * exp(-0.025 * 100) ≈ 0.082 (低于阈值)
- **AND** **不** markArchived
- **AND** atom.archived 仍是 false

#### Scenario: fact 类型 strength<threshold 时 archive
- **GIVEN** atom.type='fact', strength=0.5, last_access=120 天前
- **WHEN** runDecay 跑
- **THEN** new_strength ≈ 0.05
- **AND** markArchived 触发
- **AND** memory_vectors DELETE 该 id

### Requirement: 召回质量评估 (labeled dataset)
recall-quality.test.ts SHALL 用 labeled dataset (10-20 atom,5-10 query) 验证召回质量,assert 最低门槛。

#### Scenario: 中文 query 命中中文 atom
- **GIVEN** atom A.title="PDF图片提取必须用pymupdf", content 含中文
- **WHEN** recallAtoms(index, "图片提取")
- **THEN** A 在 top-5
- **AND** recall@5 ≥ 0.5 (中文 case,门槛低)

#### Scenario: 整体 recall 门槛
- **GIVEN** dataset 10 atom (rule/fact/process 各几个,中英文混合)
- **WHEN** 对 5-10 query 跑 recallAtoms
- **THEN** avg_recall_at_5 ≥ 0.7
- **AND** avg_recall_at_10 ≥ 0.85
- **AND** avg_precision_at_5 ≥ 0.5

## REMOVED Requirements

### Requirement: FTS5 索引 (memory_fts 表)
- **Reason**: FTS5 unicode61 中文 tokenization 失败,改用纯向量检索。
- **Migration**: 无 (旧 data 废弃)。

### Requirement: searchByFts / searchAtoms / searchAtomsWithScores (混合检索)
- **Reason**: 删 FTS 后纯向量检索,不需要混合 scoring。
- **Migration**: 无。

### Requirement: rewriteQuery / rewriteQueryWithCallLlm / callOllamaRewrite (LLM 改写 query)
- **Reason**: LLM 改写经常把中文译英文,反而错位。直接 embed 原文。
- **Migration**: 无。

### Requirement: simpleKeywordExtraction / dedupeRedundantKeywords / dedupeAgainstQuery
- **Reason**: 关键词 dedup 不再需要 (改用 content fingerprint + cosine)。
- **Migration**: 无。

### Requirement: expandCjkKeywords (CJK 拆字)
- **Reason**: bge-m3 是多语言 embedding,直接 embed 原文即可,不需要词袋级匹配。
- **Migration**: 无。

### Requirement: isEmbeddingServiceAvailable 独立函数
- **Reason**: 失败即空,不展示 "embedding unavailable" badge。
- **Migration**: 无。

### Requirement: slug 文件路径 (基于 title 衍生的 slug)
- **Reason**: 同 title collision → 文件覆盖。改用 atom.id。
- **Migration**: 无 (旧 data 废弃)。

## RENAMED Requirements

无。
