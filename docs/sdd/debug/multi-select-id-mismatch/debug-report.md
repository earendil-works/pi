# Debug Report: multi-select ask_user_question card stuck — extension_ui_request id mismatch

- **日期**: 2026-06-09
- **症状**: 多选(多选 = `method:"input"`)ask_user_question 卡不渲染,模型卡在 `ctx.ui.input()` 等用户响应(5分钟超时后报 cancelled)
- **根因**: `packages/coding-agent/src/modes/rpc/rpc-mode.ts:98` 每次开 dialog 都用 `crypto.randomUUID()` 生成新的 `extension_ui_request.id`,而 toolCall 在 message content 里有自己的 id(`call_00_...`)。webui 旧代码假设 `e.id` == `toolCallId` 去找 matching toolCall,实际上两者永远不匹配,导致 multi-select 找不到 options(`method:"input"` 事件无 options 字段,只能从 toolCall args 拿),card 永远创建不出来
- **因果链**: rpc-mode `crypto.randomUUID()` for dialog id → webui `find(p.id === e.id)` never matches → `options = []` → 跳过 card 创建 → model hangs in `ctx.ui.input()` 5min → timeout → "User cancelled the question"
- **修复**: webui 改为 **按 recency 匹配**: 在 messages 里倒序找最近的 `ask_user_question` toolCall,跟 cardState 是否已存在无关
- **防御层**:
  - **Webui 客户端**: 删 id 匹配,改 recency 匹配 — 单点 root cause fix
  - **CardState 增加 `requestId` 字段**: 存原始 `e.id` (UUID) 用于 `extension_ui_response` 回传,因为 server 的 `pendingExtensionRequests` map 仍 key by UUID
  - **`handleCardSubmit/Cancel` 用 `requestId` 发 ws**: 不是 toolCallId
  - **测试加 reproducer**: `multi-select card renders when extension_ui_request id is a UUID unrelated to toolCall id` — 实际场景,UUID != toolCallId,确保 multi-select 渲染 + 提交后回传 UUID
- **经验教训**:
  - 测试不能 mock 出错的协议细节 — 之前测试用 `id: "tc-1"` 跟 toolCall id 相同,掩盖了真实协议行为;测试必须反映生产协议(用 UUID 跟 toolCall id 不同)
  - 当 server 协议用随机 id 时,client 必须用更鲁棒的关联(时间、上下文、显式参数),不能假设 id 字段会一致
  - 修 `rpc-mode.ts` 改 toolCallId 流也可以,但波及 `wrapToolDefinition` / `pi-agent-core` 等,scope 大;webui 端按 recency 匹配是局部、对用户透明、测试好覆盖的修复

## Why single-select "worked" before (but actually didn't, just got cancelled/timeout)

之前用户报告 "单选连续多次可工作",但实际:

1. 旧代码 `find(p.id === e.id)` 永远不匹配
2. 单选 fallback: `if (options.length < 2) options = normalizeOptions((e as any).options)` — `method:"select"` 事件**带** options 字段(`rpc-types.ts:214`),所以即使没匹配 toolCall 也能从事件拿 options
3. 多选 `method:"input"` 事件**不带** options 字段(`rpc-types.ts:216-222` — 只有 `title` 和 `placeholder`),fallback 拿不到,options.length = 0,card 不创建

所以"单选工作"是巧合:事件本身带 options。修复后单选+多选都通过 recency 匹配拿 toolCall args,行为更一致。

## Fix scope

仅 webui 端改:
- `packages/webui/web/src/pages/ChatPage.tsx`: 重写 `extension_ui_request` handler (recency 匹配 + requestId 存储)
- `packages/webui/web/src/components/AskUserQuestionCard.tsx`: CardState 加 `requestId?: string`
- `packages/webui/web/src/pages/ChatPage.test.tsx`: 新增 reproducer + 修旧测试用 UUID 协议

**rpc-mode.ts / server / ws handler 都不动** — 协议保持不变,client 适配。
