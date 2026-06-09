# Debug Report: card-phantom-empty-buttons

- **日期**: 2026-06-09
- **症状**: 每个 assistant turn 在 page 上产生 3-4 个 phantom "ask_user_question" 按钮(无 question 文本,无 args)。原本的 tool call 旁边多出一堆"ask_user_question" 折叠按钮
- **根因**: `packages/webui/web/src/pages/ChatPage.tsx:266-330` extension_ui_request handler **未按 method 过滤**。pi 的 rpc-mode 会在 extension 调用 `ctx.ui.setTitle()` / `setStatus()` / `setEditorText()` / `setWidget()` / `notify()` 时 emit `extension_ui_request` 事件(method 是这些方法名,id 是 `crypto.randomUUID()`)
  - **因果链**: extension 调 `ctx.ui.setTitle("X")` → rpc-mode emit `extension_ui_request { id: uuid, method: "setTitle", title: "X" }` → webui session-pool 转发 → ChatPage handler 收 → 不看 method → 去 messages 找 toolCall with id=uuid(找不到) → 创建 synthetic message `{ name: "ask_user_question", args: {} }` → UI 渲染 phantom 按钮(折叠状态只显示 name)。每个 turn 触发 3+ 个 fire-and-forget 事件 → 3+ phantom 按钮
- **修复**: `packages/webui/web/src/pages/ChatPage.tsx:266-271` 在 handler 入口加 method 过滤: `if (m !== "select" && m !== "input") return;`
- **防御层**:
  - **API 边界**: ChatPage 不再把任何 extension_ui_request 当 ask_user_question 处理。`setTitle` / `setStatus` / `set_editor_text` / `setWidget` / `notify` 是 fire-and-forget,webui 当前不展示这些 widget,直接 ignore
  - **业务逻辑**: 早期 return 在 setMessages 之前,避免无谓的状态更新
  - **测试覆盖**: 新增 1 个 reproducer test 验证 4 种 fire-and-forget methods (setTitle/setStatus/set_editor_text/notify) 都不创建 phantom 按钮,而 `select` method 正常工作
- **经验教训**:
  - 协议设计教训: `extension_ui_request` 事件按 union type 有 8 种 method,每种 payload 结构不同。webui 之前假设"所有 method 都是 ask_user_question 相关",这是错误的假设
  - **TDD 教训**: 之前所有测试都用 `extension_ui_request` without `method` 字段 + `options` 数组 → 触发的是 `select` 路径,没暴露其他 method 的污染
  - **e2e 教训**: 单测 pass 不代表 e2e 工作。本次 bug 在用户实际浏览器 e2e 测试中才暴露 — 因为 `setStatus` 等是其他 extension 的副作用,测试 mock 不会发这些事件
- **测试结果**:
  - 复现测试 RED → GREEN (setTitle 等 4 种 method 不产生 phantom 按钮)
  - 全量: ext 146 / server 218 / web 234 = **598 pass**
  - `npm run check` clean
  - **e2e 浏览器验证**: 刷新页面后 phantom 按钮消失,每个 turn 只有 1 个真实 ask_user_question 按钮
