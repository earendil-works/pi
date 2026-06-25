# 变更提案: webui-collapsible-thinking-step

## 动机
当前 webui 把 assistant turn 里的 thinking / text / toolCall 全部平铺显示,问题:
- 长 CoT 占据整个聊天流,挤掉用户真正想看的内容
- 一连串工具调用 6+ 行展开,噪音 > 信息
- 用户回头翻历史 turn,看到 5KB thinking 文本 + 一堆 tool card 容易迷路
- 实时反馈弱: 推理时用户分不清"模型还在跑"vs"模型卡死"

飞书 aily / Cursor / Claude.ai 的解法: **整个 turn 包裹成可折叠 step**。Header 永远显示 `● Executing (Xs) / ✓ Completed (Xs)` + chevron,body 推理时展开让用户看 CoT 实时生成,推理完自动折叠只留 header。展开看全部细节。

TUI 用户已习惯 pi 的紧凑 TUI 风格(只动 webui,符合项目惯例"stock 原语组合,不去 fork 上游")。

## 影响范围
- 修改 Capability: `webui-message-rendering`
  - 在 `chat-message-rendering` 已有 structured parts 的基础上,新增"step wrapper"概念
  - 新增 `<StepHeader>` 组件,新增 `isStreaming` prop 透传
  - `MessageParts` 重新组织 chunks 算法,把整个 turn 当一个 step
  - `MessageBubble` / `ChatMessages` 透传 `isStreaming` prop

- 新增 Capability: 无
- 删除 Capability: 无

## 非目标
- **TUI 不动**: pi 的 TUI 用户对当前 AssistantMessageComponent 已习惯,且 hideThinkingBlock 机制是 stock 原语,不动
- **不展示精确 duration**: 客户端用 `Date.now() - timestamp` 1s tick,过去 turn 会被多算(几小时前 turn 显示 "5h" 而非真实 56s)。用户接受这种"近似但不冻"语义
- **不后端化**: 纯前端实现,不动 JSONL 格式 / TUI 写盘逻辑 / server routes
- **不改 thinking 内容**: 仍然按 `Part` 渲染,只是外层包 step
- **不动 ToolGroup 内部 UI**: tool call / tool result / image card 已有逻辑保留
- **不动 MessageHeader / MessageFooter**: 只在 MessageParts 加 step wrapper

## 验收标准

### AC-1: 触发条件
- 纯 text turn (无 thinking 无 toolCall) → 渲染不变,不出现 step wrapper
- 含 thinking 或 toolCall/toolResult 的 turn → 出现 step wrapper,header 永远可见

### AC-2: 视觉
- step 头部一行显示:`● Executing (Xs) ▼`(推理中)/ `✓ Completed (Xs) ▲`(推理完),Xs 为整数秒
- chevron `▼` = 展开,`▲` = 折叠
- header 点击 toggle,body 显示/隐藏

### AC-3: streaming 行为
- 当前 turn (`isThinking=true` 且最后一条 message): body 默认展开,CoT 实时可见
- 切到 done 时 (`isThinking=false`): body 自动折叠,header 转为 `✓ Completed`

### AC-4: duration 计算
- 所有 message 用 `Date.now() - new Date(timestamp).getTime()` / 1000
- 组件 mount 后用 setInterval(1000) 触发 re-render,持续更新
- 过去 turn 的 duration 会"增长"(`Date.now()` 持续增加),这是已知可接受行为

### AC-5: 兼容性
- 现有 265/265 webui 测试全部通过
- `ThinkingItem` / `ToolGroup` / `ToolCallItem` / `ToolResultItem` / `ImageItem` 行为不变
- `Markdown` 渲染不变
- `AskUserQuestionCard` 集成不变
- MessageBubble 接口加 `isStreaming?: boolean` 可选 prop,默认 false,向后兼容

### AC-6: 测试覆盖
- `MessageParts.test.tsx` 新增 4 个 case:
  - 纯 text → 不出现 step header
  - 含 thinking → 出现 step header,body 展开 (isStreaming=true)
  - 含 toolCall → 出现 step header
  - 点击 header → body toggle
- 现有 thinking/toolCall 折叠测试不回归
