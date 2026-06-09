# Tasks: add-ask-user-question-tool

> **Design:** design.md | **Base:** c9a4287dbc97b11a598149e1706e7a3c0420dd06

**Goal:** 在 personal-assistant extension 注册 `ask_user_question` tool,让 model 在 TUI/webui 双端都能让用户从选项中挑答案继续推演,消除 "Tool ask_user_question not found" 错误。

**Architecture:** 100% 走 stock pi 原语。Extension 端调 `ctx.ui.select()` / `ctx.ui.input()`,RPC 协议沿用 pi 上游既有的 `extension_ui_request` 出 / `extension_ui_response` 入 — webui server 只补一个 stdin 写入方法,webui client 弹 modal + 聊天页面插占位。零上游修改,未来可升级。

**Tech Stack:** TypeScript / TypeBox / Node `child_process` (stdin JSONL) / React 18 + Tailwind / Vitest / pi extension API / `ws` (browser) / `ws` (server)

## Notes

- 测试基线: server 209 / client 219 / personal-assistant 124,共 **552 tests pass**。本 change 目标新增 **38 tests** (19 ext unit + 6 server integration + 13 client component = 6 modal + 4 provider + 3 chat page),最终 **590 tests**
- TDD 顺序: 每 task 内先写 failing test → 跑确认 RED → 实现 → 跑确认 GREEN → commit
- 单元测试用 vitest 写;webui client 用 `@testing-library/react`
- 在 `personal-assistant/index.ts` 已有 `registerMemory/registerTools/registerCron` 三个 entry;只动 `registerAskUserQuestion` 一行新增
- pi 进程通过 `~/.pi/agent/extensions/personal-assistant` symlink 自动加载新文件,无需重启 pi;但 webui server 改动需 Ctrl-C 重跑

## 1. Extension 核心: 注册 tool + normalize + execute

- [x] 1.1 **写 `normalizeOptions` 单元测试**
  - **文件**: `extensions/personal-assistant/test/ask-user-question.test.ts` (Create)
  - **内容**: 测试 5 种 options 形态解析: 标准 `[{label,description}]` / `{item:[...]}` / `{item:{item:[...]}}` / `{item:{item:{item:[...]}}}` / `[]` 空 / `null` / 缺 description 字段
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/ask-user-question.test.ts -t "normalizeOptions" 2>&1 | grep -E "passed|failed"`,应输出 "failed"(RED,因为还没实现)
  - **依赖**: 无

- [x] 1.2 **实现 `normalizeOptions`**
  - **文件**: `extensions/personal-assistant/ask_user_question.ts` (Create) — 暂不 export 全部,只 export `normalizeOptions`
  - **内容**: 递归 unwrap `.item` 包装,直到拿到 array;每项校验 `label` 是 string,`description` 可选 string;返回 `NormalizedOption[]`
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/ask-user-question.test.ts -t "normalizeOptions" 2>&1 | grep -E "✓|×" | wc -l`,应 ≥ 8(8 个 normalizeOptions 子测试全 GREEN)
  - **依赖**: 1.1

- [x] 1.3 **写 `formatOptionForSelect` 单元测试**
  - **文件**: `extensions/personal-assistant/test/ask-user-question.test.ts` (Modify — 追加)
  - **内容**: 测试仅 label / label+description 两种输入
  - **验证**: 同 1.2,grep 计数应 +2(加 2 个 formatOptionForSelect 子测试)
  - **依赖**: 1.2

- [x] 1.4 **实现 `formatOptionForSelect`**
  - **文件**: `extensions/personal-assistant/ask_user_question.ts` (Modify — 追加)
  - **内容**: `description ? "${label} — ${description}" : label`
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/ask-user-question.test.ts -t "formatOptionForSelect" 2>&1 | grep "✓" | wc -l` 应 = 2
  - **依赖**: 1.3

- [x] 1.5 **写 `registerAskUserQuestion` + execute 测试 (mock pi)**
  - **文件**: `extensions/personal-assistant/test/ask-user-question.test.ts` (Modify — 追加)
  - **内容**: 测 tool registration(name="ask_user_question" 调一次 pi.registerTool);execute 的 8 个场景: 单选 happy / multi happy / cancel / options=1 / options=5 / options=4 合法 / multiSelect+1option / 缺 question / 嵌套畸形
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/ask-user-question.test.ts -t "execute" 2>&1 | grep "failed"` 应有 failed(RED)
  - **依赖**: 1.4

- [x] 1.6 **实现 `registerAskUserQuestion`**
  - **文件**: `extensions/personal-assistant/ask_user_question.ts` (Modify — 追加)
  - **内容**: `pi.registerTool({name: "ask_user_question", label: "Ask User Question", description: ..., promptSnippet: ..., parameters: Type.Object({question: Type.Optional(Type.String()), header: Type.Optional(Type.String()), options: Type.Any(), multiSelect: Type.Optional(Type.Boolean())}), execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => { ... }})`;execute 内 normalize → 校验 2-4 options → multiSelect 时 `ctx.ui.input(title, "${labels.join(' | ')} (comma-separated)", {timeout: 300000})`;否则 `ctx.ui.select(title, labels, {timeout: 300000})`;cancel/timeout 返回 `User cancelled the question` 或 `User did not respond within 5 minutes`
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/ask-user-question.test.ts 2>&1 | tail -5`,应 `Test Files 1 passed (1)` + `Tests 19 passed (19)`(11 normalizeOptions + 2 formatOption + 6 execute)
  - **依赖**: 1.5

- [x] 1.7 **挂上 extension entry**
  - **文件**: `extensions/personal-assistant/index.ts` (Modify — 加 1 import + 1 调用)
  - **内容**: `import { registerAskUserQuestion } from "./ask_user_question.ts";`;在 `export default function (pi) { ... }` 内 `registerAskUserQuestion(pi);`
  - **验证**: `cd extensions/personal-assistant && npx vitest run 2>&1 | tail -3`,应 `Test Files 7 passed (7)` + `Tests 143 passed (143)`(原 124 + 新 19)
  - **依赖**: 1.6

## 2. Webui Server: RPC response 透传到 pi stdin

- [x] 2.1 **写 `pool.sendExtensionUIResponse` 测试**
  - **文件**: `packages/webui/server/test/extension-ui-response.test.ts` (Create)
  - **内容**: 用 mock `spawnFn`,验证 `pool.sendExtensionUIResponse(sessionId, {id, value})` 写入 `{type:"extension_ui_response", id, value}\n` 到 mock proc.stdin.write;以及 `pool.sendExtensionUIResponse` 在 proc 不存在时 silent ignore
  - **验证**: `cd packages/webui/server && npx vitest run test/extension-ui-response.test.ts 2>&1 | tail -5`,初始 RED
  - **依赖**: 1.7

- [x] 2.2 **实现 `pool.sendExtensionUIResponse`**
  - **文件**: `packages/webui/server/session-pool.ts` (Modify — 在 `abort()` 之后新增 method)
  - **内容**: `sendExtensionUIResponse(sessionId: string, response: {id: string; value?: string; confirmed?: boolean; cancelled?: true}): void { const state = this.sessions.get(sessionId); if (!state || !state.proc) return; const msg = JSON.stringify({ type: "extension_ui_response", ...response }) + "\n"; state.proc.stdin?.write(msg); }`
  - **验证**: `cd packages/webui/server && npx vitest run test/extension-ui-response.test.ts 2>&1 | grep -E "passed|failed"` 应 "passed"
  - **依赖**: 2.1

- [x] 2.3 **写 ws handler 路由测试**
  - **文件**: `packages/webui/server/test/extension-ui-response.test.ts` (Modify — 追加 describe block)
  - **内容**: 用 `attachWsHandler` + 模拟 ws 客户端,测:(a) 收到 `extension_ui_response` 消息 → 调 `pool.sendExtensionUIResponse`;(b) 缺 active session → 收 error message;(c) 缺 id 字段 → 收 error message;(d) 端到端 round-trip(mock pool 接收到 `extension_ui_request` event + 模拟 ws 发 `extension_ui_response` 后 verify stdin 写入)
  - **验证**: 初始 `npx vitest run test/extension-ui-response.test.ts` 应有部分 failed(RED)
  - **依赖**: 2.2

- [x] 2.4 **扩展 ws handler ClientMessage union + case**
  - **文件**: `packages/webui/server/ws/handler.ts` (Modify — 2 处)
  - **内容**: (1) 在 `ClientMessage` type union 末尾追加 `ExtensionUIResponseMsg`(字段:type, id, value?, confirmed?, cancelled?);(2) 在 switch 里加 `case "extension_ui_response":` 分支,`const sessionId = state.activeSession; if (!sessionId) { sendError(ws, "No active session"); return; } pool.sendExtensionUIResponse(sessionId, { id: msg.id, value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled }); break;`
  - **验证**: `cd packages/webui/server && npx vitest run test/extension-ui-response.test.ts 2>&1 | tail -3`,应全 PASS
  - **依赖**: 2.3

- [x] 2.5 **回归全量 server 测试**
  - **文件**: —
  - **内容**: 跑全部 server 测试,确认无回归
  - **验证**: `cd packages/webui/server && npx vitest run 2>&1 | tail -3`,应 `Test Files 16 passed (16)` + `Tests 215 passed (215)`(原 209 + 新 6)
  - **依赖**: 2.4

## 3. Webui Client: 弹 modal + 聊天占位

- [x] 3.1 **写 `AskUserQuestionModal` 组件测试**
  - **文件**: `packages/webui/web/src/components/AskUserQuestionModal.test.tsx` (Create)
  - **内容**: 6 测试: 渲染 question + options(每项 label+description 两行)/ 单选点 option 触发 onSubmit(label) / multiSelect 勾 2 个 + 提交触发 onSubmit("label1, label2") / 点 Cancel 触发 onCancel / Esc 键触发 onCancel / 模态关闭时(返回 null)不渲染
  - **验证**: 初始 `cd packages/webui/web && npx vitest run src/components/AskUserQuestionModal.test.tsx 2>&1 | tail -3`,应有 failed
  - **依赖**: 2.5

- [x] 3.2 **实现 `AskUserQuestionModal` 组件**
  - **文件**: `packages/webui/web/src/components/AskUserQuestionModal.tsx` (Create)
  - **内容**: 仿 `NewSessionModal.tsx` 模板: backdrop (z-50, bg-black/50) + modal card (max-w-md, bg-white, rounded, shadow-xl);header 显示 question (text-base, font-semibold);body 列出 options(multiSelect 时每个 option 前面是 `<input type="checkbox">`,single 时是单选按钮),label + description 两行(label 粗体,description 灰色小字);footer "Cancel" + "Submit" 按钮(submit 多选时按勾选顺序拼接 `, `)
  - **验证**: `cd packages/webui/web && npx vitest run src/components/AskUserQuestionModal.test.tsx 2>&1 | grep "passed"`,全 6 个 PASS
  - **依赖**: 3.1

- [x] 3.3 **写 `AskUserQuestionProvider` 组件测试**
  - **文件**: `packages/webui/web/src/components/AskUserQuestionProvider.test.tsx` (Create)
  - **内容**: 4 测试: 收到 session_event 含 `extension_ui_request` method=select → 弹 modal 显示对应 question+options / 多 modal 排队:同时 push 2 个 request,只显示 stack 顶部,提交后自动显示下一个 + 顶部 pending count 数字正确 / 收到 method=input 也能弹(用 input() 路径)/ 收到非 session_event 消息不弹
  - **验证**: 初始 RED
  - **依赖**: 3.2

- [x] 3.4 **实现 `AskUserQuestionProvider`**
  - **文件**: `packages/webui/web/src/components/AskUserQuestionProvider.tsx` (Create)
  - **内容**: React Context Provider,**职责限定为 modal 弹窗**(不通知 ChatPage 插占位 — ChatPage 独立订阅 `session_event` 处理占位,见 3.7);内部用 `useRef<Map<string, ModalState[]>>(new Map())` 维护每 session 队列 + `useState<ModalState | null>` 当前显示 modal + `useState<Map<string, number>>` pending count;`useEffect` 通过 `ws.subscribe("session_event", handler)` 订阅事件,handler 检查 `event.type === "extension_ui_request" && (method === "select" || method === "input")` 时 push 到 queue + 调 `setActiveModalFromQueue()`;modal `onSubmit` 调 `ws.send({type: "extension_ui_response", id, value: <chosen label(s)>})` 然后弹下一个;modal `onCancel` 同样发 `extension_ui_response` 但带 `cancelled: true`;顶部条 `<PendingCountBar>` 显示 "⏳ 还有 N 个未答" (用 absolute positioned div,按 session 聚合 count)
  - **验证**: `cd packages/webui/web && npx vitest run src/components/AskUserQuestionProvider.test.tsx 2>&1 | grep "passed"`,全 4 PASS
  - **依赖**: 3.3

- [x] 3.5 **挂 `<AskUserQuestionProvider>` 到 AppShell**
  - **文件**: `packages/webui/web/src/components/AppShell.tsx` (Modify — 1 处包裹)
  - **内容**: 找到 return 语句的顶层容器 div,把它的 children 包在 `<AskUserQuestionProvider>` 里(只包 children,不改外层结构);确保 ws.subscribe 在 Provider 挂载时已 connect
  - **验证**: `cd packages/webui/web && npx vitest run src/components/AppShell.test.tsx 2>&1 | tail -3`,已有测试应继续 PASS(若 AppShell.test 存在)
  - **依赖**: 3.4

- [x] 3.6 **写 `ChatPage` 占位插入 + 替换测试**
  - **文件**: `packages/webui/web/src/pages/ChatPage.test.tsx` (Modify — 追加 describe block)
  - **内容**: 3 测试: 收到 `extension_ui_request` event → ChatPage 渲染的 messages 列表末尾出现 `<AskUserQuestionPending>` 占位(以 question 文本内容匹配) / 收到 `tool_execution_end` event 携带 toolName="ask_user_question" 的 result → 占位被替换为完整 ToolCall 组件(含 result 文本 "User selected: ...")/ 收到 `tool_execution_end` 但 toolName 不匹配 → 占位保留不变
  - **验证**: 初始 RED
  - **依赖**: 3.5

- [x] 3.7 **实现 `ChatPage` 占位插入 + 替换**
  - **文件**: `packages/webui/web/src/pages/ChatPage.tsx` (Modify — 加 useEffect)
  - **内容**: 加 `useEffect` 通过 `ws.subscribe("session_event", handler)` 监听事件;handler: (a) `event.type === "extension_ui_request" && (method === "select" || method === "input")` → 在 messages 数组末尾 push 一个临时 entry `{kind: "pending_question", id, question, options, multiSelect}`,UI render `AskUserQuestionPending` 组件;(b) `event.type === "tool_execution_end" && event.toolName === "ask_user_question"` → 找到对应 id 的 pending entry,把它替换为完整 tool call entry `{kind: "tool", name: "ask_user_question", args, result}`
  - **验证**: `cd packages/webui/web && npx vitest run src/pages/ChatPage.test.tsx 2>&1 | tail -3`,新加 3 个测试全 PASS
  - **依赖**: 3.6

- [x] 3.8 **实现 `AskUserQuestionPending` 组件**
  - **文件**: `packages/webui/web/src/components/AskUserQuestionPending.tsx` (Create)
  - **内容**: 简单展示组件:`<div data-pending-question-id={id} className="px-4 py-2 italic text-gray-500">⏳ Waiting for user to answer: {question}</div>`;按 ChatPage 的 ToolCall 渲染约定放在 messages 末尾
  - **验证**: 视觉检查 — `cd packages/webui/web && npx vitest run src/components/AskUserQuestionModal.test.tsx 2>&1 | tail -3`,无回归
  - **依赖**: 3.7

- [ ] 3.9 **回归全量 client 测试**
  - **文件**: —
  - **内容**: 跑全部 client 测试,确认无回归
  - **验证**: `cd packages/webui/web && npx vitest run 2>&1 | tail -3`,应 `Test Files 24 passed (24)` + `Tests 232 passed (232)`(原 219 + 新 13:6 modal + 4 provider + 3 chat page)
  - **依赖**: 3.8

## 4. 端到端 e2e 验证

- [ ] 4.1 **手动 e2e 验证(浏览器)**
  - **文件**: —
  - **内容**: Ctrl-C 重跑 dev webui server;在浏览器开 http://127.0.0.1:8742/session/<test session id>;输入 "Should I use [remote] tag in this file? Use ask_user_question to ask me.";确认 (a) 聊天页末尾出现"⏳ 等待用户回答"占位;(b) modal 弹出含 2-4 个 options;(c) 点选某项后占位被替换为 tool call + result "User selected: ...";(d) model 继续推演(用 pi 实际跑,看 session jsonl)
  - **验证**: 截图证明 (a)/(b)/(c)/(d) 都发生;session jsonl 不再出现 "Tool ask_user_question not found"
  - **依赖**: 3.9

- [ ] 4.2 **手动 e2e 验证(TUI 模式)**
  - **文件**: —
  - **内容**: `pi --mode interactive` 启动(用相同的 personal-assistant extension 目录);输入同样的 prompt;确认 (a) TUI 弹 ExtensionSelectorComponent 含 options;(b) ↑↓ + Enter 选完后返回 "User selected: ..."
  - **验证**: 截图/终端输出
  - **依赖**: 4.1

- [ ] 4.3 **手动 e2e 验证(5 分钟 timeout)**
  - **文件**: —
  - **内容**: 触发一次 ask_user_question,不回答,等 5 分钟(或临时把 TIMEOUT_MS 改成 10 秒 for testing);确认 (a) modal 自动关闭 / TUI 选择器消失;(b) 占位被替换为 "User did not respond within 5 minutes..." tool result;(c) model 继续推演
  - **验证**: 把 `ask_user_question.ts` 里的 `TIMEOUT_MS` 临时改成 `10*1000`,重启 dev webui 跑一遍,然后改回 `5*60*1000`
  - **依赖**: 4.2

## Verification

- [ ] 全量测试: `cd packages/webui/server && npx vitest run` + `cd packages/webui/web && npx vitest run` + `cd extensions/personal-assistant && npx vitest run`,应 215 + 232 + 143 = **590 tests pass**
- [ ] TypeScript 编译: `cd packages/coding-agent && npm run build:webui` 应 build 成功(用现有 lint:ci 跑也行)
- [ ] e2e: 浏览器 + TUI 双向跑通,no "Tool X not found" 出现
- [ ] git history: 4-7 个原子 commit,每个 commit message 描述清楚
