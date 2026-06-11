# Scenarios: pi-webui-tool-rendering

## 正常流程 (Normal)

### Scenario: User 消息正常显示
- **GIVEN** session 有一条 user message `{"role":"user", "content":[{"type":"text","text":"hello"}]}`
- **WHEN** 浏览器加载 `/session/<id>`
- **THEN** 显示蓝色 "You" 气泡,内容为 "hello",时间戳在右侧

### Scenario: Assistant 纯文本消息显示
- **GIVEN** session 有一条 assistant message `{"role":"assistant", "content":[{"type":"text","text":"Hi Boss!"}]}`
- **WHEN** ChatPage 渲染
- **THEN** 显示灰色 "Assistant" 气泡,内容为 "Hi Boss!"

### Scenario: Assistant 含 thinking + toolCall + toolResult + text 全部显示
- **GIVEN** 一个 assistant turn 包含 4 个 parts: thinking(200字) + 2 个 toolCall + 1 个 toolResult + 1 个 text
- **WHEN** 渲染该 turn
- **THEN** 1 个 "Assistant" 气泡内,顺序显示: 折叠的 thinking + 2 个 ToolCallCard + 1 个 ToolResultBlock + 文本

### Scenario: Thinking 默认折叠
- **GIVEN** assistant message 有 thinking 200 字符
- **WHEN** 渲染
- **THEN** 默认显示 `💭 Thinking` 标签 + 展开按钮,正文折叠
- **WHEN** 点击展开
- **THEN** 灰色 monospace 文本框显示完整 thinking

### Scenario: ToolCall 显示名字+args 预览
- **GIVEN** assistant 调用 `read` tool,args = `{"path":"/home/qjh/pi/main.ts"}`
- **WHEN** 渲染
- **THEN** ToolCallCard 显示 `🔧 read` + `path: /home/qjh/pi/main.ts`,args 全 JSON 折叠在 details 里

### Scenario: ToolResult 默认限制 5KB
- **GIVEN** toolResult content = 10KB 文本
- **WHEN** 渲染
- **THEN** 显示前 5KB + "Show full output (10.0 KB)" 按钮
- **WHEN** 点击按钮
- **THEN** 完整内容展开,按钮变 "Show less"

### Scenario: ToolResult 跟随对应 ToolCall
- **GIVEN** assistant turn 有顺序: toolCall A, toolResult A, toolCall B, toolResult B
- **WHEN** 渲染
- **THEN** 视觉顺序: A.card, A.result, B.card, B.result (按 JSONL 时间顺序)

## 异常流程 (Abnormal)

### Scenario: Empty assistant turn 不显示空泡
- **GIVEN** assistant turn 只含 thinking + toolCall,完全没 text
- **WHEN** 渲染
- **THEN** 仍显示该 turn (含 thinking + tool cards),不是空白气泡

### Scenario: API 缺 toolResult role 不过滤错
- **GIVEN** session 包含 5 个 toolResult entries
- **WHEN** `/api/sessions/:id/messages` 调用
- **THEN** 返回结果包含这 5 个 toolResult 消息 (role: "toolResult"),**不**被过滤掉

### Scenario: Server readMessages 失败不挂
- **GIVEN** session JSONL 损坏 (某行 JSON.parse 失败)
- **WHEN** `/api/sessions/:id/messages` 调用
- **THEN** 跳过坏行,其余 200 OK

### Scenario: 未知 part 类型降级
- **GIVEN** JSONL 含 type: "futureType" (尚未实现的类型)
- **WHEN** readMessages 处理
- **THEN** 降级为 TextPart with text = "?",不抛错

### Scenario: 极长 thinking 不爆
- **GIVEN** thinking 文本 50KB
- **WHEN** 折叠显示
- **THEN** DOM 只渲染 50 字符预览 + "Thinking (50.0 KB)" 提示
- **WHEN** 展开
- **THEN** 完整 50KB 文本在 monospace 框内,带 max-height + 滚动

## 边界 (Boundary)

### Scenario: 0 messages session
- **GIVEN** session 文件只有 header 一行
- **WHEN** 加载
- **THEN** 显示 EmptyState "No messages yet"

### Scenario: 只有 toolResult 没有 toolCall 的孤立 turn
- **GIVEN** JSONL 含 toolResult 但 parent toolCall 不在 (极端数据)
- **WHEN** 渲染
- **THEN** 仍显示该 toolResult (作为 turn with toolResult 块,无对应 card)

### Scenario: 1 个 user 后立即 1000 个 tool results
- **GIVEN** user prompt 触发 1000 个并行 toolCall
- **WHEN** 渲染
- **THEN** 1 user 气泡 + 1 assistant 气泡含 1000 个 tool cards,DOM 渲染不卡 (用 React key + 虚拟滚动可选)

### Scenario: Image content inline 渲染
- **GIVEN** toolResult content 含 `{"type":"image", "mediaType":"image/png", "data":"<base64>"}`
- **WHEN** 渲染
- **THEN** 显示 `<img src="data:image/png;base64,...">` 元素,`max-h-96` 限高
- **AND** 多张图横向 flex-wrap 不堆叠
- **AND** 单图 < 24rem 高度,不撑爆页面

### Scenario: Image 大小超限
- **GIVEN** 单图 5MB PNG (1 万 x 1 万像素)
- **WHEN** 渲染
- **THEN** `<img>` 用 `object-contain` 缩放显示,`max-h-96` 限制
- **AND** 浏览器按原始大小 decode,初始 2s 内显示 (现代浏览器 lazy decode)

### Scenario: 3664 messages session (019e7188) 滚动流畅
- **GIVEN** 实际 session 有 3664 个 JSONL message entries
- **WHEN** 浏览器加载
- **THEN** 初始 200 消息渲染 < 2s,滚动到底流畅
- **THEN** 折叠的 thinking/tool call 不阻塞滚动
