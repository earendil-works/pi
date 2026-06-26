# 使用场景

## 正常流程

### Scenario: 客户端 PATCH 时 version 匹配,写入成功
- **GIVEN** 服务端 atom 当前 `version=5`,客户端缓存的 `localAtom.version=5`
- **WHEN** 客户端发送 `PATCH /api/memory/:id` 带 `If-Match: "5"`
- **THEN** 服务端校验通过,写入新内容,响应 200 + 新 atom(version=6),客户端更新本地 version

### Scenario: SSE 推送使客户端实时更新
- **GIVEN** 客户端已订阅 `GET /api/memory/:id/stream`,`MemoryDetail` 显示 version=5
- **WHEN** 另一个客户端 PATCH 同一 atom,服务端 version 升到 6
- **THEN** 服务端推送 `event: atom\ndata: {...}\n\n`,客户端收到后 `setAtom` 触发重新渲染,3s 轮询被替换

### Scenario: webui 写入触发 supersede
- **GIVEN** 数据库存在 active atom A(content="X"),cosine 阈值 0.92
- **WHEN** 客户端发送 PATCH,新 content="Y" 与 A 的 embedding cosine=0.95
- **THEN** 服务端调用 `markSupersededTx(A.id, newAtom, embedding)`,A 标 `is_latest=0`,新 atom 继承 A 的 strength/access_count

### Scenario: tag 输入"代码规范, code-style"被归一化
- **GIVEN** `settings.memory.tagAliases` = `{"代码规范": "code-style", "coding-rule": "code-style"}`
- **WHEN** 用户输入 tags `"代码规范, code-style, coding-rule"`
- **THEN** 写入前归一为 `["code-style"]`(alias 折叠 + Set 去重)

### Scenario: 检索 query 命中 tag 提升排序
- **GIVEN** query="code-style",atom A(tag=["code-style"]) cosine=0.7,atom B(tag=[]) cosine=0.85
- **WHEN** 服务端执行 recall
- **THEN** A.score = 0.7×(1+0.3s+0.2i) + 0.10×1.0 + 0.05×f,可能反超 B 的纯 cosine 排序

## 异常流程

### Scenario: 客户端用旧 version 发 PATCH,返回 409
- **GIVEN** 服务端 version=5,客户端缓存 version=4(已被 SSE 推送过但用户继续编辑)
- **WHEN** 客户端发送 `PATCH /api/memory/:id` 带 `If-Match: "4"`
- **THEN** 服务端返回 409 + body=`{error:"version_conflict", current:{...atom...}}`,客户端提示"远端已更新"

### Scenario: SSE 连接断开
- **GIVEN** 客户端 `EventSource` 已打开
- **WHEN** 网络抖动导致 readyState=CLOSED
- **THEN** 浏览器 EventSource 自动重连,客户端在 onerror 中清理状态并显示"连接中断,正在重连"

### Scenario: ollama 不可达,supersede 跳过
- **GIVEN** `embedText` 返回 null(ollama down)
- **WHEN** webui PATCH 写入新内容
- **THEN** 服务端跳过 cosine dedup 检查,直接走原 PATCH 流程(graceful degradation,见 search.ts Decision 7)

### Scenario: tag_aliases 缺失或格式错
- **GIVEN** `settings.memory.tagAliases` 不存在或非对象(例如 `null`)
- **WHEN** PATCH 写入带 tag 的 atom
- **THEN** `normalizeTags` 跳过 alias 折叠,直接 Set 去重(不阻断写入)

### Scenario: 同时收到两次 SSE 推送,version 顺序错乱
- **GIVEN** 客户端订阅 stream,服务端先推 v=6(被另一客户端写入),后推 v=7(本客户端刚 PATCH 成功)
- **WHEN** 客户端 `onmessage` 处理两次事件
- **THEN** 客户端用 `version` 单调递增比较,丢弃 `incoming.version < localAtom.version` 的旧事件

## 边界条件

### Scenario: cosine 正好等于阈值 0.92
- **GIVEN** 新内容与现有 A cosine=0.92(边界值)
- **WHEN** PATCH 写入
- **THEN** 沿用 `extraction.ts:147` 的 `>=` 比较,匹配走 supersede(不创建新 atom)

### Scenario: 极冷 atom 的 freshness_decay 接近 0
- **GIVEN** atom `updated_at` 是 365 天前,importance=0.5
- **WHEN** 计算 `freshness_decay = exp(-daysSinceUpdate / (30 * importance))`
- **THEN** 接近 0,衰减项贡献可忽略,但 cosine × strength × importance 主项仍生效,不会被完全埋没

### Scenario: SSE 心跳保活
- **GIVEN** 客户端连接 stream 后 30s 内无 atom 变化
- **WHEN** 服务端保持连接
- **THEN** 服务端每 25s 推送 `: ping\n\n` 注释帧(EventSource 不显示但保 TCP 不被中间设备切断)

### Scenario: 同时 PATCH 同一 atom 的并发竞争
- **GIVEN** 客户端 A 和 B 都缓存 version=5
- **WHEN** A 先 PATCH 成功(version→6),B 后 PATCH 带 `If-Match: "5"`
- **THEN** B 收到 409,A 的写入未被覆盖(SSE 让 B 客户端收到 v=6 推送并刷新本地)