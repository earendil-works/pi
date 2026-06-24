# Tasks: webui-collapsible-thinking-step

> **Design:** design.md | **Base:** 6965fe18aa66a786dd1700c87aa299f2f52466c5

**Goal:** Wrap each webui assistant turn that contains thinking or tool calls in a collapsible step with a status + duration header (● Executing / ✓ Completed), so long CoT and tool chains stop dominating the chat stream.

**Architecture:** Pure client-side rendering change. `MessageParts.tsx` grows an internal `<StepHeader>` component and a new outer wrapping branch triggered by `parts.some(p => p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult" || p.type === "image")`. `isStreaming?: boolean` and `timestamp?: string` props are forwarded `ChatPage → MessageBubble → MessageParts`. `isLastMessageStreaming = isThinking && lastMessage?.role === "assistant"`. Header live-ticks duration via `setInterval(1s) + useReducer`. User collapse override stored as `useState<boolean|null>` inside `StepHeader`; `open = userOverride ?? isStreaming`.

**Tech Stack:** React 18 (useState/useReducer/useEffect), lucide-react (existing icons — actually we use Unicode `●` / `✓` per design), Tailwind utility classes, Vitest + @testing-library/react (jsdom env).

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs that must complete first
- **TDD flow per task**: write failing test → run (FAIL) → implement → run (PASS) → commit. Implementer must NOT batch "write all tests first" or "implement all then test".
- **Tests live in `packages/webui/web/`, NOT `packages/webui/`** — the top-level `packages/webui/vitest.config.ts` only includes server-side `test/**` paths. The web vitest config is `packages/webui/web/vitest.config.ts` (jsdom env, includes web tests).

## 1. StepHeader 内部组件 + MessageParts 接口扩展

- [x] 1.1 **StepHeader 组件写测试 (RED)**
  - **文件**: `packages/webui/web/src/components/message/MessageParts.test.tsx` (Modify)
  - **内容**: 在文件末尾新增 `describe("StepHeader (via MessageParts)", ...)` 块,5 个 case:
    1. 纯 text parts `[{type:"text", text:"hi"}]` → query `getByText(/Execut|Completed/i)` 为 null (无 step header)
    2. 含 thinking `[{type:"thinking", text:"x"}, {type:"text", text:"y"}]`, props `isStreaming=true` → query `getByText(/Executing/i)` 存在 + `getByText("y")` 可见
    3. 含 toolCall `[{type:"toolCall", id:"t1", name:"read", args:{path:"/x"}}]`, props `isStreaming=false` → query `getByText(/Completed/i)` 存在 + `queryByText("/x")` 为 null (body 折叠)
    4. case 3 的 step header button 点击 → `queryByText("/x")` 变为非 null (body 展开)
    5. **transition test**: `parts = [{type:"thinking", text:"x"}, {type:"text", text:"y"}]`, render with `isStreaming=true` → `getByText("y")` 可见; 用 `rerender(<MessageParts ... isStreaming={false} ... />)` 同一实例重渲染 → `queryByText("y")` 变为 null (body 自动折叠)
  - **验证**: `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` 5 个新 case 全 FAIL
  - **依赖**: 无

- [x] 1.2 **StepHeader 组件 + MessageParts 改 chunks (GREEN)**
  - **文件**: `packages/webui/web/src/components/message/MessageParts.tsx` (Modify)
  - **内容**:
    1. imports 加 `useEffect, useReducer, useState` (已有 useState)
    2. 在 `MessageParts` 之前定义 `interface StepHeaderProps { isStreaming: boolean; startedAt: Date }` 和 `function StepHeader({ isStreaming, startedAt })`:
       - `useState<boolean | null>(null)` 命名 `userOverride`
       - `useReducer((x:number)=>x+1, 0)` 命名 `[, forceTick]`
       - `useEffect` 注册 `setInterval(forceTick, 1000)`, cleanup `clearInterval`
       - `const open = userOverride ?? isStreaming`
       - `const seconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))`
       - `const icon = isStreaming ? "●" : "✓"`, `const iconColor = isStreaming ? "text-blue-500" : "text-green-600"`, `const statusText = isStreaming ? "Executing" : "Completed"`, `const chevron = open ? "▼" : "▲"`
       - 返回 `<button onClick={() => setUserOverride(!open)} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-gray-50 rounded">`, children 顺序: `<span className={font-bold ${iconColor}}>{icon}</span>` `<span className="font-medium">{statusText}</span>` `<span className="text-gray-500">({seconds}s)</span>` `<span className="ml-auto text-gray-400">{chevron}</span>`
    3. 改 `MessageParts` 签名: 加 `isStreaming?: boolean = false` 和 `timestamp?: string`
    4. 在 `MessageParts` 内部: 开头加 `const hasStepContent = parts.some(p => p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult" || p.type === "image")`,原 `if (parts.length === 0) return ...` 保留
    5. 在 `hasStepContent` 之后: `if (!hasStepContent) { return <div className="flex flex-col gap-2">{parts.map((p, i) => p.type === "text" ? <TextItem key={i} part={p} /> : null)}</div> }` (原 path,纯 text 不裹)
    6. 在 `hasStepContent` 之后但在 chunks 之前: `const open = ... // 必须从 StepHeader 实例外取 — 实际把 open 计算下移到 StepHeader 内,MessageParts 只包外层 div,StepHeader 自己管 toggle`
    7. MessageParts 函数体重构:
       - 计算 `const startedAt = timestamp ? new Date(timestamp) : new Date()`
       - 把原 chunks 算法封装到内部函数 `renderChunks(parts, cardStates, onCardSubmit, onCardCancel): JSX.Element` (无 `open` 参数,只是把所有 chunks 渲染出来)
       - return: `<div className="rounded-lg border border-gray-200 bg-white px-3 py-2 flex flex-col gap-2"><StepHeader isStreaming={isStreaming} startedAt={startedAt} />{open ? <div className="flex flex-col gap-2 border-t border-gray-100 pt-2">{renderChunks(...)}</div> : null}</div>`,其中 `open` 必须**从 StepHeader 内部 state 取**,但 React 父组件读不到子组件 state — 改方案:把 `open` 状态提升到 `MessageParts` 内,`StepHeader` 改为受控组件接 `open` + `onToggle` props。**实现要求**: `MessageParts` 内 `const [userOverride, setUserOverride] = useState<boolean | null>(null)` + `const open = userOverride ?? isStreaming` + 把 `open` / `setUserOverride` 当 props 传给受控 `StepHeader`
  - **验证**: `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` 4 个新 case + 现有 21 case 全 PASS
  - **依赖**: 1.1
  - **前置阅读**: design.md 第 124-168 行 (StepHeader 关键代码 + chunks 新算法)

## 2. MessageBubble prop 透传

- [x] 2.1 **MessageBubble 写测试 (RED)**
  - **文件**: `packages/webui/web/src/components/message/MessageBubble.test.tsx` (Modify)
  - **内容**: 新增 case "forwards isStreaming prop to MessageParts":
    - mock MessageParts with `vi.mock("../message/MessageParts", () => ({ MessageParts: (props: any) => <div data-testid="mp" data-streaming={props.isStreaming} data-ts={props.timestamp} /> }))`
    - render `<MessageBubble message={{...assistant message with thinking+text, timestamp:"2026-06-24T15:00:00.000Z"}} isStreaming={true} />`
    - expect `getByTestId("mp").getAttribute("data-streaming") === "true"` AND `getByTestId("mp").getAttribute("data-ts") === "2026-06-24T15:00:00.000Z"`
  - **验证**: `cd packages/webui/web && npx vitest --run src/components/message/MessageBubble.test.tsx` 新 case FAIL
  - **依赖**: 1.2 (需要 MessageParts 已经接 isStreaming/timestamp props)

- [x] 2.2 **MessageBubble 加 prop 转发 (GREEN)**
  - **文件**: `packages/webui/web/src/components/message/MessageBubble.tsx` (Modify)
  - **内容**:
    1. `MessageBubbleProps` interface 加 `isStreaming?: boolean`
    2. 函数签名加 `isStreaming = false`
    3. 找到 `<MessageParts ... />` 调用处,加 `isStreaming={isStreaming}` 和 `timestamp={message.timestamp}` 两个 props
  - **验证**: `cd packages/webui/web && npx vitest --run src/components/message/MessageBubble.test.tsx` 新 case + 现有 case 全 PASS
  - **依赖**: 2.1

## 3. ChatPage 算 isLastMessageStreaming + 透传

- [x] 3.1 **ChatPage 写测试 (RED): isLastMessageStreaming 只传给最后一条 message**
  - **文件**: `packages/webui/web/src/pages/ChatPage.test.tsx` (Modify)
  - **内容**: 找文件中已存在的多 message 测试 pattern(看 `ChatPage.test.tsx` 第 1021 行附近的 `// The msg container is the ChatMessages component's outer div,` 注释),在文件末尾新增 case "isLastMessageStreaming only applies to the last message":
    - mock `useIsThinking` (或 `isThinking` 来源 hook) 返回 `true`
    - 渲染 ChatPage with `messages = [user, assistant(older), user, assistant(latest, 含 thinking)]` (lastMessage 是 assistant)
    - query 4 个 MessageBubble (或用 data-testid): 验证 latest assistant bubble 的 `data-is-streaming === "true"`, 验证 older assistant bubble 的 `data-is-streaming === "false"` (或 attribute 不存在)
    - 若无现成 data-testid: 在 MessageBubble 渲染 div 加 `data-testid="bubble" data-is-streaming={String(isStreaming)}` 属性(这只是 dev-only test attribute,可保留)
  - **验证**: `cd packages/webui/web && npx vitest --run src/pages/ChatPage.test.tsx` 新 case FAIL (因为 ChatPage 还没算 isLastMessageStreaming,所有 bubble 的 data-is-streaming 都会是 undefined)
  - **依赖**: 2.2

- [x] 3.2 **ChatPage 算 isLastMessageStreaming (GREEN)**
  - **文件**: `packages/webui/web/src/pages/ChatPage.tsx` (Modify)
  - **内容**:
    1. 在 `ChatPage` 函数体内、`return (...)` 之前(在 `messages` 定义附近),加:
       `const lastMessage = messages[messages.length - 1];`
       `const isLastMessageStreaming = isThinking && lastMessage?.role === "assistant";`
    2. 找到 `<ChatMessages messages={messages} ... />` 调用, 加 `isLastMessageStreaming={isLastMessageStreaming}` prop
    3. 找到 `ChatMessages` 内部的 `MessageBubble` 调用,加 `isStreaming={isLastMessageStreaming}` prop
  - **验证**: `cd packages/webui/web && npx vitest --run src/pages/ChatPage.test.tsx` 新 case + 现有 case 全 PASS
  - **依赖**: 3.1
  - **前置阅读**: ChatPage.tsx 第 600-650 行 (确认 ChatMessages 调用位置)

## 3.5 MessageParts: force-open step body when an active AskUserQuestionCard is present

> **Why added (after 3.2):** discovered 9 ChatPage Card integration regressions in 4.1. Root cause: when agent pauses on `ask_user_question`, `isThinking=false` → `isStreaming=false` → step body collapses → card invisible. Fix: when any toolCall part has a `cardStates` entry, force `open=true` so the active card is always visible. This is a 1-line change but warrants its own TDD step.

- [x] 3.3 **MessageParts 写测试 (RED): force-open step when active card exists**
  - **文件**: `packages/webui/web/src/components/message/MessageParts.test.tsx` (Modify)
  - **内容**: 在 `describe("StepHeader (via MessageParts)", ...)` 块末尾新增 case "force-opens the body when an active AskUserQuestionCard is present":
    - `parts = [{type:"toolCall", id:"tc1", name:"ask_user_question", args:{}}]`
    - `cardStates = new Map([["tc1", {question:"Color?", options:[...], multiSelect:false, status:"active"}]])`
    - `isStreaming = false` (simulating "agent paused waiting for user input")
    - expect `screen.getByText("Color?")` 可见 (card rendered AND step body open)
  - **验证**: `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` 新 case FAIL (因为当前实现没考虑 cardStates)
  - **依赖**: 3.2

- [x] 3.4 **MessageParts force-open 实现 (GREEN)**
  - **文件**: `packages/webui/web/src/components/message/MessageParts.tsx` (Modify)
  - **内容**:
    1. 在 `MessageParts` 函数体内、`hasStepContent` 计算之后加:
       `const hasActiveCard = parts.some(p => p.type === "toolCall" && cardStates?.has(p.id));`
    2. 改 `open` 计算: `const open = hasActiveCard ? true : (userOverride ?? isStreaming);`
    3. **不要** 把 force-open 用 `userOverride` 状态保存;每次 render 重新计算 (card active → open, card not active → 跟随 userOverride/isStreaming)
  - **验证**:
    - `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` (21 PASS: 19 现有 + 2 新 — stepHeader case 1 仍是纯 text guard, 新的 force-open case + 已有的 1 个 streaming case)
    - `cd packages/webui/web && npx vitest --run src/pages/ChatPage.test.tsx` (9 个 Card integration 失败变 PASS,1 个 isLastMessageStreaming test 仍 PASS)
  - **依赖**: 3.3
  - **前置阅读**: AskUserQuestionCard 用法见 MessageParts.tsx 第 230-249 行;CardState interface 见 AskUserQuestionCard.tsx

- [x] 3.5 **spec + design 更新**
  - **文件**:
    - `docs/sdd/changes/webui-collapsible-thinking-step/specs/chat-message-rendering/spec.md` (Modify)
    - `docs/sdd/changes/webui-collapsible-thinking-step/design.md` (Modify)
  - **内容**:
    1. spec.md: 在 "Requirement: Step Body Collapsible" 下新增 1 个 scenario (force-open when card active)
    2. design.md: Decision 3 末尾补 1 句: "若 parts 里有 toolCall 出现在 cardStates map 中,force open=true,覆盖 userOverride 行为"
  - **验证**: 重新读 spec.md / design.md,确认新 scenario + 决策记录在位
  - **依赖**: 3.4

## 4. 最终验证

- [x] 4.1 **全量 webui 测试**
  - **文件**: 无
  - **内容**: 跑全量 webui test
  - **验证**: `cd packages/webui/web && npx vitest --run` 期望 `Tests 269+ passed` (原 265 + 4 新 MessageParts + 1 新 MessageBubble - 老覆盖 case 调整)
  - **依赖**: 3.1

- [x] 4.2 **lint + type check**
  - **文件**: 无
  - **内容**: 跑 biome + tsgo
  - **验证**: `npm run check` 期望 exit 0 (pre-existing LSP warnings 不算)
  - **依赖**: 4.1

- [x] 4.3 **手动浏览器 smoke test**
  - **文件**: 无
  - **内容**: 浏览器开 `http://127.0.0.1:8741`,用 minimax(M3) 走一次完整 turn(含 thinking + tool + final text),确认:
    1. 推理中 step 展开,header 显示 `● Executing (Xs) ▼` (Xs 1s tick)
    2. done 后 step 自动折叠,header 变 `✓ Completed (Xs) ▲`
    3. 点击 header 展开/折叠切换正常
    4. 纯 text turn 不出现 step header
  - **验证**: tmux attach pi-web server 看到 4 步行为都符合
  - **依赖**: 4.1

## Verification
- [x] 全量测试: `cd packages/webui/web && npx vitest --run`
- [x] Lint: `npm run check` (exit 0)
- [x] Manual smoke: tmux attach pi-web 浏览器手测 4 case
