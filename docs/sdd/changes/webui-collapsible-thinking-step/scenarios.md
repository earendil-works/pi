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
- **WHEN** MessageParts 渲染 (`isStreaming=false` → fold 折叠)
- **THEN** fold 包裹 thinking + ToolGroup,both text parts (interim + final) 渲染在 fold 外的 sibling 节点,均可见。fold 折叠时 DOM 顺序: StepHeader(折叠态) → interim text(markdown) → final text(markdown)。step header `✓ Completed (Xs) ▲`

### 场景: 空 parts
- **GIVEN** assistant message,parts 为 `[]`
- **WHEN** MessageParts 渲染
- **THEN** 显示 `(empty turn)` 占位符,不出现 step header(空 turn 不算 step)

### 场景: 超过 1 小时的旧 turn
- **GIVEN** messages 列表里有 2 小时前的 assistant turn,timestamp 是 2h ago
- **WHEN** MessageParts 渲染
- **THEN** step header 显示 `✓ Completed (7200s) ▲`(纯客户端 `Date.now() - timestamp` 算);user 知道这是近似值(可接受)

### 场景: 推理过程展开时,最终 text 在 fold 外可见 (核心 spec)
- **GIVEN** parts 为 `[thinking, toolCall, toolResult, text]`,`isStreaming=true`
- **WHEN** MessageParts 渲染
- **THEN** fold 展开,body 内显示 thinking + ToolGroup;fold 外显示 final text(markdown)。**text 不在 fold 内**

### 场景: 推理过程自动折叠后,最终 text 仍可见 (核心 spec)
- **GIVEN** 同上 turn,fold 展开 + text 外可见
- **WHEN** `isStreaming` 变 `false`,fold 自动折叠
- **THEN** fold 折叠 (thinking + ToolGroup 从 DOM 移除);**final text 仍可见**(在 fold 外的 sibling 节点)。user 不需要点击 step header 也能看到 agent 的最终回复

### 场景: 纯 text turn 不出现 fold
- **GIVEN** parts 为 `[text, text]` (多个纯 text,无 thinking/tool/image)
- **WHEN** MessageParts 渲染
- **THEN** 不出现 step header、不出现 fold 容器,直接渲染 `<div className="flex flex-col gap-2">` 包住所有 TextItem,DOM 中无 `rounded-lg border` 节点

### 场景: 纯 inference turn (无 text) 正常包 fold
- **GIVEN** parts 为 `[thinking]` 或 `[toolCall, toolResult]`,无 text
- **WHEN** MessageParts 渲染
- **THEN** fold 正常包 inference;textChunks 为空,fold 外无 sibling 节点

### 场景: 中间 streaming text 与 tool 顺序: text 全部在 fold 后 (副作用 spec)
- **GIVEN** parts 为 `[thinking, text("interim"), toolCall, toolResult, text("final")]`,`isStreaming=true`
- **WHEN** MessageParts 渲染
- **THEN** fold 内容 (thinking + ToolGroup) 先出现;fold 外依次出现 `interim-text` + `final-text` (原序)。interim text 不在 fold 内,而是与 final text 一同出现在 fold 之后
