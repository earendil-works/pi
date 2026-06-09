# Design: add-ask-user-question-tool

## Context

**Current state**: pi-mono(earendil-works/pi v0.78.0)的 `agent-loop.ts:573` 在 `prepareToolCall` 阶段检查 `currentContext.tools?.find(t => t.name === toolCall.name)`,找不到时返回 `createErrorToolResult("Tool X not found")`。Stock pi 框架**只注册 7 个内置 tool**(bash / edit / find / grep / ls / read / write),personal-assistant extension 额外注册 todowrite / web_search / web_fetch,共 10 个。**`ask_user_question` 不在注册列表中**。

**Trigger event**: 用户在 webui 调 minimax provider(MiniMax-M3 模型,走 anthropic-messages 协议)时,model 凭训练数据中的 Claude Code 印象主动生成 `ask_user_question` tool call,实际参数还把 `options` 套了 `{item: {item: [...]}}` 嵌套(典型幻觉)。Session `~/.pi/agent/sessions/--home-qjh-.pi-agent--/2026-06-02T15-20-09.141Z_34022d26-...jsonl` 至少 3 次出现 "Tool ask_user_question not found",model 看到错误后**无脑重试**(第二次调用结构还更错),最终用户 abort。

**框架已有但 webui 端没接的能力**:
- `ExtensionUIContext.select()` / `.input()` / `.confirm()` 在 TUI 与 RPC 模式都已实现(RPC 模式:`rpc-mode.ts:135-149` 通过 `extension_ui_request` 出 / `extension_ui_response` 入 双向通信)
- `RpcExtensionUIRequest` / `RpcExtensionUIResponse` 类型在 `rpc-types.ts:213-258` 完整定义
- `createDialogPromise` 内部已支持 `signal` / `timeout` / 默认值 兜底
- Webui server 端 `session-pool.ts:251-282` 把 pi 子进程 stdout 的**所有事件**透传为 `pool.emit("event", ...)`,`ws/handler.ts:84-90` 再透传给订阅该 session 的 ws client — `extension_ui_request` 事件已经**无修改地**到达浏览器,**没人响应而已**
- Webui client 端 `lib/api.ts:234-334` 的 `WebSocketClient.send(message)` 已可发任意 message,只需扩 `ClientMessage` union 加 `extension_ui_response` 类型

**Why this change**:
- 修一个跨 server + extension + client 三层的高频用户痛点
- 框架已经做了 80% 工作,我们要做的只是把"extension 注册 tool" + "webui 端响应 RPC UI request" + "客户端弹 modal" 三段拼起来
- 设计决策都明确走 stock pi 原语,不修改上游 / 不 fork,保证可升级性

## Goals / Non-Goals

### Goals
- TUI + webui 双端跑通 `ask_user_question` tool,用户能看到选项 UI 并选完后让 model 继续推演
- 完全使用 stock pi 原语(`ctx.ui.select()` / `ctx.ui.input()` + RPC `extension_ui_request` / `extension_ui_response` 协议),**不修改 pi 上游**
- 接受 model 实际给的所有畸形参数形态(嵌套 wrapper / 缺字段 / 类型不严),在 execute 入口 normalize
- Timeout / Esc cancel / ws 断 / abort / 多 modal 排队 5 类异常场景全部走通
- 全量回归:209 server tests + 219 client tests + 8 personal-assistant tests 全部 pass

### Non-Goals
- 不修改 pi 上游 / 不提 PR / 不 fork
- 不支持 per-option description 完整双行渲染(TUI `select()` 只接 `string[]`,description 拼到 label 后面)
- TUI multi-select 不做勾选框 UI(走 `ctx.ui.input()` 让用户手输逗号分隔 label)
- 不修改 session jsonl 历史
- 不持久化未答 modal 状态(刷新丢失)
- 不做跨 session 同步(每个 web client tab 独立排队)

## Decisions

### 1. Tool schema 宽松 + execute 内 normalize
**Decision**: `ask_user_question` tool 的 `options` 字段用 `Type.Any()`(不约束类型),`question` / `header` / `multiSelect` 用宽松 schema(允许 undefined / 各种形态);所有真实校验在 `execute()` 入口的 `normalizeOptions(raw)` 函数里做。

**Rationale**: Pi 的 `prepareToolCall` 阶段(`agent-loop.ts:562`)会跑 TypeBox schema 校验,如果 schema 太严,model 实际给的 `{item: {item: [...]}}` 形态直接被 reject 走不到 execute 里的 normalize。实测 model 至少输出 3 种形态(标准 / `{item: [...]}` / `{item: {item: [...]}}`)+ 经常缺字段。**唯一安全做法是 schema 宽容到能接住,执行时严格**。

**Alternatives considered**:
- (a) 用 `Type.Union([Type.Array(...), Type.Object({item: ...}), Type.Object({item: Type.Object({item: ...})})])` — schema 严但三层嵌套会指数级膨胀,加新 wrapper 形态又得改 schema。**拒绝**
- (b) 不在 schema 里声明,tool 直接接收 `args: any` — 等同 (1) 但更不透明,**拒绝**
- (c) 接受当前实现,记录 known issue 等 pi 上游接住 — 用户痛点没解,**拒绝**

### 2. Stock pi 原语组合,不动上游
**Decision**: TUI 单选用 `ctx.ui.select()`;TUI multi-select 用 `ctx.ui.input()` + placeholder 提示;Webui 单选/多选都发 `extension_ui_request` event,client 弹对应 modal。

**Rationale**: 80% 现成,实现 3 文件 1 extension。修未来 pi 上游支持 `select_rich` 时,只需替换 `ask_user_question.ts` 内部 `ctx.ui.select` 调用,webui 协议层不动。

**Alternatives considered**:
- (a) Fork pi-mono 加新 RPC method `select_rich` 支持 `[{label, description}]` + TUI 加新组件 — 改 ~6 个 pi 上游文件,要保留 fork,**拒绝**
- (b) TUI 用 `ctx.ui.custom()` 写自己的 multi-select 组件 — `ctx.ui.custom` 在 TUI 可用但** RPC 模式是 no-op**,而 webui 走 RPC,两边写两套不划算,**拒绝**
- (c) 不区分 TUI/webui,所有模式都走 RPC(连 TUI 也走 RPC 协议)— 违反 pi 设计(TUI 优先),改 interactive-mode,**拒绝**

### 3. Webui 端按 session 隔离 modal 队列
**Decision**: Web client 维护 `Map<sessionId, ModalQueue>`,每个 sessionId 独立排队多个未答 modal。同一 tab 跨多个 session 时不互相干扰;不同 tab 各自维护自己的 queue(不跨 tab 同步)。

**Rationale**: 用户用 webui 多 tab 的场景罕见(主用法是单 session),跨 tab 同步增加复杂度收益小。**Session 隔离**能 cover 99% 场景且实现简单。

**Alternatives considered**:
- (a) 客户端只维护单个全局 modal 栈 — 多 session 场景下用户看不到是哪个 session 在问,**拒绝**
- (b) BrowserStorage 同步多 tab — 用 localStorage events 同步 modal 状态 — **过度设计**,99% 场景用不上,**拒绝**

### 4. 占位替换时机由 `tool_execution_end` event 驱动
**Decision**: Web client 收到 `extension_ui_request` 时插入占位;用户提交 `extension_ui_response` 后**不**立即替换占位;等到 pi 端 `tool_execution_end` 事件到达时(携带 `result: {content: [{type:"text", text:"User selected: ..."}]}`)一次性把占位替换为完整 tool call + tool result。

**Rationale**: 用户提交响应 → server 写 stdin → pi resolve `ctx.ui.select` → tool execute → pi emit `tool_execution_end` 是一个**链式异步**。如果用户提交后就立即替换占位(用 local 状态模拟 tool result),会出现"占位先变,tool result 后到"的中间态闪烁,看起来 broken。**统一靠 `tool_execution_end` 驱动替换**保证一致性。

**Alternatives considered**:
- (a) 提交后立即乐观替换 — 闪烁,**拒绝**
- (b) 不用占位,只靠 modal 关闭做反馈 — 用户看不到 chat 流里有这个 tool call,**拒绝**
- (c) 等 `message_end` 事件 — 时机太晚(message_end 是整个 turn 结束,中间多个 tool call 一起到),**拒绝**

### 5. `select()` timeout 走 pi 原生机制
**Decision**: TUI 与 webui 都通过 `ExtensionUIDialogOptions.timeout: 5*60*1000` 让 pi 自己 timeout。Pi 的 `createDialogPromise`(`rpc-mode.ts:90-129`)内部 `setTimeout` 触发,resolve `defaultValue`(这里是 `undefined`),select 返回 `undefined` 走 cancel 分支,tool 返回 "User did not respond..."。

**Rationale**: 框架已经做了。Webui 端不需要自己定时器,也不需要在 server 端做 cancel 消息,server 只管 stdin 写入与事件透传。Timeout 边界由 pi 唯一负责。

**Alternatives considered**:
- (a) Webui 端单独定时器,5 分钟没点就 server 主动发 cancel 消息 — 多此一举,pi 已经会 timeout,**拒绝**
- (b) 不设 timeout,modal 永远不关 — 死锁,**拒绝**

### 6. Options 数量严格 2-4
**Decision**: 校验 `options.length >= 2 && options.length <= 4`,不通过返回 isError。

**Rationale**: Claude Code 原生约束(Web 端官方规范);少于 2 个不是"选择题",多于 4 个体验差(model 真要给 10 个,说明 question 拆得不对)。

**Alternatives considered**:
- (a) 不设上限 — model 滥用,**拒绝**
- (b) 仅下限 ≥2 — 留 100 个 option 仍合法,**拒绝**

## Architecture

### Components

| Component | File | Role |
|-----------|------|------|
| `AskUserQuestionTool` (extension) | `extensions/personal-assistant/ask_user_question.ts` | 注册 `ask_user_question` tool,normalize 参数,调 `ctx.ui.select` / `ctx.ui.input` |
| `normalizeOptions()` | 同上 | 递归 unwrap `.item` 包装,取最内层 array |
| `registerAskUserQuestion(pi)` | 同上 | extension entry,挂上 `pi.registerTool(...)` |
| `session-pool.sendExtensionUIResponse` | `packages/webui/server/session-pool.ts` | 把 `extension_ui_response` 写入 pi 子进程 stdin |
| `ws/handler.ts` extension_ui_response case | `packages/webui/server/ws/handler.ts` | 解析 `ClientMessage` union 中 `extension_ui_response` 类型,call session-pool |
| `AskUserQuestionModal` (client) | `packages/webui/web/src/components/AskUserQuestionModal.tsx` | 弹 modal:question + options(checkboxes for multi) |
| `AskUserQuestionProvider` | `packages/webui/web/src/components/AskUserQuestionProvider.tsx` | 顶层 provider,订阅 `session_event` 中 `extension_ui_request`,维护 `Map<sessionId, ModalQueue>`,渲染 modal stack + 顶部 pending count |
| 占位插入/替换 | `packages/webui/web/src/pages/ChatPage.tsx` | 收到 `extension_ui_request` 时插 `AskUserQuestionPending` 组件;收到 `tool_execution_end` 时把它换成完整 tool call + result |

### Data flow

**TUI 模式**:

```
[model]  tool call: ask_user_question {question, header, options:[...], multiSelect:false}
   ↓
[agent-loop]  prepareToolCall 查 tool registry,找到 personal-assistant 那个,validate (宽松通过)
   ↓
[agent-loop]  executePreparedToolCall → tool.execute(args, ctx)
   ↓
[AskUserQuestionTool.execute]
   normalizeOptions(raw)  →  [{label, description}]  (unwrap 嵌套)
   label = description ? `${label} — ${description}` : label
   options = labels.map(format)
   ↓
[ctx.ui.select]  select(title, options, {timeout: 300000})
   ↓
[interactive-mode.showExtensionSelector]  渲染 ExtensionSelectorComponent
   ↓
[user]  ↑↓ + Enter
   ↓
[ExtensionSelectorComponent.onSelect]  →  resolve(option)
   ↓
[AskUserQuestionTool]  return {content: [{type:"text", text:"User selected: 加 [remote]"}], details: {selected: "加 [remote]"}}
   ↓
[model]  继续推演
```

**Webui 模式**:

```
[model]  tool call: ask_user_question {question, header, options:[...], multiSelect:false}
   ↓
[pi rpc-mode]  ctx.ui.select → createDialogPromise → stdout: {type:"extension_ui_request", id, method:"select", title, options, timeout:300000}
   ↓
[webui server session-pool.handleStdoutLine]  pool.emit("event", {sessionId, event})
   ↓
[ws/handler.ts:84]  ws.send({type:"session_event", sessionId, event: <extension_ui_request>})
   ↓
[browser WebSocketClient]  message dispatch → subscribers of "session_event"
   ↓
[AskUserQuestionProvider]  handler 收到:
   (a) if event.type === "extension_ui_request" && event.method === "select":
       - 在 <ChatPage> 的 messages list 末尾插入 placeholder <AskUserQuestionPending question={...} options={...}>
       - 把 {id, question, options, multiSelect, sessionId} 推入 ModalQueue[sessionId]
       - 顶部显示 "⏳ 还有 1 个未答"
   (b) <AskUserQuestionModal> 弹出当前 stack 顶部 request
   ↓
[user]  点 option 按钮
   ↓
[AskUserQuestionModal.onSubmit]  收集所选 label(s);调用 ws.send({type:"extension_ui_response", id, value: <label(s)>})
   ↓
[ws/handler.ts]  case "extension_ui_response" → pool.sendExtensionUIResponse(sessionId, {id, value})
   ↓
[session-pool.sendExtensionUIResponse]  proc.stdin.write(JSON.stringify({type:"extension_ui_response", id, value}) + "\n")
   ↓
[pi rpc-mode.pendingExtensionRequests]  resolve(response) → ctx.ui.select resolve
   ↓
[AskUserQuestionTool]  return {content: [...], details: ...}
   ↓
[pi]  emit tool_execution_end event: {type:"tool_execution_end", toolCallId, result: <tool result>}
   ↓
[webui server]  透传 session_event
   ↓
[browser]  ChatPage 收到 tool_execution_end 事件:
   - 在 messages 找到刚才的 placeholder
   - 用 <ToolCall toolName="ask_user_question" args={...} result={...}> 替换
   ↓
[model]  继续推演
```

### Interface definitions

**`extensions/personal-assistant/ask_user_question.ts`** 关键类型:

```typescript
// 宽松 schema 让任何 model 形态都能进 execute
const AskUserQuestionParams = Type.Object({
  question: Type.Optional(Type.String()),  // 缺省 → 报错
  header: Type.Optional(Type.String()),
  options: Type.Any(),  // 接受 array / {item: [...]} / {item: {item: [...]}} / undefined
  multiSelect: Type.Optional(Type.Boolean()),
});

interface NormalizedOption {
  label: string;
  description?: string;
}

function normalizeOptions(raw: unknown): NormalizedOption[] {
  // 递归 unwrap .item 包装
  let cur = raw;
  while (cur && typeof cur === "object" && "item" in (cur as any)) {
    cur = (cur as any).item;
  }
  if (!Array.isArray(cur)) throw new TypeError("options must be an array");
  return cur.map((o) => {
    if (typeof o !== "object" || o === null) throw new TypeError("option must be an object");
    const label = (o as any).label;
    if (typeof label !== "string") throw new TypeError("option.label must be a string");
    return { label, description: typeof (o as any).description === "string" ? (o as any).description : undefined };
  });
}

function formatOptionForSelect(o: NormalizedOption): string {
  return o.description ? `${o.label} — ${o.description}` : o.label;
}

const TIMEOUT_MS = 5 * 60 * 1000;

export function registerAskUserQuestion(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: "Ask the user a question with 2-4 options. Single-select by default. Returns the user's choice as a string (or comma-separated string for multiSelect).",
    promptSnippet: "Ask the user a clarifying question with 2-4 options.",
    parameters: AskUserQuestionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { question, header, options: rawOptions, multiSelect = false } = params as any;
        if (typeof question !== "string" || !question) {
          return { content: [{ type: "text", text: "ask_user_question requires a non-empty 'question' field" }], details: { error: "missing_question" }, isError: true };
        }
        const options = normalizeOptions(rawOptions);
        if (options.length < 2 || options.length > 4) {
          return { content: [{ type: "text", text: "ask_user_question requires 2-4 options (Claude Code spec); got " + options.length }], details: { error: "bad_options_count" }, isError: true };
        }
        if (multiSelect && options.length < 2) {
          return { content: [{ type: "text", text: "multiSelect requires at least 2 options" }], details: { error: "multiSelect_needs_2" }, isError: true };
        }
        const title = header ? `${header}\n${question}` : question;
        const labels = options.map(formatOptionForSelect);
        let chosen: string | undefined;
        if (multiSelect) {
          // TUI: input() with placeholder listing options
          chosen = await ctx.ui.input(title, `${labels.join(" | ")} (comma-separated)`, { timeout: TIMEOUT_MS });
        } else {
          chosen = await ctx.ui.select(title, labels, { timeout: TIMEOUT_MS });
        }
        if (chosen === undefined) {
          return { content: [{ type: "text", text: "User cancelled the question" }], details: { cancelled: true } };
        }
        return { content: [{ type: "text", text: `User selected: ${chosen}` }], details: { selected: chosen, options, multiSelect } };
      } catch (err) {
        return { content: [{ type: "text", text: `ask_user_question error: ${(err as Error).message}` }], details: { error: "exception" }, isError: true };
      }
    },
  });
}
```

**`session-pool.ts` 新方法**:

```typescript
sendExtensionUIResponse(sessionId: string, response: { id: string; value?: string; confirmed?: boolean; cancelled?: true }): void {
  const state = this.sessions.get(sessionId);
  if (!state || !state.proc) return;
  const msg = JSON.stringify({ type: "extension_ui_response", ...response }) + "\n";
  state.proc.stdin?.write(msg);
}
```

**`ws/handler.ts` 扩展 ClientMessage**:

```typescript
interface ExtensionUIResponseMsg {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}
type ClientMessage = SubscribeMsg | UnsubscribeMsg | PromptMsg | AbortMsg | SwitchSessionMsg | ExtensionUIResponseMsg;
// switch case 加:
case "extension_ui_response": {
  const sessionId = state.activeSession;
  if (!sessionId) { sendError(ws, "No active session"); return; }
  pool.sendExtensionUIResponse(sessionId, { id: msg.id, value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled });
  break;
}
```

**Client side**:`AskUserQuestionProvider` 简化接口

```typescript
interface ExtensionUIRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "input" | "confirm" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  // ... 其他字段
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  timeout?: number;
}

interface ModalState {
  id: string;
  method: "select" | "input";
  title: string;
  options: NormalizedOption[];  // [{label, description}]
  multiSelect: boolean;
  sessionId: string;
  toolCallId: string;  // 用于占位关联
}

// Provider:
const queue = useRef<Map<string, ModalState[]>>(new Map());
const [activeModal, setActiveModal] = useState<ModalState | null>(null);
const [pendingCounts, setPendingCounts] = useState<Map<string, number>>(new Map());

ws.subscribe("session_event", (msg) => {
  if (msg.event?.type === "extension_ui_request" && (msg.event.method === "select" || msg.event.method === "input")) {
    const modal = parseRequest(msg.event, msg.sessionId);
    queue.current.get(msg.sessionId)?.push(modal);
    updatePendingCounts();
    setActiveModalFromQueue();
    // 同时通知 ChatPage 插占位
  }
});
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Model 调 `ask_user_question` 时 pi 处于非 interactive / 非 rpc 模式(print / batch)— `ctx.ui.select` 在 print 模式也走 noOp,**返回 undefined** | tool execute 检测到 chosen === undefined 立即返回 cancel 结果,不卡死 |
| Web client refresh 时未答 modal 丢失,pi 端 5 分钟 timeout 内 model 死等 | 设计权衡;若用户觉得长,可降低默认 TIMEOUT_MS 到 2 分钟。**当前 5 分钟是保守值** |
| `select_rich` / multi-select 真实 UI 需要 fork pi 上游 | 接受 trade-off;在 CLAUDE.md 加原则"extension UI 走 stock 原语组合,不去 fork 上游" |
| TUI 模式下 `ctx.ui.select` 没法显示 description(单行),model 写的丰富信息被压扁 | 接受;description 拼到 label 后,用 `truncateToWidth` 控制行宽 |
| Webui 端 modal 提交后到 `tool_execution_end` 事件到达,中间有 ~100-500ms 延迟(网络 + pi 推演) | 占位显示"⏳ 等待 pi 处理..."过渡文本,`tool_execution_end` 到达后无缝替换;用户感知不到 |
| `extension_ui_request` 事件积压(网络慢 / 客户端 bug)导致 modal 弹出延迟 | Server 端 `ws.send` 是 fire-and-forget;不阻塞 pi;客户端订阅者队列是 client state,丢失只影响 UX |
| `ClientMessage` union 扩展破坏现有 ws client 兼容性 | 老 client 发 `extension_ui_response` 类型不识别,server `default` 分支返回 `Unknown message type` 错误,但**老 client 不会发**这种消息(老 client 不知道这个类型),实际无影响 |

## Testing Strategy

### Unit tests (`extensions/personal-assistant/test/ask-user-question.test.ts`)

- `normalizeOptions` 5 种形态解析:
  - 标准 `[{label, description}]` → 1:1 通过
  - `{item: [{label, description}]}` → unwrap 1 层
  - `{item: {item: [{label, description}]}}` → unwrap 2 层
  - `{item: {item: {item: [{label, description}]}}}` → unwrap 3 层
  - `[]` 空数组 → 抛 TypeError
  - `{item: "not an array"}` → 抛 TypeError
  - `null` / `undefined` → 抛 TypeError
  - 缺 description 字段 → undefined
- `formatOptionForSelect`:
  - 仅 label → label 原文
  - label + description → `"label — description"`
- `execute()`(mock ctx.ui):
  - happy path(单选):ctx.ui.select 返回 "加 [remote]" → tool result `User selected: 加 [remote]`
  - happy path(multi):ctx.ui.input 返回 "加 [remote], 不加 [remote]" → tool result `User selected: 加 [remote], 不加 [remote]`
  - cancel:ctx.ui.select 返回 undefined → `User cancelled the question`
  - timeout:timeout 后 ctx.ui.select resolve 为 undefined(同 cancel)→ `User cancelled the question`
  - options 数 = 1 → isError "requires 2-4 options"
  - options 数 = 5 → isError
  - options 数 = 4 → 合法
  - multiSelect + 1 option → isError
  - 缺 question → isError
  - 嵌套畸形 `{item: {item: [...]}}` 走通
- tool registration:`pi.registerTool` 被以 `name: "ask_user_question"` 调一次
- 5 分钟 timeout:`{timeout: 300000}` 传给 `ctx.ui.select` / `ctx.ui.input`

### Integration tests (`packages/webui/server/test/extension-ui-response.test.ts`)

- `pool.sendExtensionUIResponse` 写入正确格式的 JSONL 到 mock spawnFn 的 stdin
- ws handler 收到 `extension_ui_response` 消息 → 调 `pool.sendExtensionUIResponse`
- ws handler 收到 `extension_ui_response` 但没 active session → `sendError(ws, "No active session")`
- ws handler 收到非法 `extension_ui_response`(缺 id)→ `sendError`
- session-pool 收到 stdin 写入失败(proc 已 exit)→ silent ignore(不 crash)
- 端到端 mock:模拟 `extension_ui_request` event 透传 + 模拟 `extension_ui_response` 写入 stdin 的 round-trip

### Component tests (`packages/webui/web/src/components/AskUserQuestionModal.test.tsx`)

- 渲染 question + options(label + description 两行)
- 单选:点 option → onSubmit 被以所选 label 调一次
- multiSelect:点 2 个 checkbox + 提交 → onSubmit 被以 `"label1, label2"` 调一次
- 取消:点 Cancel → onCancel 被调
- Esc 键 → onCancel
- 多 modal 排队:Queue 中有 2 个,只显示 stack 顶部;提交后自动显示下一个
- pending count 顶部显示正确数字
- ws send 用正确的 `extension_ui_response` 格式({type, id, value})

### Boundary tests (webui client 集成)

- ws 断时收到 `extension_ui_request` → server 检测 ws.readyState !== OPEN → 自动 cancel
- 用户点 Stop abort 按钮时 modal 还开着 → modal 关闭 + 占位变 cancel result
- 同时订阅 2 个 session tab → modal 按 sessionId 独立排队
- dev mode HMR 干扰 → HMR 客户端收到非 `session_event` 消息,不弹 modal

### 回归

- 全跑 `npx vitest run` 在 `packages/webui/server` `packages/webui/web` `extensions/personal-assistant` 三个目录下,确认 209 + 219 + 8 + 新增 11 个测试全部 pass

## Implementation Notes

### 依赖关系(实现顺序)

1. **extension 内部先打通**(测试独立):
   - 写 `ask_user_question.ts` + `test/ask-user-question.test.ts`
   - 在 `index.ts` 加 `registerAskUserQuestion(pi)`
   - 跑 `cd extensions/personal-assistant && npx vitest run` → 8 + 11 = 19 tests pass
2. **server 端连 stdin**:
   - `session-pool.ts` 加 `sendExtensionUIResponse` 方法
   - `ws/handler.ts` 扩 `ClientMessage` union + case
   - 写 `packages/webui/server/test/extension-ui-response.test.ts` 6 tests
   - 跑 209 + 6 = 215 pass
3. **client 端弹 modal**:
   - 写 `AskUserQuestionModal.tsx` + `AskUserQuestionProvider.tsx`
   - 在 `AppShell.tsx`(或 main entry)挂 `<AskUserQuestionProvider>`
   - 在 `ChatPage.tsx` 监听 `extension_ui_request` 插占位;`tool_execution_end` 替换
   - 写 7 + 3 = 10 tests
   - 跑 219 + 10 = 229 pass
4. **手动 e2e 验证**:
   - 重启 dev webui,`pi` 子进程通过 `~/.pi/agent/extensions/personal-assistant` symlink 自动加载新 extension
   - 在 webui 发一条"我要加 [remote] 标签吗"的问题,确认:
     - 聊天页面出现"⏳ 等待用户回答"占位
     - modal 弹出
     - 点选项后占位被替换为 tool call + result
     - model 继续推演

### Gotchas

- **extension autoload**: 新加的 `ask_user_question.ts` 通过 `extensions/personal-assistant/index.ts` 调 `registerAskUserQuestion(pi)` 即可被自动发现。`~/.pi/agent/extensions/personal-assistant` 是 symlink 指向 `extensions/personal-assistant/`,pi 启动时扫描这个目录
- **TypeBox schema 要 `Type.Any()` for options**: 这是**最常错的点**。如果 schema 写 `Type.Array(...)`,model 给的 `{item: [...]}` 会被 agent-loop 阶段直接 reject
- **`ctx.ui.select()` 在 print 模式是 no-op**(`rpc-mode.ts` 之外): 我们在 tool execute 检测到 chosen === undefined 时返回 cancel,**不报错**,因为 print 模式本来就不该询问
- **`ws/handler.ts` ClientMessage union 顺序**: 把 `ExtensionUIResponseMsg` 放最后,符合"新加项放最后"惯例,git diff 友好
- **session-pool 写入失败**: `state.proc.stdin?.write(msg)`,`?.` 处理 proc 已退;不 throw,UI 端会从下次 prompt 拿不到响应兜底
- **TUI select 不支持 description**: 这是 stock pi 限制,接受 trade-off。description 拼到 label 后面,行宽 truncate
- **Webui modal vs TUI select 在 multiSelect 上的体验差**: 接受 trade-off(已在 proposals 里说明)
- **不要 persist 未答 modal**: 见非目标。Refresh 走"cancel + model 自行决定"
- **回归测试基线**: server 209 / client 219 / ext 8。新增 11 + 6 + 10 = 27,共 463

### 升级路径(为未来变化打基础)

- **如果 pi 上游未来加 `select_rich` 支持 description**: 只改 `ask_user_question.ts` 内部 `ctx.ui.select` → `ctx.ui.selectRich({label, description}[])`。webui 协议层 + client 都不动
- **如果 pi 上游未来加 `select_multi` 支持真勾选框**: 改 `ask_user_question.ts` 的 multiSelect 分支,client 弹 checkbox 的逻辑保留(本来就是 webui 自己实现的)
- **如果 `extension_ui_request` 协议扩展加新 method**: `AskUserQuestionProvider` 的 `if (msg.event.method === "select" || "input")` switch 加 case 即可
