# 使用场景

## 正常流程

### 场景: 真正相关 atom 在两个 channel 都命中,RRF 加权排第一
- **GIVEN** DB 有 atom "工时估算-项目总工时控制" (rule type, content 含 "总工时控制在5天左右")
- **AND** atom 已索引到 `memory_fts`(title + summary + content + tags)
- **AND** atom 在 sqlite-vec 中 cosine=0.78
- **WHEN** recallAtoms(query="工时估算", { rrfK: 60, recallThreshold: 0.0167 })
- **THEN** dense 通道 KNN 返回 atom,rank=1,贡献 rrf_score = 1/(60+1) = 0.01639
- **AND** BM25 通道 `bm25(memory_fts)` 返回 atom,rank=2(因 tags 命中"工时"加权重),贡献 1/(60+2) = 0.01613
- **AND** RRF fused score = 0.01639 + 0.01613 = 0.03252 ≥ threshold 0.0167
- **AND** atom 进入 fused top-9
- **AND** 最终 recallAtoms 返回该 atom,RecallResult.rrfScore = 0.03252

### 场景: dense 单路命中 (semantic-only query)
- **GIVEN** DB 有 atom "check_seq.py 后必须 update-seq 更新 state"(process type, content 含技术细节)
- **AND** query "数据下机后要做什么" 在 token 层面没有强命中
- **WHEN** recallAtoms(query="数据下机后要做什么")
- **THEN** dense cosine = 0.72 (语义相关)
- **AND** BM25 通道无强命中(best rank 8, rrf_score = 1/(60+8) = 0.01471)
- **AND** 总 rrf_score = 0.01639 + 0.01471 = 0.03110 ≥ threshold
- **AND** atom 仍进入 top-9(dense 单路命中即足够)

### 场景: BM25 单路命中在 strict 1/60 默认下被过滤,但 `recallThreshold: 0` 时可召回 (设计取舍)
- **GIVEN** DB 有 atom "X101SC26052587-Z01-J002 客户数据未回传" + tags 含 amplicon
- **AND** query "X101SC26052587 数据回传" 在 dense 通道 cosine=0.50 (低于 floor 0.65),BM25 通道 rank=1
- **WHEN** recallAtoms(query, {}) (默认 strict 1/60 threshold)
- **THEN** dense 返回 [] (cosine 0.50 < 0.65 floor)
- **AND** BM25 返回该 atom rank=1
- **AND** fused rrfScore = 0.01639 < 默认 recallThreshold 0.01667
- **AND** atom 在默认配置下被过滤掉 (宁可漏召不可误召)
- **NOTE**: 这是 strict 默认的有意取舍 — 设计选择保护 dense 噪声场景 (用户的 lefse case) 胜于 BM25-only 召回
- **NOTE2**: 用户可设 `recallThreshold: 0` (test/dev 模式) 让 BM25-only 召回;生产推荐保留 strict 默认

### 场景: RRF 融合后的 per-type round-robin
- **GIVEN** RRF fused top-9 包含:4 rule + 3 fact + 2 process
- **WHEN** recallAtoms 返回
- **THEN** 截取 fused top-9(已经是融合后的排序,直接 round-robin 不再需要)
- **AND** 顺序:[rule[0], fact[0], process[0], rule[1], fact[1], rule[2], fact[2], process[1], rule[3]]
- **NOTE**: round-robin 在 hybrid fused 阶段之前做还是之后做,设计待定 — 见 design.md Decision 4

## 异常流程

### 场景: embedText 返回 null,降级到纯 BM25
- **GIVEN** ollama 不可达(连接拒绝)
- **AND** DB 有 atom (假设有相关 atom "X101SC26052587 客户数据未回传")
- **WHEN** recallAtoms(query="X101SC26052587 数据回传")
- **THEN** dense channel 返回 [](embedText null)
- **AND** BM25 channel 正常返回 top-20
- **AND** fused score 仅来自 BM25 rank
- **AND** 仍能召回相关 atom(降级而非失败)

### 场景: FTS5 query parse 失败 (e.g., 包含 sqlite fts5 reserved chars)
- **GIVEN** user query 含未转义的 `"`(FTS5 phrase query delimiter)
- **WHEN** recallAtoms(query='lefse "没有" 结果')
- **THEN** `storage.bm25Search` 用 escapeFtsQuery 把 `"()*:[]` 替换成空格 (非 doubling `"`)
- **AND** 不抛 SQL parse error
- **AND** 返回 BM25 top-20

### 场景: 阈值超严,所有 atom 都被截掉
- **GIVEN** recallThreshold = 0.05(用户误调到极高)
- **AND** DB 有 8 atom,但都没有任何 atom 在 fused top-9 中达到 0.05
- **WHEN** recallAtoms(query="anything")
- **THEN** fused top-9 计算完,但每条 rrf_score < 0.05
- **THEN** recallAtoms 返回 [](因为 fused top-9 全被 threshold 过滤)
- **AND** TUI status bar 显示 "🔍 no memory match"
- **NOTE**: 这是正常 fallback,不是 error

### 场景: BM25 路径返回 0 结果 (e.g., 极端生僻词 query)
- **GIVEN** DB 中所有 atom 都不含 query "qwertyuiop"
- **WHEN** recallAtoms(query="qwertyuiop")
- **THEN** BM25 通道返回 []
- **AND** dense 通道可能返回弱命中 (cosine < recallThreshold 等价 RRF 0)
- **AND** 最终 recallAtoms 返回 []

## 边界条件

### 场景: query 是空字符串
- **GIVEN** user prompt 是空 string("")
- **WHEN** recallAtoms(query="")
- **THEN** dense embedText("") 返回向量(空字符串 embedding 通常正常)
- **AND** BM25 `bm25(memory_fts, '')` 返回空集合
- **AND** fused 结果为空,返回 []
- **NOTE**: memory.ts 的 before_agent_start hook 已经在 prompt length === 0 时 return,这里兜底

### 场景: DB 全新,0 atom
- **GIVEN** 首次启动,DB 不存在
- **AND** MemoryIndex.init() 调用
- **THEN** CREATE memory_index + memory_vectors + memory_fts
- **AND** FTS5 表为空(无 atom 需要回填)
- **AND** 后续 insertAtom 会同步往 FTS5 插

### 场景: 旧 DB 升级,init 时幂等构建 FTS5
- **GIVEN** 已有 DB 含 8 active atom,无 memory_fts 表
- **WHEN** MemoryIndex.init()
- **THEN** CREATE memory_fts
- **AND** SELECT * FROM memory_index WHERE archived=0 AND is_latest=1 拿到 8 atom
- **AND** 批量 INSERT 8 行到 memory_fts(每行 title + summary + content + tags)
- **AND** 后续 query 立即能用 BM25
- **NOTE**: 幂等 — 已存在 memory_fts 表则跳过 CREATE 和回填

### 场景: init 时 ollama 不可达
- **GIVEN** 首次启动,ollama 不可达
- **WHEN** MemoryIndex.init() (不调 embedText,只 build FTS5)
- **THEN** FTS5 构建成功(纯文本索引,不依赖 ollama)
- **AND** 后续 recallAtoms 时 dense 通道自然降级到 []
- **NOTE**: FTS5 构建不需要 embedText,只在 recall 时调

### 场景: 阈值默认值 1/60 数值边界 (strict 严格)
- **GIVEN** recallThreshold 默认 1/60 ≈ 0.01667
- **AND** rrfK 默认 60
- **THEN** 单 channel rank=1 (0-indexed) 命中贡献 = 1/(60+0+1) = 1/61 ≈ 0.01639
- **AND** 0.01639 < 0.01667,**单 channel rank=1 不足以过阈值** — 必须双 channel 都有贡献 OR 单 channel rank=0 + 另一 channel 弱贡献才能凑过
- **NOTE**: 这是设计取舍"宁可漏召不可误召"的数值表达 — 单 channel dense noise 召回 (用户的 lefse case) 必然被过滤,保护了 dense 召回质量
- **NOTE2**: 用户可设 `recallThreshold: 0` (test/dev 模式) 让单 channel rank=1 通过;生产推荐保留 strict 1/60 默认
- **NOTE3**: 或调低 threshold (e.g. 0.01) 让单 channel rank=1 贡献 (0.0164) 通过 — 但会引入 dense noise回归,默认严格更好

### 场景: config 缺失 recall 块
- **GIVEN** `~/.pi/agent/settings.json` 没有 `personalAssistant.memory.recall`
- **WHEN** MemoryIndex 加载配置
- **THEN** recallAtoms 用默认 `rrfK = 60`, `recallThreshold = 1/60 ≈ 0.01667`
- **NOTE**: 配置完全可选,跟现有 `decay` / `injection` 块同样的 fallback 语义

### 场景: storage bge-m3 cosine 与 BM25 RRF score 量纲不可比
- **GIVEN** RRF 不需要归一化 BM25 和 cosine(用 rank 而不是 score)
- **WHEN** 融合时
- **THEN** 只用 `1/(k+rank)` 加权,不直接用 cosine 或 BM25 score
- **NOTE**: 这是 RRF 的核心优势 — 对 score 分布完全不敏感