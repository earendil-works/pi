# 使用场景

## 正常流程

### Scenario: search 召回按类型多样性返回 9 条
- **GIVEN** DB 中有 6 个 active atom: 2 rule + 3 fact + 1 process,所有都有 embedding
- **WHEN** client 调 `POST /api/memory/search` body=`{query: "lima 拆分", topK: 10}`
- **THEN** 响应 `results.length === 9`(per-type top-3:rule 2 + fact 3 + process 1,稀疏 process 自动降到 1)
- **AND THEN** 每个 result 含 `{id, type, title, summary, tags, distance, cosine}`,**不**含 `file_path` / `tier` / `formattedText` / `tokenBudgetUsed`
- **AND THEN** 返回的 atom 在 DB 中 `access_count` 全部保持原值(search 不 bump)

### Scenario: get endpoint 用于 webui 预览,不 bump
- **GIVEN** DB 中存在 atom id=`96e3ebb1-2bba-4012-9ade-9e6f31f8a13a`,初始 `access_count = 0`
- **WHEN** webui client 调 `GET /api/memory/96e3ebb1-2bba-4012-9ade-9e6f31f8a13a` 2 次(连续,间隔 0ms)
- **THEN** 每次响应都返回 atom 完整记录 + content(从 .md 文件读)
- **AND THEN** DB 中该 atom `access_count` **保持 0**(preview-only,无 feedback)
- **NOTE**: 这是 webui 的预览路径。bump 走 agent 的 `memory_get` tool,不走此 endpoint。

### Scenario: agent memory_get tool 拿到完整 atom
- **GIVEN** agent 已加载 personal-assistant extension,`memory_get` tool 已注册
- **AND GIVEN** DB 中存在 atom id=`abc-123`,`.md` 文件存在且 hash 匹配
- **WHEN** agent LLM 调 `memory_get({id: "abc-123"})`
- **AND THEN** 工具返回 `{id, type, title, summary, content, tags, ...}` 完整记录
- **AND THEN** DB 中该 atom `access_count` +1 (从 0 → 1)

### Scenario: extraction 时强语气词驱动 high importance
- **GIVEN** 待提取的最近 user 消息文本为 "**千万记住**,commit 前必须跑 `npm run check`,不要直接 push"
- **WHEN** extraction LLM 收到 `buildExtractionPrompt(messages)` 输出的 prompt
- **THEN** prompt 中包含 `<user_tone level="strong" score="0.95">` 段,内容明确建议 importance ≥ 0.9
- **AND THEN** LLM 输出的 extraction item `importance >= 0.85`(hint 起作用)

### Scenario: formatMemoryContext 注入的 memory block 含 id
- **GIVEN** `formatMemoryContext([recall_result_1, recall_result_2], 4000)`
- **WHEN** 生成 injected text
- **THEN** 每个 block 格式为 `[type] <title>\n<summary>\nid: <uuid>\nTags: <t1, t2, ...>`
- **AND THEN** block 中**不**包含 `file:` / `file_path:` 行

### Scenario: search recall injection 把 search 结果喂给 LLM
- **GIVEN** agent 进入新一轮 turn,user 消息 "lima 拆分有问题,怎么修"
- **AND GIVEN** `before_agent_start` hook 触发 `recallAtoms(index, "lima 拆分有问题", atomsDir, {})`
- **WHEN** context hook 注入 memory
- **THEN** agent 收到的 user message prefix 含 `[Relevant memory context]\n<formatted text>\n\n[User message]\n`
- **AND THEN** formatted text 包含至少一个 process atom(per-type top-3 保证多样性)

## 异常流程

### Scenario: get 不存在的 atom id 返回 404
- **GIVEN** DB 中不存在 id=`nonexistent-uuid`
- **WHEN** client 调 `GET /api/memory/nonexistent-uuid`
- **THEN** 响应 status=404,body=`{error: "atom not found"}`
- **AND THEN** DB 中无任何 row 被修改(no bump)

### Scenario: memory_get 工具收到不存在的 id
- **GIVEN** agent LLM 调 `memory_get({id: "nonexistent-uuid"})`
- **WHEN** 工具执行
- **THEN** 返回 `{error: "atom not found"}`(不抛异常,让 LLM 可以降级处理)
- **AND THEN** DB 中无任何 row 被修改

### Scenario: search 命中 0 atom
- **GIVEN** DB 中没有任何 active atom(空 DB)
- **WHEN** client 调 `POST /api/memory/search` body=`{query: "anything"}`
- **THEN** 响应 status=200,`results: []`,`recallTimeMs` 正常返回
- **AND THEN** 不返回 error,不返回 500

### Scenario: search 命中 atom 但 .md 文件丢失
- **GIVEN** DB 中存在 atom,但对应 .md 文件被手动删除
- **WHEN** agent LLM 调 `memory_get({id: "..."})`
- **THEN** 工具返回 `{...atom, content: ""}`(不抛异常)
- **AND THEN** DB 中该 atom `access_count` 仍然 +1(bump 不依赖文件存在)

### Scenario: ollama 不可用,embedText 返回 null
- **GIVEN** ollama 服务挂掉,`embedText` 返 null
- **WHEN** client 调 search
- **THEN** `recallAtoms` 内部短路返回 `[]`
- **AND THEN** 响应 status=200,`results: []`,`recallTimeMs` 仍记录(从调用开始到结束)

### Scenario: search topK 超过 9
- **GIVEN** client 请求 body=`{query: "...", topK: 100}` (即使 3 type 各 3 个也只有 9)
- **WHEN** search 返回
- **THEN** `results.length <= 9`(per-type top-3 的硬上限)

### Scenario: extraction LLM 返回 invalid JSON
- **GIVEN** extraction LLM 返回字符串不是 valid JSON,或缺字段
- **WHEN** `parseExtractionJson` 处理
- **THEN** 返回 null,后续跳过该 extraction batch
- **AND THEN** 不 crash,不写任何 atom

### Scenario: webui MemoryEditor 点击 atom 详情预览(不 bump)
- **GIVEN** user 在 webui `/memory` 页面点击 list 中的 atom
- **WHEN** MemoryEditor 调 `GET /api/memory/:id` 加载详情
- **THEN** 该 atom `access_count` **不变**(UI 预览不算 usage signal)
- **AND THEN** 详情正常显示(title / summary / content editor)

## 边界条件

### Scenario: per-type top-3 时 type 稀疏
- **GIVEN** DB 中只有 1 个 process atom(rule 10 个,fact 5 个,process 1 个)
- **WHEN** search 返回
- **THEN** rule = 3 条,fact = 3 条,process = 1 条(稀疏 type 自动降到 1,不强行凑)
- **AND THEN** 总数 = 7,小于 9

### Scenario: per-type top-3 时 type 完全空
- **GIVEN** DB 中只有 rule 和 fact,没有 process atom
- **WHEN** search 返回
- **THEN** rule = 3 条,fact = 3 条,process = 0 条
- **AND THEN** 总数 = 6

### Scenario: tone scoring 完全中性消息
- **GIVEN** user 消息 "我看看今天能不能把那个 bug 修一下"(无任何语气词)
- **WHEN** `scoreUserTone` 扫描
- **THEN** 返回 `{level: "neutral", score: 0.5}`
- **AND THEN** extraction prompt 注入 `<user_tone level="neutral" score="0.5">` 段,说明"无明显语气,importance 默认 0.5"

### Scenario: tone scoring 混合强弱语气
- **GIVEN** user 消息 "试试看,如果不行就放弃吧" (含 "试试看" + "如果不行")
- **WHEN** `scoreUserTone` 扫描
- **THEN** 返回 `{level: "weak", score: 0.35}`(取最强匹配,弱语气优先,因为没有更强语气词)

### Scenario: tone scoring 跨多句
- **GIVEN** user 最近 3 条消息: "今天先这样" / "明天千万记得..." / "如果不出问题就算了"
- **WHEN** `scoreUserTone` 只取最近一条 user 消息扫描
- **THEN** 返回强语气结果(只看最近一条,不聚合多轮)

### Scenario: get atom content hash mismatch
- **GIVEN** DB 中 atom 的 `content_fingerprint` 与 .md 文件 sha256 不一致(被外部修改过)
- **WHEN** agent 调 `memory_get({id: "..."})`
- **THEN** 工具返回 `{...atom, content: ""}`(hash mismatch fallback,不抛异常)
- **AND THEN** `access_count` 仍然 +1(bump 不依赖内容 hash 校验)

### Scenario: search topK=0
- **GIVEN** client 请求 body=`{query: "...", topK: 0}`
- **WHEN** search 处理
- **THEN** 返回 `results: []`(topK=0 意味着不取任何 result)
- **AND THEN** status=200,正常响应

### Scenario: per-type top-3 with concurrent write
- **GIVEN** search 期间,另一进程 archive 了某个 atom
- **WHEN** search 正在处理该 type 的 candidates
- **THEN** 该 candidate 被跳过(因为 `archived = 0` WHERE clause 过滤),不返
- **AND THEN** 返回剩余 results,total 可能 < 9,但不报错

### Scenario: per-type top-3 排序按 round-robin 交错
- **GIVEN** DB 中有 6 个 active atom(2 rule + 3 fact + 1 process),所有 cosine 都 ≥ 0.5
- **WHEN** search 返回
- **THEN** 返回 6 个(2 rule + 3 fact + 1 process,稀疏 process 自动降到 1)
- **AND THEN** 顺序是 round-robin 交错:`[rule[0], fact[0], process[0], rule[1], fact[1], process[1], fact[2]]`(注意 process 只 1 个,所以第 2 轮 process 槽位空,自动跳过;fact 第 2 轮 [1] 在 process[1] 空槽之后补上)

### Scenario: per-type 全空
- **GIVEN** DB 中只有 rule 和 fact,没有 process atom
- **WHEN** search 返回
- **THEN** 返回 `[rule[0], fact[0], rule[1], fact[1], rule[2], fact[2]]`(共 6 条,process 槽位全部跳过,不返 0-cosine placeholder)

### Scenario: per-type 内部多键排序 cosine → strength → importance
- **GIVEN** rule type 有 3 个 atom, cosine 分别为 0.9 / 0.85 / 0.7,strength 分别为 0.5 / 0.5 / 0.5,importance 分别为 0.5 / 0.5 / 0.5
- **WHEN** search 返回
- **THEN** rule 槽位顺序为 `[0.9, 0.85, 0.7]`(cosine desc,严格降序)
- **AND THEN** round-robin 后 rule 出现在 `[0]`、`[3]`、`[6]` 位置

### Scenario: cosine 相同时 strength 作 tiebreaker
- **GIVEN** rule type 有 2 个 atom,**cosine 都是 0.8**,但 atom A 的 `strength=0.7`(近期 get 过,衰减慢),atom B 的 `strength=0.3`(长期未 get,衰减明显)
- **WHEN** search 返回(同 cosine 时按 strength DESC)
- **THEN** rule 槽位顺序为 `[A(0.8, strength 0.7), B(0.8, strength 0.3)]`
- **AND THEN** A 排在 B 之前(因为 A"更活跃",用户最近实际用过)

### Scenario: cosine + strength 都相同时 importance 作 tiebreaker
- **GIVEN** rule type 有 2 个 atom, **cosine 都是 0.8**,**strength 都是 0.5**,但 atom A 的 `importance=0.85`(rule 类型),atom B 的 `importance=0.5`(实际上 type 也是 rule,但 importance 较低)
- **WHEN** search 返回(同 cosine + strength 时按 importance DESC)
- **THEN** rule 槽位顺序为 `[A, B]`
- **AND THEN** A 排在 B 之前(因为 A importance 更高,作者给它的优先级更高)

### Scenario: rule type strength = importance(永不衰减)
- **GIVEN** DB 中 rule type 有 5 个 atom,importance 分别是 0.5 / 0.6 / 0.7 / 0.8 / 0.9,**所有 strength 都 = importance**(rule 永不衰减)
- **AND GIVEN** 所有 cosine 都 = 0.8(完全相同)
- **WHEN** search 返回(多键排序最终按 importance DESC)
- **THEN** rule 槽位顺序为 `[importance=0.9, 0.8, 0.7, 0.6, 0.5]`
- **NOTE**: 这条测试验证 rule type 的 strength tiebreaker 等价于 importance tiebreaker,因为 strength 永远等于 importance。

### Scenario: fact/process 类型 strength < importance(衰减后)
- **GIVEN** fact type 有 2 个 atom,**cosine 都是 0.8**,**importance 都是 0.7**,但 atom A 创建于 1 天前(刚 access 过),atom B 创建于 30 天前(没 access 过)
- **WHEN** search 返回
- **THEN** A 的 strength ≈ 0.7(未衰减),B 的 strength ≈ 0.1(衰减后)
- **AND THEN** rule 槽位顺序为 `[A(0.7), B(0.1)]`(按 strength DESC)

### Scenario: strength tiebreaker 跨 type 也有效
- **GIVEN** rule A 和 fact B 的 cosine 都是 0.8,但 rule A 的 strength=0.85,fact B 的 strength=0.5
- **WHEN** search 返回
- **THEN** rule A 和 fact B 都在各自 type 的 top-3 内(各自的 type 内部排序按多键)
- **AND THEN** round-robin 交错后,rule A 出现在 round N,fact B 出现在 round N'(type 之间位置由 round-robin 决定,不是直接比较 strength)

### Scenario: formatMemoryContext 注入时再做 distance asc 全局排序(只看 cosine 主键)
- **GIVEN** search 返回 6 条(round-robin 交错,**多键排序已应用**)
- **WHEN** `formatMemoryContext(results, 4000)` 渲染
- **THEN** 最终注入 LLM prompt 的 block 按 distance asc 全局排序(等价于 cosine DESC,只看主键),不再是 round-robin 交错
- **AND THEN** block 内格式 `[type] title\nsummary\nid: <uuid>\nTags: ...`,LLM **看不到** strength / importance(这些是 metadata,不在 block 里)
- **NOTE**: 多键排序的影响**仅**体现在 search response(给 UI / 调试看),prompt 注入只按 cosine。这是有意为之 — LLM 拿 prompt 时只看 cosine 主键,strength/importance 是 metadata,不暴露给 LLM。

### Scenario: tone scoring 边界词 "如果"
- **GIVEN** user 消息 "如果今天有空,就帮我看下 bug"
- **WHEN** `scoreUserTone` 扫描
- **THEN** 返回 weak(0.35),因为 "如果" 在 WEAK 词表
- **NOTE**: "如果" 在某些语境是中性(如"如果下雨"),词表可能需要更精确的上下文判断 — 当前用纯词表匹配,接受这层精度损失。