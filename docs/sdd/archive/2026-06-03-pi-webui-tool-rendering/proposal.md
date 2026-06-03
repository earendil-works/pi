# 变更提案: pi-webui-tool-rendering

## 动机
当前 webui 渲染真实聊天对话时,丢失了 **3 种关键内容**:
- **Thinking 块** (1510 处): agent 推理过程完全隐藏
- **Tool calls** (1496 处): agent 调用工具(读文件/bash/satellite)看不见
- **Tool results** (1489 处): 工具返回结果完全消失,debug 时只能去翻 JSONL

实测 019e7188 session (3676 messages) 里:
- 1226 个 assistant 消息 (64%) 只含 thinking + toolCall,没 text → webui 渲染成 1226 个**空 "Assistant" 气泡**
- 1489 个 toolResult 整条过滤掉 → chat 历史里 "读文件"、"跑 bash"、"执行 satellite" 全部不可见

`readMessages` 把 `toolResult` role 整个过滤(不是 user/assistant/system),`Message` 模型只有 `{role, content: string}`,`MessageBubble` 只读 `message.content`。三层全丢,真实聊天**无法阅读**。

这违背 webui 最初 spec "显示真实聊天" 核心需求。

## 影响范围
- **新增 Capability**: `chat-message-rendering` (text + thinking + toolCall + toolResult + image parts)
- **修改 Capability**: `webui` (SessionMessage 数据结构 + ChatMessages UI + ChatPage 适配)
- **删除 Capability**: 无

## 非目标
- 不重写 `cron` / `memory` / `session-pool`
- 不改 pi core (`packages/ai` / `packages/coding-agent`)
- 不做 streaming live tool execution 渲染(只做历史回放;live streaming 阶段已经在 05888e0c 处理 message_end)
- 不实现 tool call 的可点击交互(可后续 quickfix 加)
- 不做图片 lazy load / click-to-expand (本期直接 inline 渲染)

## 验收标准
1. **真实聊天可读**: 019e7188 session 在 webui 看到 thinking(可折叠)、tool call(带名字+args)、tool result(带内容,超 5KB 截断)
2. **空 assistant 不显空泡**: 1226 个空 assistant 折叠进 turn,不再出现 12+ 连续空 "Assistant" 卡片
3. **架构清晰**: 一个 assistant turn = 一个 MessageBubble(内含 parts),符合用户选 B
4. **API 返结构化**: `/api/sessions/:id/messages` 返 `Message[]` with `parts: Part[]` 数组,不是单一 `content: string`
5. **TypeScript 类型完整**: 5 种 Part 类型 (TextPart/ThinkingPart/ToolCallPart/ToolResultPart/ImagePart) 都有 discriminated union
6. **测试覆盖**: server `readMessages` 至少 5 个新测试 (每个 part 类型 + 边界);web ChatMessages 至少 3 个新测试 (turn grouping, tool result truncation, thinking collapse)
7. **E2E**: 浏览器打开 019e7188 → 看到 thinking + tool calls + tool results,无 12+ 空泡
