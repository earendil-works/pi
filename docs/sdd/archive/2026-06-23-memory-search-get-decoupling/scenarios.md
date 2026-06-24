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
- **GIVEN** user 3 条消息: "今天先这样" (NEUTRAL) / "明天千万记得帮我看下 bug" (STRONG, "千万") / "如果不出问题就算了" (WEAK, "如果")
- **WHEN** `scoreUserTone(messages)` 扫描全部消息并取最高 tier
- **THEN** 返回 STRONG(0.85)— 因为聚合时 STRONG 命中("千万"),强于 WEAK ("如果")
- **NOTE**: 设计上 `scoreUserTone` 接收完整 messages 数组并聚合所有 user 消息中的 tone 信号,而不是只看最近一条。这样能在多轮对话中捕捉到用户的整体语气强度。

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
- **GIVEN** DB 中有 6 个 active atom(2 rule + 3 fact + 1 process),所有 cosine 都 ≥ 0.65
- **WHEN** search 返回
- **THEN** 返回 6 个(2 rule + 3 fact + 1 process,稀疏 process 自动降到 1)
- **AND THEN** 顺序是 round-robin 交错:`[rule[0], fact[0], process[0], rule[1], fact[1], process[1], fact[2]]`(注意 process 只 1 个,所以第 2 轮 process 槽位空,自动跳过;fact 第 2 轮 [1] 在 process[1] 空槽之后补上)

### Scenario: per-type 全空
- **GIVEN** DB 中只有 rule 和 fact,没有 process atom
- **WHEN** search 返回
- **THEN** 返回 `[rule[0], fact[0], rule[1], fact[1], rule[2], fact[2]]`(共 6 条,process 槽位全部跳过,不返 0-cosine placeholder)

### Scenario: per-type 内部 score DESC 排序(加权公式)
- **GIVEN** rule type 有 3 个 atom, cosine / strength / importance 分别为:
  - atom A: cosine=0.7, strength=1.0, importance=1.0 → score = 0.7 × 1.5 = **1.05**
  - atom B: cosine=0.85, strength=0.1, importance=0.1 → score = 0.85 × 1.05 = **0.8925**
  - atom C: cosine=0.6, strength=1.0, importance=0.8 → score = 0.6 × 1.46 = **0.876**
- **WHEN** search 返回(组内按 score DESC)
- **THEN** rule 槽位顺序为 `[A, B, C]`(A 因为 boost 高排第一,B 因为 cosine 高排第二,C 排第三)
- **NOTE**: A 的 cosine 比 B 低 0.15,但 strength + importance 的 boost 让 A 嬴 — 反映"越用越显"反馈

### Scenario: score 边界值 — cosine=0 → score=0
- **GIVEN** 某个 atom cosine=0(完全无关),但 strength=1.0、importance=1.0
- **WHEN** 计算 score
- **THEN** score = 0 × (1 + 0.3 + 0.2) = **0**
- **AND THEN** cosine=0 的 atom 不会因为 boost 反超相关 atom(cosine 主键保证)

### Scenario: score 边界值 — cosine=1 → score=1.5
- **GIVEN** 某个 atom cosine=1.0(完美匹配),strength=1.0、importance=1.0
- **WHEN** 计算 score
- **THEN** score = 1.0 × 1.5 = **1.5**(满分 atom 上限)
- **AND THEN** 该 atom 永远排在 top(除非其他 atom cosine 更高,但 cosine 已 max)

### Scenario: cosine 主导性验证
- **GIVEN** 2 个 atom:
  - atom X: cosine=0.6, strength=1.0, importance=1.0 → score = 0.6 × 1.5 = **0.9**
  - atom Y: cosine=0.85, strength=0.1, importance=0.1 → score = 0.85 × 1.05 = **0.8925**
- **WHEN** 比较 score
- **THEN** Y 嬴(Y score=0.8925 > X score=0.9)— **不对,Y 略小于 X**
- **修正**: X score = 0.9, Y score = 0.8925,X **嬴**(差 0.0075)
- **NOTE**: 这条测试验证 boost 在 cosine 差距较大时不能反超,cosine 是主键。X 的 cosine 仅比 Y 低 0.25,但 boost 弥补了这个差距 — 边界情况,接近赢面相等。

### Scenario: rule type strength = importance 时的简化
- **GIVEN** rule type 有 5 个 atom,importance 分别是 0.5 / 0.6 / 0.7 / 0.8 / 0.9,**所有 strength 都 = importance**(rule 永不衰减)
- **AND GIVEN** cosine 都是 0.8(完全相同)
- **WHEN** 计算 score
- **THEN** 5 个 score 分别为:
  - importance=0.5: 0.8 × (1 + 0.15 + 0.10) = 0.8 × 1.25 = **1.0**
  - importance=0.6: 0.8 × (1 + 0.18 + 0.12) = 0.8 × 1.30 = **1.04**
  - importance=0.7: 0.8 × (1 + 0.21 + 0.14) = 0.8 × 1.35 = **1.08**
  - importance=0.8: 0.8 × (1 + 0.24 + 0.16) = 0.8 × 1.40 = **1.12**
  - importance=0.9: 0.8 × (1 + 0.27 + 0.18) = 0.8 × 1.45 = **1.16**
- **AND THEN** rule 槽位顺序为 `[importance=0.9 (1.16), 0.8 (1.12), 0.7 (1.08), 0.6 (1.04), 0.5 (1.0)]`(importance 高的嬴)

### Scenario: fact type strength 衰减后 importance 不变
- **GIVEN** fact type 有 2 个 atom,**cosine 都是 0.8**,**importance 都是 0.7**,但 atom A 创建于 1 天前(刚 access 过,strength ≈ 0.7 未衰减),atom B 创建于 30 天前(没 access 过,strength ≈ 0.1 衰减后)
- **WHEN** 计算 score
- **THEN** A score = 0.8 × (1 + 0.3×0.7 + 0.2×0.7) = 0.8 × 1.35 = **1.08**
- **AND THEN** B score = 0.8 × (1 + 0.3×0.1 + 0.2×0.7) = 0.8 × 1.17 = **0.936**
- **AND THEN** A 排第一(A 嬴,差 0.144)
- **NOTE**: importance 在 A 和 B 上相同(都是 0.7),strength 差异(0.7 vs 0.1)直接通过 boost 反映在 score 上。

### Scenario: strength feedback 循环
- **GIVEN** rule type atom X 初始 strength=0.5, cosine=0.7, importance=0.8 → score = 0.7 × 1.255 = **0.8785**
- **WHEN** agent 调 `memory_get({id: X.id})` → X.access_count += 1 → X.last_access = now
- **AND THEN** 下次 `runDecay` 时,deltaDays ≈ 0,跳过衰减(X.strength 保持 0.5)
- **AND THEN** 再次 search,score 仍为 0.8785(没变化,因为 strength 没衰减)
- **WHEN** 长时间不调用(month+),runDecay 把 X.strength 衰减到 0.1
- **AND THEN** 再次 search,score = 0.7 × (1 + 0.03 + 0.16) = 0.7 × 1.19 = **0.833**
- **AND THEN** X 排名下降 → 不在 top-3 内 → 不被 recall → 进一步 decay → 最终 archive

### Scenario: cosine 接近时 boost 起决定作用
- **GIVEN** rule type 有 3 个 atom, cosine 接近(0.7 / 0.71 / 0.69), 但 strength/importance 差异大:
  - atom A: cosine=0.7, strength=1.0, importance=1.0 → score = **1.05**
  - atom B: cosine=0.71, strength=0.0, importance=0.0 → score = **0.71**
  - atom C: cosine=0.69, strength=0.5, importance=0.5 → score = 0.69 × 1.25 = **0.8625**
- **WHEN** search 返回(组内按 score DESC)
- **THEN** 顺序为 `[A, C, B]` — A 虽然 cosine 最低,但 boost 最大排第一;B cosine 最高但 boost 为 0 排最后
- **NOTE**: 在 cosine 差异 ≤ 0.02 的范围内,boost 完全决定了排名 — 这正是设计想要的(当 query 命中多个相近 atom 时,"越用越显"的胜出)

### Scenario: formatMemoryContext 注入时再做 distance asc 全局排序(只看 cosine 主键)
- **GIVEN** search 返回 6 条(round-robin 交错,**score 排序已应用**)
- **WHEN** `formatMemoryContext(results, 4000)` 渲染
- **THEN** 最终注入 LLM prompt 的 block 按 distance asc 全局排序(等价于 cosine DESC,只看主键),不再是 round-robin 交错
- **AND THEN** block 内格式 `[type] title\nsummary\nid: <uuid>\nTags: ...`,LLM **看不到** score / strength / importance(这些是 metadata,不在 block 里)
- **NOTE**: score 排序的影响**仅**体现在 search response(给 UI / 调试看),prompt 注入只按 cosine 主键。这是有意为之 — LLM 拿 prompt 时只看 cosine,score / strength / importance 是 metadata,不暴露给 LLM。

### Scenario: tone scoring 边界词 "如果"
- **GIVEN** user 消息 "如果今天有空,就帮我看下 bug"
- **WHEN** `scoreUserTone` 扫描
- **THEN** 返回 weak(0.35),因为 "如果" 在 WEAK 词表
- **NOTE**: "如果" 在某些语境是中性(如"如果下雨"),词表可能需要更精确的上下文判断 — 当前用纯词表匹配,接受这层精度损失。

### Scenario: runDecay 与 score 公式的协同 (遗忘 → 清理 完整链条)
- **GIVEN** fact type 有 atom F,初始 importance=0.7,strength=0.7,access_count=0,last_access=now
- **AND GIVEN** 当前 score = 0.7(cosine) × (1 + 0.3×0.7 + 0.2×0.7) = 0.7 × 1.35 = **0.945**
- **WHEN** 30 天过去,atom F 从未被 `memory_get` 调过
- **THEN** `runDecay` 触发(`deltaDays = 30`):
  - `strength_new = 0.7 × exp(-0.0513 × 30 / 0.7) ≈ 0.7 × exp(-2.2) ≈ 0.7 × 0.111 = **0.078**
  - 0.078 < archiveThreshold (0.1) → F 被 archive
- **AND THEN** F.archived = 1,下次 search 不可见(`archived = 0` WHERE 过滤)
- **NOTE**: score 公式让 strength 衰减有"显式可见"的效果 — 即使 atom 没被 archive(score 仍 ≥ 0.65 cosine 阈值),排名下降会让它从 top-3 跌出,进一步 decay,最终 archive。这是 **"遗忘强度决定清理"** 的完整链条。
- **NOTE2**: 如果 F 被 agent 通过 `memory_get` 调过,F.last_access = now → 下次 decay 时 `deltaDays < 1/24` (1 小时),跳过衰减 → F.strength 保持 → F 持续留在 search top-3 → 形成 "越用越显, 不用就忘" 的反馈循环。

### Scenario: rule type 永不 archive(即使 strength 极低)
- **GIVEN** rule type 有 atom R,importance=0.5,strength=0.05(极端衰减后),cosine=0.7
- **WHEN** 计算 score
- **THEN** score = 0.7 × (1 + 0.3×0.05 + 0.2×0.5) = 0.7 × 1.115 = **0.7805**
- **AND THEN** rule atom 不被 `runDecay` archive(`if (atom.type === "rule") continue` 在 decay.ts:51)
- **NOTE**: 即使 strength 衰减到 0.05,rule atom 仍保留,只是 score 较低(importance 0.5 仍提供 0.1 boost)。这是 memory-v2 的"rule 永不 archive"原则的体现。