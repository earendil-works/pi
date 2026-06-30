# 场景: memory-recall-dense-rerank

## Normal (正常路径)

### Scenario: 纯 dense 召回中文 query

- **GIVEN** DB 有 atom A(title="novo skill 创建方法", type="fact") 和 atom B(title="BMK 报告品牌替换", type="fact"),均有 embedding
- **AND** ollama 运行中,bge-m3 可用
- **WHEN** `recallAtoms(index, "然后制做成为novo skill")` 执行
- **THEN** dense KNN 返回 A 的 cosine ≥ 0.7,B 的 cosine < 0.7
- **AND** B 被 cosine floor 门控过滤
- **AND** 结果列表只含 A,不含 B

### Scenario: per-type 分层 KNN + round-robin 保留

- **GIVEN** DB 有 3 个 rule + 2 个 fact + 1 个 process,均与 query 相关(cosine ≥ 0.7)
- **WHEN** `recallAtoms(index, query)` 执行
- **THEN** rule 层取 top-3(实际只有 3 个,全返),fact 层取 top-2,process 层取 top-1
- **AND** round-robin 交错:rule[0], fact[0], process[0], rule[1], fact[1], rule[2]

### Scenario: scoring 公式不变

- **GIVEN** atom X(cosine=0.85, strength=1.0, importance=1.0)和 atom Y(cosine=0.80, strength=0.5, importance=0.0)
- **WHEN** `recallAtoms` 对同 type 内排序
- **THEN** X 的 score = 0.85 × (1 + 0.3 + 0.2) + 0.10×tagOverlap + 0.05×freshness = 1.275 + additives
- **AND** Y 的 score = 0.80 × (1 + 0.15 + 0) + additives = 0.92 + additives
- **AND** X 排在 Y 前(cosine 主键 + 乘法 boost)

## Abnormal (异常路径)

### Scenario: ollama 不可用 → 返回空

- **GIVEN** ollama 未运行,`embedText` 返回 null
- **WHEN** `recallAtoms(index, query)` 执行
- **THEN** dense 候选池为空(query embedding 为 null → 不执行 KNN)
- **AND** 返回 `[]`(无 FTS 兜底,无关键词降级)
- **AND** `before_agent_start` hook 设置 TUI status `🔍 no memory match`

### Scenario: 空查询

- **GIVEN** query 是空字符串 `""`
- **WHEN** `recallAtoms(index, "")` 执行
- **THEN** 返回 `[]`(embed 空字符串语义无意义,short-circuit)

### Scenario: DB 无 atom

- **GIVEN** DB 初始化完成但 `memory_index` 表为空,`memory_vectors` 表为空
- **WHEN** `recallAtoms(index, "任何 query")` 执行
- **THEN** KNN 返回 0 个候选
- **AND** 返回 `[]`

### Scenario: 所有候选 cosine 低于 floor

- **GIVEN** DB 有 5 个 atom,但 query 与所有 atom 的 cosine < 0.7
- **WHEN** `recallAtoms(index, query)` 执行
- **THEN** cosine floor 过滤后候选池为空
- **AND** 返回 `[]`(宁可漏召不可误召)

## Boundary (边界)

### Scenario: cosine 恰好等于 floor

- **GIVEN** atom A 的 cosine = 0.70(等于 cosine floor)
- **WHEN** cosine floor 过滤执行 `c >= 0.7`
- **THEN** A 通过过滤(`>=` 包含边界)

### Scenario: 某一 type 无候选

- **GIVEN** DB 只有 fact atom,无 rule / process atom
- **WHEN** `recallAtoms(index, query)` 执行
- **THEN** rule 层返回 `[]`,process 层返回 `[]`,fact 层返回 top-3
- **AND** round-robin 交错只从 fact 层取,不跨 type 补位

### Scenario: 混合 ASCII + CJK query 直接 embed

- **GIVEN** query = "mgm工时计算"(ASCII + CJK 混合)
- **WHEN** `recallAtoms(index, "mgm工时计算")` 执行
- **THEN** 不执行 splitQuery(已删),直接 embed 整个 "mgm工时计算"
- **AND** bge-m3 多语言模型输出单条 embedding
- **AND** KNN 用该 embedding 检索

### Scenario: FTS 表存在但代码不再引用

- **GIVEN** 现有 DB 有 `memory_fts` 表(旧版本创建)
- **WHEN** 新版 `MemoryIndex.init()` 执行
- **THEN** `memory_fts` 表被 DROP(清理旧 schema)
- **AND** 不再 CREATE 新的 `memory_fts` 表
- **AND** `memory_index` / `memory_vectors` 表保留不动

### Scenario: 写入 atom 不再同步 FTS 行

- **GIVEN** 新 atom C 通过 extraction pipeline 创建
- **WHEN** `index.insertAtom(C, embedding)` 执行
- **THEN** 只写入 `memory_index` + `memory_vectors`
- **AND** 不执行 `INSERT INTO memory_fts`(FTS 同步逻辑已删)

### Scenario: supersede 不再操作 FTS 行

- **GIVEN** atom A 被 atom B supersede
- **WHEN** `markSupersededTx` 执行
- **THEN** 只操作 `memory_index`(旧行 is_latest=0 + 新行插入)+ `memory_vectors`(旧向量删/新向量插)
- **AND** 不执行 `DELETE FROM memory_fts WHERE id = oldId`(FTS 同步逻辑已删)

### Scenario: archive 不再操作 FTS 行

- **GIVEN** atom A 被 archive
- **WHEN** `markArchived` 执行
- **THEN** 只操作 `memory_index`(archived=1)+ `memory_vectors`(删向量)
- **AND** 不执行 `DELETE FROM memory_fts WHERE id = ?`(FTS 同步逻辑已删)
