# Debug Report: multi-select-card-missing-options

- **日期**: 2026-06-09
- **症状**: User 在 webui 测试 multi-select (multiSelect=true) 的 ask_user_question 时,卡片**不渲染**。模型持续 "Generating…",且 pi 进程永不结束,因为 `ctx.ui.input()` 永远不 resolve。
- **根因**: `packages/webui/web/src/pages/ChatPage.tsx:266-300` 旧 `extension_ui_request` handler 从事件 `e.options` 读取 options,但 multi-select 走 `ctx.ui.input()` → rpc 协议发出 `extension_ui_request { method: "input", title, placeholder }` —— 事件**没有** `options` 字段。同时 `multiSelect: options.length > 5` 永远 false(选项数被 ext 限制在 2-4)。
  - **因果链**: model 发 toolCall (含 options + multiSelect=true) → pi 调用 `ctx.ui.input(title, placeholder)` → rpc-mode 发 `extension_ui_request { method: "input", id, title, placeholder }` → webui ChatPage handler 读 `e.options`(undefined) → `normalizeOptions(undefined)` → 返 [] → `if (options.length < 2) return` → 无卡片创建 → 消息流只显示 toolCall 按钮 + JSON args 文本 → 用户无法输入 → pi 的 `ctx.ui.input` 永远挂起 → 模型 stuck
- **修复**: `packages/webui/web/src/pages/ChatPage.tsx:266-321` — 从匹配的 toolCall `args.options` 和 `args.multiSelect` 读 options 和 multiSelect,事件只作为 fallback。multiSelect 也支持从 `e.method === "input"` 推断。
- **防御层**:
  - **API 边界**: ChatPage 不再假设 extension_ui_request 一定带 options,改为 lookup 关联 toolCall
  - **业务逻辑**: 用 setMessages(prev => ...) 闭包读 latest state,避免 closure 捕获的 messages 过期
  - **测试覆盖**: 新增 2 个 reproducer 测试 (multi-select: input method has no options, must use toolCall args; multiple consecutive cards)
- **经验教训**:
  - 设计假设错了:RpcExtensionUIRequest 类型 union 里 `input` 方法的 payload 跟 `select` 完全不同(没有 options 数组),但 webui 把它们当同一种处理
  - 测试盲点:之前所有 ChatPage 集成测试都用 `extension_ui_request` with `options` 直接传入 — 完全没测过真实 pi server 流程(message_end 先到,带 toolCall.args,后到 input method request)
  - **TDD 教训**: 在 TDD 时,测试 event 应当模拟"真服务器发的形状",而不能简化用"理想化输入"。如果当时测试发送的是 method="input" 的 extension_ui_request,bug 在第一轮 RED 就会暴露
- **测试结果**:
  - 复现测试 RED → GREEN (multi-select card renders numbered options + input box)
  - 复现测试 RED → GREEN (multiple consecutive cards each tracked independently)
  - 全量: ext 146 / server 218 / web 233 = **597 pass**
  - `npm run check` clean
