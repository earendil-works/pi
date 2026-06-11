# 设计: pi-webui-tool-rendering

## Context

019e7188 session (用户 3676 messages) 在 webui 渲染:
- 1226 个 assistant 消息 (64%) 显空泡 (只有 thinking + toolCall 没 text)
- 1489 个 toolResult 整条过滤掉 (`readMessages` 只接 user/assistant/system role)
- 1510 个 thinking 块 + 1496 个 toolCall 块完全不可见

真实聊天**无法阅读**。修复需在 server (`readMessages`) 返结构化 parts,client (`Message` + `ChatMessages` + `ChatPage`) 渲染 5 种 part 类型。

## Goals / Non-Goals

**Goals** (from proposal)
1. 真实聊天可读 (thinking 可折叠 + tool call 显示 + tool result 限高)
2. 空 assistant 不显空泡
3. 一个 assistant turn = 一气泡
4. API 返 `Message[]` with `parts: Part[]` 结构化数组
5. TypeScript discriminated union 类型

**Non-Goals**
- Live streaming tool execution 渲染 (live `message_end` 已处理;这块是历史回放)
- Tool call 可点击交互
- Inline base64 image 渲染 (仅占位符)
- Virtualization (3664 messages 暂不虚拟滚动,DOM 渲染 < 2s 即可)

## Decisions

### D1. Server `readMessages` 返结构化 parts (不再单 `content: string`)

**Rationale:** 原 `Message.content: string` 是 1D 字符串,无法表达多 part。改为 `parts: Part[]` 数组,client 顺序渲染即可。`role` 保留 5 个值: `user | assistant | toolResult`。

**Alternatives considered:**
- A. 保留 `content: string` + 加 `parts?: Part[]` 字段 → 双轨,易不一致
- B. 完全弃 string → server 强返 parts ✅ 选这个
- C. 用 markdown 文本内嵌特殊标签 (e.g. `[[TOOL:name]]`) → 难 parse,类型不安全

### D2. Tool result 跟随其 tool call (按 JSONL 时间顺序,不嵌套)

**Rationale:** JSONL 自然顺序 = 时间顺序。client 把 assistant turn 内所有 parts 按数组顺序渲染,toolResult 自然出现在对应 toolCall 之后(同 turn)。不嵌套 ToolCallCard 内部,保持简单。

**Alternatives:**
- 嵌套 (ToolCallCard 包 ToolResultBlock) → 视觉更紧凑但 DOM 深
- 扁平顺序 ✅ 选这个,易理解易实现

### D3. `toolCallId` 用于匹配但 client 不强制配对

**Rationale:** 极端情况下 toolResult 可能没对应 toolCall (孤立,见 scenarios.md 边界)。client 仍渲染,样式标 "orphaned"。

### D4. Image content inline 渲染 (data URL)

**Rationale:** 用户明确需求:看图。32 张图 + 实测 read 工具返回 base64 → 直接 `<img src="data:image/png;base64,..." />` 渲染。性能:单图 < 1MB,32 张 ≈ 30MB,初次加载一次性 embed;后续滚动 smooth。

**Implementation:**
- `<ImageBlock part={p}>` 渲染 `<img src={`data:${p.mediaType};base64,${p.data}`} className="max-w-full max-h-96 rounded border" />`
- max-h-96 (24rem = 384px) 防止单图占满屏
- 保留 alt text "image"
- 多张图横向 flex-wrap

**Alternatives:**
- 缩略图 + click expand → 用户要的就是直接看
- 磁盘路径引用 (不 embed) → tool result 是 base64,无法走磁盘路径
- placeholder → 用户否决
- inline data URL ✅ 选这个

### D5. Thinking 默认折叠,无 lazy text preview

**Rationale:** `💭 Thinking [展开]` 按钮即可。展开后才渲染完整 monospace 文本(React conditional render → 折叠时 DOM 不含 50KB thinking,滚动流畅)。

### D6. Tool result 5KB 限高

**Rationale:** 实测 tool result 经常 10-100KB (read 图片 base64 等)。5KB 默认 + "Show full" 按钮是常用 UX。`truncateText(s, 5120)` helper。

### D7. 不改 pi core 的 JSONL schema

**Rationale:** Webui 是 reader 不改 writer。JSONL schema 由 pi core 决定 (`packages/coding-agent/src/core/session-manager.ts`)。webui server `readMessages` 适配现状即可。

### D8. 复用 pi core 编码 (`getDefaultSessionDir`) (承袭上一 quickfix)

不再自写 cwd encoding,用 pi core 的实现,避免目录互不可见。

## Architecture

### Data Model (TypeScript, in `packages/webui/web/src/lib/api.ts`)

```ts
// 5 种 part 类型,discriminated union by `type`
type TextPart = { type: "text"; text: string };
type ThinkingPart = { type: "thinking"; text: string };
type ToolCallPart = { type: "toolCall"; id: string; name: string; args: Record<string, unknown> };
type ToolResultPart = { type: "toolResult"; toolCallId: string; content: string; isError?: boolean };
type ImagePart = {
  type: "image";
  /** media type (e.g. "image/png", "image/jpeg", "image/gif") */
  mediaType: string;
  /** base64 encoded data (no data URL prefix) */
  data: string;
};

type Part = TextPart | ThinkingPart | ToolCallPart | ToolResultPart | ImagePart;

interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "toolResult";
  parts: Part[];
  timestamp: string;
}
```

### Server `readMessages` (in `packages/webui/server/routes/sessions.ts`)

```ts
// Old:
function readMessages(filePath, sessionId, limit, offset): Promise<Message[]>
// New: same signature, but Message.parts: Part[] instead of content: string
// Also: toolResult role (not filtered out)
```

Parse per JSONL line:
- `entry.type === "message"` + `entry.message.role === "user"` → 1 Message, parts = [TextPart{ text: extractText(entry.message.content) }]
- `entry.type === "message"` + `entry.message.role === "assistant"` → 1 Message, parts = entry.message.content.map(toPart) (each text/thinking/toolCall becomes its own Part)
- `entry.type === "message"` + `entry.message.role === "toolResult"` → 1 Message, 1 part = ToolResultPart
- `entry.type === "message"` + `entry.message.role === "system"` → 1 Message, parts = [TextPart]

每个 part 携带: text (直接),thinking (直接),toolCall (id + name + args),toolResult (toolCallId + content),image (placeholder)。

### React Components (in `packages/webui/web/src/components/ChatMessages.tsx`)

```tsx
<ChatMessages messages={messages} streamingContent={...} />
  └─ <MessageBubble message={msg} />   // 一个 Message = 一气泡
       ├─ <RoleHeader role={msg.role} timestamp={msg.timestamp} />
       └─ <PartList parts={msg.parts} />
            ├─ <ThinkingBlock part={p} />     // 可折叠
            ├─ <ToolCallCard part={p} />      // 工具名 + args 折叠 details
            ├─ <ToolResultBlock part={p} />   // 内容限高 5KB
            └─ <ImageBlock part={p} />          // inline base64 img 渲染
            └─ <TextBlock part={p} />          // 正常文本
```

`MessageBubble` 不变 (按 `msg.role` 选 user/assistant 样式);只改内部 children。

### ChatPage (in `packages/webui/web/src/pages/ChatPage.tsx`)

Live `message_end` handler 也需要构造 `Part[]`:

```ts
// Old:
const text = content.filter(c => c.type === "text").map(c => c.text ?? "").join("");
setMessages(prev => [...prev, { id, role, content: text, ... }]);
// New:
const parts = content.map(toPart);
setMessages(prev => [...prev, { id, role, parts, ... }]);
```

(toPart 复用 server `readMessages` 的 toPart 函数,通过共享 lib 或复制)

### Data Flow

```
JSONL file → readMessages (server) → Message[] w/ parts
  → /api/sessions/:id/messages  (JSON over HTTP)
  → ChatPage useEffect → setMessages
  → ChatMessages → MessageBubble × N
       → PartList (filter, map by type)
       → ThinkingBlock | ToolCallCard | ToolResultBlock | TextBlock | ImagePlaceholder
```

### Live streaming (during prompt)

`message_end` 已经处理 (05888e0c 那个 fix)。新增的 parts 模型兼容,因为新 prompt 的 `content: [{type:"text", text:"..."}]` 直接 map 成 `[{type:"text", text:"..."}]` part。

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| 3664 messages 全渲染 DOM 卡 | 折叠 thinking/tool 块默认不渲染内容,只渲染 header;用户展开才 mount 真实内容 |
| Tool result 超长 (100KB+) 撑爆 | 5KB 限高 + "Show full" 按钮 + max-height 滚动 |
| JSONL entry role 多变 (`toolResult` / `system` / 未来加新) | discriminated union + 未知 type 降级 TextPart(text="?") |
| TypeScript discriminated union 错误判别式遗漏 | 严格 union + 部分测试覆盖每种 part |
| React key 不稳导致重渲染 | 用 JSONL `id` 作 key(已存在) |
| 旧测试 (`message-content: string` 旧 API) 全断 | 同时更新 tests,新增 part 形状断言 |

## Testing Strategy

### Server (5+ tests in `sessions-routes.test.ts`)

- `readMessages` returns user message with single TextPart
- `readMessages` returns assistant message with [TextPart, ThinkingPart, ToolCallPart]
- `readMessages` returns toolResult as separate Message (not filtered)
- `readMessages` skips malformed JSON line, returns remaining
- `readMessages` returns empty parts array for unknown content type → [TextPart{text:"?"}]

### Web (3+ tests in `ChatMessages.test.tsx`)

- Empty assistant (only thinking + toolCall, no text) renders thinking + tool cards, NOT empty bubble
- Tool result > 5KB shows truncation with "Show full" button
- Thinking default collapsed, click expands to monospace text

### E2E

- Start server from `~/.pi/agent` cwd
- Open `http://127.0.0.1:8741/session/019e7188-274d-74c6-8dc3-4a6a62000fc1`
- Verify: thinking blocks (collapsed), tool calls (with names), tool results (truncated, with expand button), no 12+ empty bubbles
- Screenshot saved to `/tmp/webui-tool-rendering-e2e.png`

## Implementation Notes

### Order (for sdd:write_plan)

1. **server** - `readMessages` 返 `parts: Part[]`;新增 `Part` 类型,`toPart()` 转换函数
2. **server test** - 5+ 新测试
3. **web** - `api.ts` Message 类型加 `parts: Part[]`,`content: string` 移除或兼容 (mark deprecated)
4. **web** - `ChatMessages.tsx` 重构: PartList + 5 个 sub-component
5. **web** - `ChatPage.tsx` 适配新模型 (live `message_end` 改成构造 parts)
6. **web test** - 3+ 新测试
7. **build / check / E2E**

### Gotchas

- `readMessages` 旧测试断言 `content: "text"` 要全更新成 `parts: [{type:"text", text:"text"}]`
- pi core `message.content` 是 array of `{type, text}` 或 `{type, thinking}` 或 `{type, toolCall, name, args, id}`,注意 shape
- `toolResult.content` 也是 array of `{type:"text", text}` 或 `[{type:"image", data:"..."}]` (base64)
- React 折叠 state 用 `useState<Set<string>>(new Set())` 存展开的 message id
- Tool result 限高 helper: `truncate(s, 5120)` 函数,记得保留尾部内容
- 旧 web 代码 (api.ts `content: string`) 还有引用 → 改时全局 grep `message.content` 和 `Message.content`

## archived-with

- branch: `pi-webui-tool-rendering`
- archived: 2026-06-03
- reason: User-requested skip-review, scope met, supersedes by pi-webui-redesign
- bypass: review + release phases skipped per user instruction
