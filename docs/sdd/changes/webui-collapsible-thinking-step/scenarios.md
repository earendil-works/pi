# 使用场景

## 正常流程

### 场景: 含 thinking + tool + final response 的典型 turn
- **GIVEN** 一个 assistant message,parts 为 `[thinking, toolCall, toolResult, text]`,`isStreaming=true`
- **WHEN** MessageParts 渲染
- **THEN** 出现 step header `● Executing (Xs) ▼`,body 展开,body 内顺序显示 thinking(默认折叠)→ toolCall → toolResult → final text(markdown)

### 场景: 推理完成后 step 自动折叠
- **GIVEN** 同上 turn,`isStreaming=true`,body 展开
- **WHEN** `isStreaming` 变 `false`
- **THEN** body 自动折叠,header 变 `✓ Completed (Xs) ▲`,Xs 是从 timestamp 到现在经过的秒数

### 场景: 点击 header 手动展开/折叠
- **GIVEN** step 已折叠 (`✓ Completed (Xs) ▲`)
- **WHEN** 用户点击 header
- **THEN** body 展开,chevron 转 `▼`,再点击折叠回 `▲`

### 场景: 纯 text turn 不包裹
- **GIVEN** 一个 assistant message,parts 只有 `[text]`
- **WHEN** MessageParts 渲染
- **THEN** 不出现 step header,直接渲染 TextItem (markdown),与改动前完全一致

## 异常流程

### 场景: turn 中途被中止 (stopReason=aborted)
- **GIVEN** assistant message,parts 为 `[thinking, toolCall]`,`isStreaming` 切到 `false`,`stopReason=aborted`(后续加入 Message 类型)
- **WHEN** MessageParts 渲染
- **THEN** step 出现,header `⚠ Aborted (Xs) ▲`,body 默认折叠,展开看到 thinking + tool call,没有 final text

### 场景: 推理中 turn 还未持久化
- **GIVEN** 用户发送 prompt,`isThinking=true`,messages 列表里还没有新 assistant message
- **WHEN** ChatPage 渲染
- **THEN** 没有 step header 显示 (因为 message 不在列表里),`ThinkingIndicator` 在底部 spinner 转动

### 场景: 推理完成到下次 poll 之间
- **GIVEN** agent 刚 emit `done` 事件,`isThinking=false`,但 webui 还没拉取新 message
- **WHEN** ChatPage 渲染 (使用旧 messages 列表)
- **THEN** 旧 messages 列表的最后一条 step 切到 `✓ Completed (Xs) ▲`,Xs 从 timestamp 算到 now;几百毫秒后 poll 拉到新 message,新 message 立刻显示为已完成 step

### 场景: 极长 turn (100+ 工具调用)
- **GIVEN** turn 累积 100 个 toolCall + 100 个 toolResult
- **WHEN** MessageParts 渲染,body 展开
- **THEN** ToolGroup 仍按现有阈值(>4 自动折叠成 summary),step header 仍正常显示 `✓ Completed (Xs) ▲`;用户可手动展开 ToolGroup 看详情

## 边界条件

### 场景: 纯 thinking turn (无 tool 无 final text)
- **GIVEN** assistant message,parts 只有 `[thinking]`
- **WHEN** MessageParts 渲染
- **THEN** 出现 step header,body 内只显示 ThinkingItem(默认折叠成"思考"按钮);展开 step 后看到 thinking 按钮,再点 thinking 按钮才看到 CoT 文本

### 场景: 纯 tool turn (无 thinking 无 final text)
- **GIVEN** assistant message,parts 只有 `[toolCall, toolResult]`
- **WHEN** MessageParts 渲染
- **THEN** 出现 step header,body 内只显示 ToolGroup(可能折叠为 summary 视 tool 数量)

### 场景: 多个 text block 中间有 tool
- **GIVEN** parts 为 `[thinking, text(interim), toolCall, toolResult, text(final)]`
- **WHEN** MessageParts 渲染
- **THEN** step 包裹全部 5 个 part,body 内顺序: thinking(折叠) → interim text(markdown) → ToolGroup → final text(markdown)。step header `✓ Completed (Xs) ▲`

### 场景: 空 parts
- **GIVEN** assistant message,parts 为 `[]`
- **WHEN** MessageParts 渲染
- **THEN** 显示 `(empty turn)` 占位符,不出现 step header(空 turn 不算 step)

### 场景: 超过 1 小时的旧 turn
- **GIVEN** messages 列表里有 2 小时前的 assistant turn,timestamp 是 2h ago
- **WHEN** MessageParts 渲染
- **THEN** step header 显示 `✓ Completed (7200s) ▲`(纯客户端 `Date.now() - timestamp` 算);user 知道这是近似值(可接受)
