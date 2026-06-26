# memory-pipeline Specification (Delta)

> Capability: memory-pipeline — memory atom 写入/读取/搜索管线的核心流程
> 本 spec 是对 `docs/sdd/specs/spec.md` 中已有 memory 能力的扩展 + 修改。
> 当前 `spec.md` 尚未单列 `memory-pipeline` capability,本 delta 增量贡献。

## ADDED Requirements

### Requirement: 写入冲突通过 If-Match 头终止
`PATCH /api/memory/:id` SHALL 要求请求带 `If-Match` 头,值为当前服务端 atom `version`(或 `"*"` 表示 any-version)。
服务端 SHALL 在 `existing.version !== ifMatch` 时返回 `409 {error:"version_conflict", current:atom}`,客户端 SHALL 用 409 响应触发重载或合并提示。

#### Scenario: 客户端带匹配的 If-Match,写入成功
- **GIVEN** 服务端 atom `version=5`
- **WHEN** 客户端发送 `PATCH /api/memory/:id` 带 `If-Match: "5"`
- **THEN** 服务端返回 200 + 新 atom(version=6)

#### Scenario: 客户端带过期 If-Match,返回 409
- **GIVEN** 服务端 atom `version=5`,客户端缓存 version=4
- **WHEN** 客户端发送 `PATCH` 带 `If-Match: "4"`
- **THEN** 服务端返回 409,响应 body 含 `current` 字段(服务端最新 atom)

#### Scenario: 客户端缺 If-Match,返回 400
- **GIVEN** 服务端 atom `version=5`
- **WHEN** 客户端发送 `PATCH` 不带 `If-Match` 头
- **THEN** 服务端返回 400 `{error:"missing_if_match"}`

#### Scenario: If-Match 为 * 表示 any-version
- **GIVEN** 服务端 atom `version=5`
- **WHEN** 客户端发送 `PATCH` 带 `If-Match: "*"`
- **THEN** 服务端跳过 version 校验,正常处理(预留逃生口)

### Requirement: webui 写入路径自动 cosine 去重
`PATCH /api/memory/:id` SHALL 在写入前计算新内容的 embedding,与现有 active atom 求最大 cosine similarity;当 similarity ≥ 0.92 时 SHALL 走 `markSupersededTx`,新 atom 继承旧 atom 的 strength/access_count;否则正常 updateAtom。
当 `embedText` 返回 null(ollama down)时 SHALL 跳过 cosine 检查,走原 updateAtom 流程(graceful degradation,见 search.ts Decision 7)。

#### Scenario: 新内容与现有 atom cosine > 0.92,触发 supersede
- **GIVEN** 数据库存在 active atom A(content="X"),现有 PATCH 内容 Y 与 A cosine=0.95
- **WHEN** 客户端发送 PATCH 写 Y
- **THEN** 服务端调 `markSupersededTx(A.id, newAtom, embedding)`,A `is_latest=0`,新 atom `is_latest=1`,响应 body 含 `previousId: A.id`

#### Scenario: cosine = 0.92 边界走 supersede
- **GIVEN** 新内容与 A cosine=0.92(等于阈值)
- **WHEN** 客户端 PATCH 写入
- **THEN** 沿用 `>=` 比较,等同 supersede

#### Scenario: ollama 不可达,跳过 cosine 检查
- **GIVEN** `embedText` 返回 null
- **WHEN** 客户端 PATCH 写入
- **THEN** 服务端跳过 supersede 检查,走原 updateAtom 流程,响应 200 但 body 无 `previousId`

### Requirement: tag 写入归一化
`PATCH /api/memory/:id` SHALL 在合并 tags 字段前调用 `normalizeTags(input, settings.memory.tagAliases)`。归一化规则:trim → 空字符串过滤 → alias map 折叠 → `new Set` 去重 → 保序。
当 `settings.memory.tagAliases` 缺失或非对象时 SHALL 跳过 alias 折叠,仅做 Set 去重。

#### Scenario: tag 输入经 alias 折叠后去重
- **GIVEN** `settings.memory.tagAliases = {"代码规范": "code-style", "coding-rule": "code-style"}`
- **WHEN** 客户端 PATCH 带 `tags: ["代码规范", "code-style", "coding-rule"]`
- **THEN** 写入 DB 的 `atom.tags = ["code-style"]`

#### Scenario: tag_aliases 缺失,跳过折叠
- **GIVEN** `settings.memory.tagAliases` 未设置
- **WHEN** 客户端 PATCH 带 `tags: ["a", "a", "b"]`
- **THEN** 写入 DB 的 `atom.tags = ["a", "b"]`(仅 Set 去重)

### Requirement: 检索 score 公式含 tag_overlap 和 freshness
`recallAtoms` SHALL 在既有 `score = cosine × (1 + 0.3 × strength + 0.2 × importance)` 主项之上加法叠加 `tag_overlap` 和 `freshness_decay` 两维度:
- `tagOverlap = computeTagOverlap(query, atom.tags)`,query 经 alias 折叠后与 atom.tags 求交集大小 / 归一化 token 数
- `freshness = exp(-daysSinceUpdate / 30)`,importance 因子 MVP 固定 0.5
- 默认权重 `tagOverlapWeight = 0.10`, `freshnessWeight = 0.05`,均可由 `settings.memory.{tagOverlapWeight, freshnessWeight}` 覆盖
- `RecallResult` SHALL 新增字段 `tagOverlap: number` 和 `freshness: number` 用于 debug

主项 `score = cosine × (1 + 0.3s + 0.2i)` SHALL 保持数值不变(back-compat)。

#### Scenario: tag 命中的 atom 反超纯 cosine 高的 atom
- **GIVEN** query="code-style",atom A tags=["code-style"] cosine=0.7,atom B tags=[] cosine=0.85
- **WHEN** 服务端执行 recall
- **THEN** A.score = 0.7×(1+0.3s+0.2i) + 0.10×1.0 + 0.05×f ≥ B.score 排序上 A 排在 B 前或同位

#### Scenario: 自然语言 query 不受 tag_overlap 影响
- **GIVEN** query="怎么写 JavaScript",所有 atom 的 tag 都不匹配该 token
- **WHEN** 服务端执行 recall
- **THEN** tagOverlap 全部 = 0,排序完全由 cosine × (1+0.3s+0.2i) + 0.05×freshness 主导

### Requirement: 单 atom 状态通过 SSE 推送
服务器 SHALL 提供 `GET /api/memory/:id/stream` SSE 端点;当任一客户端 PATCH 该 atom 时,所有订阅的连接 SHALL 收到 `event: atom\ndata: <JSON>\n\n` 帧。
服务器 SHALL 每 25 秒发送 SSE 注释帧 `: ping\n\n` 维持 NAT/中间设备连接。
客户端 SHALL 仅在 `incoming.version > localAtom.version` 时接受推送(单调递增防乱序)。

#### Scenario: 订阅 SSE 后 PATCH 触发推送
- **GIVEN** 客户端 A 订阅 `GET /api/memory/<id>/stream`,客户端 B PATCH 同一 atom 成功
- **WHEN** 服务端完成 PATCH
- **THEN** 客户端 A 收到 `event: atom\ndata: {...}\n\n` 帧

#### Scenario: 心跳保活
- **GIVEN** 客户端订阅 stream 后 30s 内无 atom 变化
- **WHEN** 服务器保持连接
- **THEN** 服务器每 25s 推送 `: ping\n\n` 注释帧

#### Scenario: 客户端断连自动清理订阅
- **GIVEN** 客户端订阅 stream
- **WHEN** 客户端断开(res close)
- **THEN** 服务器从订阅表移除该连接,停止心跳发送

#### Scenario: 推送乱序防护
- **GIVEN** 客户端 localAtom.version=6
- **WHEN** 服务器因竞态先推 v=7 再推 v=6(理论上不应发生,但 EventSource 重连可能)
- **THEN** 客户端丢弃 `incoming.version < localAtom.version` 的事件

## MODIFIED Requirements

### Requirement: webui 客户端用 SSE 替代 3 秒轮询
`MemoryDetail` SHALL 用 `EventSource` 订阅 `GET /api/memory/:id/stream` 替代 `setInterval(fetchAtom, 3000)` 的轮询模式;首次加载仍调用 `GET /api/memory/:id` 拿首屏数据。
客户端 SHALL 仅在 `incoming.version > localAtom.version` 时接受推送以避免乱序覆盖。
客户端 SHALL 在 `EventSource.onerror` 时显示"连接中断,正在重连"提示(浏览器原生重连)。

#### Scenario: 客户端首次加载拉一次完整 atom
- **GIVEN** MemoryDetail 挂载(id=X)
- **WHEN** 组件 mount
- **THEN** 调用 `GET /api/memory/X` 一次,设置初始 atom;不轮询

#### Scenario: SSE 推送更新 UI
- **GIVEN** MemoryDetail 已订阅 stream,显示 atom v=5
- **WHEN** 其他客户端 PATCH 该 atom,服务器推送 v=6
- **THEN** 客户端 `setAtom(incoming)`,UI 重新渲染

### Requirement: write 流程包含 tag 归一化与 cosine dedup
`PATCH /api/memory/:id` SHALL 顺序执行:
1. `If-Match` 头校验
2. tag 归一化(`normalizeTags` + Set union with existing.tags)
3. embedding 计算
4. cosine dedup 检查(`supersedeIfSimilar`)
5. updateAtom 或 markSupersededTx
6. writeAtomToFile
7. 广播 SSE 事件

任意步骤失败 SHALL 返回 5xx,前面已成功的步骤 SHALL 回滚(事务)。

#### Scenario: 完整 PATCH 流程
- **GIVEN** atom A version=5,tags=["x"],content="old"
- **WHEN** 客户端 PATCH 带 `If-Match:"5"`,tags=["新标签"],content="new"
- **THEN** 服务端:校验 5 → 归一化 tags 与现有合并 → embed "new" → cosine 检查 → updateAtom 写 v=6,tags=["新标签","x"] → 写 .md 文件 → 广播 atom v=6 → 响应 200

## REMOVED Requirements

(无)

## RENAMED Requirements

(无)