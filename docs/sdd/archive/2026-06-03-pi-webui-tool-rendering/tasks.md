# Tasks: pi-webui-tool-rendering

> **Design:** design.md | **Base:** c817eb85ba2a914b1818ba308ccecfd16eed6a13

**Goal:** Render real LLM chat (thinking + tool calls + tool results + images) in webui so the 019e7188 session with 3664 messages becomes readable instead of 1226 empty "Assistant" bubbles.

**Architecture:** Server `readMessages` returns structured `Message[]` with `parts: Part[]` discriminated union (5 types: text/thinking/toolCall/toolResult/image). Client `MessageBubble` renders parts as collapsible ThinkingBlock, ToolCallCard (with name + args), ToolResultBlock (5KB truncated), inline ImageBlock (data URL). One assistant turn = one bubble.

**Tech Stack:** TypeScript strict, React 19, Tailwind v4, vitest 2.1.8, vitest jsdom, vitest-define-config

## Notes

- **`依赖`** = execution order (consumed by `sdd:develop` DAG for parallel dispatch)
- `无` — no dependency | `1.1, 2.3` — comma-separated task IDs that must complete first
- **`前置阅读`** = context only (not execution order)

## 1. Server: structured `Message.parts`

- [x] 1.1 **Define `Part` discriminated union + `toPart()` helper in shared lib**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Create types in this single place; server imports from web? No — better: create `packages/webui/shared/message-types.ts` OR put types only in `web/src/lib/api.ts` and server mirrors them. Decision: server defines its own type with same shape — see task 1.2.)
  - **内容**: Add to `api.ts`: `TextPart = { type:"text"; text:string }`, `ThinkingPart = { type:"thinking"; text:string }`, `ToolCallPart = { type:"toolCall"; id:string; name:string; args:Record<string, unknown> }`, `ToolResultPart = { type:"toolResult"; toolCallId:string; content:string; isError?:boolean }`, `ImagePart = { type:"image"; mediaType:string; data:string }`, `type Part = TextPart|ThinkingPart|ToolCallPart|ToolResultPart|ImagePart`. Update `Message` interface: replace `content: string` with `parts: Part[]`, change `role: "user"|"assistant"|"system"` to `role: "user"|"assistant"|"toolResult"`.
  - **验证**: `cd packages/webui/web && npx tsc --noEmit src/lib/api.ts` (no compile errors after the change)
  - **依赖**: 无

- [x] 1.2 **Update `readMessages` in server to return `parts: Part[]`**
  - **文件**: `packages/webui/server/routes/sessions.ts` (Modify — `readMessages` function at line ~306, also the calling site in the GET handler)
  - **内容**: Replace the function body. New logic: parse each JSONL line, accept `entry.message.role` of `user|assistant|toolResult|system`. For each entry, build a `Message` with `parts: Part[]`: `user` → `[TextPart{text: extractText(inner.content)}]`; `assistant` → `inner.content.map(c => toPart(c))` where `toPart` maps each content item: `text→TextPart`, `thinking→ThinkingPart`, `toolCall→ToolCallPart{id,name,args}`, `image→ImagePart{mediaType,data}` (use `c.mediaType` if present else guess from `c.data` prefix or default `"image/png"`); `toolResult` → `[ToolResultPart{toolCallId: msg.toolCallId, content: extractText(msg.content), isError: false}]`; `system` → `[TextPart]`. Define local `interface Part` in this file with same shape as task 1.1. Define local `interface Message` with same shape. Skip malformed lines. Drop the role whitelist filter (allow `toolResult`). 
  - **验证**: `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "GET /api/sessions/:id/messages"` (existing tests should pass with updated assertions)
  - **依赖**: 1.1

- [x] 1.3 **Add 5+ new server tests for `readMessages` parts**
  - **文件**: `packages/webui/server/test/sessions-routes.test.ts` (Modify — add to the existing describe block for "GET /api/sessions/:id/messages")
  - **内容**: Add tests: (1) "user message with text returns single TextPart" — write a JSONL with one user message, assert response has `parts: [{type:"text",text:"..."}]`. (2) "assistant with thinking + toolCall + text returns multiple parts in order" — JSONL has assistant with content array of `[thinking, toolCall, text]`, assert response has 3 parts in same order. (3) "toolResult is not filtered" — JSONL has a toolResult entry, assert response includes it with `role: "toolResult"` and one `ToolResultPart`. (4) "malformed JSON line is skipped, remaining returned" — JSONL with one garbage line and two valid lines, assert response has 2 messages, no error. (5) "unknown content type falls back to TextPart with '?'" — content item with `type: "futureType"`, assert response has TextPart with text `"?"`.
  - **验证**: `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts` (5 new + existing tests pass)
  - **依赖**: 1.2

## 2. Web: render 5 part types

- [x] 2.1 **Add `Part` sub-components (ThinkingBlock / ToolCallCard / ToolResultBlock / TextBlock / ImageBlock)**
  - **文件**: `packages/webui/web/src/components/MessageParts.tsx` (Create)
  - **内容**: Create a new file `MessageParts.tsx` with 5 sub-components. `ThinkingBlock({ part }: { part: ThinkingPart })` — collapsible, default closed; header `💭 Thinking [展开]`, when expanded shows `<pre className="bg-gray-50 p-2 rounded text-xs font-mono whitespace-pre-wrap">`. `ToolCallCard({ part }: { part: ToolCallPart })` — header `🔧 {part.name}` with args preview (one line: `key=value, key=value`); `<details>` with full args JSON. `ToolResultBlock({ part }: { part: ToolResultPart })` — header `↪ result`; content max-h-96 with overflow-auto; if content > 5120 chars, truncate + "Show full output (N KB)" button that toggles. `TextBlock({ part }: { part: TextPart })` — `<p className="text-sm whitespace-pre-wrap break-words">{part.text}</p>`. `ImageBlock({ part }: { part: ImagePart })` — `<img src={`data:${part.mediaType};base64,${part.data}`} className="max-w-full max-h-96 rounded border my-2" alt="image" />`; if multiple images in same container, parent uses `flex flex-wrap gap-2`. Export `MessageParts({ parts, defaultExpandAll = false }: { parts: Part[]; defaultExpandAll?: boolean })` that maps parts to sub-components; groups consecutive `TextPart`s into one div, but each `ToolCallPart`/`ToolResultPart`/`ThinkingPart`/`ImagePart` as its own div.
  - **验证**: `cd packages/webui/web && npx tsc --noEmit src/components/MessageParts.tsx` (no compile errors)
  - **依赖**: 1.1

- [x] 2.2 **Refactor `ChatMessages.tsx` to use `MessageParts`**
  - **文件**: `packages/webui/web/src/components/ChatMessages.tsx` (Modify)
  - **内容**: Change `MessageBubble` to render `<MessageParts parts={message.parts} />` instead of `<div>{message.content}</div>`. Keep `StreamingBubble` for live streaming (it uses `streamingContent: string` prop separately). Add a small change: if `message.parts` is empty, render `<div className="text-xs text-gray-400 italic">(empty turn)</div>` (defensive — should not happen with new readMessages, but be safe). Keep role-based icon (You/Assistant) and timestamp rendering.
  - **验证**: `cd packages/webui/web && timeout 30 npx vitest run src/components/ChatMessages.test.tsx` (existing tests pass; if no test file yet, create a minimal one)
  - **依赖**: 2.1

- [x] 2.3 **Update `ChatPage` live `message_end` handler to construct `parts`**
  - **文件**: `packages/webui/web/src/pages/ChatPage.tsx` (Modify — find the `e.event.type === "message_end"` block)
  - **内容**: In the live handler, replace the `const text = content.filter(c => c.type === "text").map(c => c.text ?? "").join("")` line with a function that maps each content item to a Part. Define a small inline helper or import from `api.ts`: `function toPart(c: any): Part { switch(c.type) { case "text": return {type:"text", text:c.text ?? ""}; case "thinking": return {type:"thinking", text:c.thinking ?? ""}; case "toolCall": return {type:"toolCall", id:c.id ?? "", name:c.name ?? "", args:c.args ?? {}}; case "image": return {type:"image", mediaType:c.mediaType ?? "image/png", data:c.data ?? ""}; default: return {type:"text", text:"?"}; } }`. Then `const parts = content.map(toPart);` and set `setMessages(prev => [...prev, { id, role, parts, ... }])`.
  - **验证**: `cd packages/webui/web && timeout 30 npx vitest run src/pages/ChatPage.test.tsx` (existing 8 tests pass; one may need update if it asserts `content: string`)
  - **依赖**: 1.1, 2.2

- [x] 2.4 **Add 3+ web tests for new rendering behavior**
  - **文件**: `packages/webui/web/src/components/ChatMessages.test.tsx` (Create) OR `packages/webui/web/src/components/MessageParts.test.tsx` (Create)
  - **内容**: (1) "empty assistant (only thinking + toolCall, no text) renders thinking + tool cards, NOT empty bubble" — render `<ChatMessages messages={[emptyAssistantMsg]} />`, assert it contains the thinking header text and the tool call name, not the `(empty turn)` placeholder. (2) "tool result > 5KB shows truncation with Show full button" — render `<MessageParts parts={[{type:"toolResult", toolCallId:"x", content:"x".repeat(6000)}]} />`, assert the truncated content shows and "Show full" button is present. (3) "thinking default collapsed, click expands" — render thinking part, assert pre is NOT in DOM; fire click on expand button, assert pre IS in DOM.
  - **验证**: `cd packages/webui/web && timeout 30 npx vitest run src/components` (3 new tests pass; existing 39 pass)
  - **依赖**: 2.1, 2.2

## 3. E2E verification on real session

- [x] 3.1 **Build + serve + E2E verify 019e7188 session shows thinking/tool/images**
  - **文件**: 无 (just run commands)
  - **内容**: Build web (`npm run build` in `packages/webui/web`), start server from `~/.pi/agent` cwd using the working command: `cd /home/qjh/.pi/agent && nohup /home/qjh/workspace/personal/pi/packages/webui/node_modules/.bin/tsx --tsconfig /home/qjh/workspace/personal/pi/packages/webui/tsconfig.json /home/qjh/workspace/personal/pi/packages/webui/server/index.ts > /tmp/webui-tool.log 2>&1 & disown`. Wait 5s. Verify with curl: `curl -s http://127.0.0.1:8741/api/sessions/019e7188-274d-74c6-8dc3-4a6a62000fc1/messages | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{len(d)} messages'); types={}; [types.update({p['type']: types.get(p['type'],0)+1}) for m in d for p in m.get('parts',[])]; print(f'parts: {types}')"` — expect 3664 messages, parts to include `text`, `thinking`, `toolCall`, `toolResult`, `image`. Open `http://127.0.0.1:8741/session/019e7188-274d-74c6-8dc3-4a6a62000fc1` in browser. Verify with chrome-devtools snapshot: should see thinking blocks (collapsed), tool call cards (with names like "read", "bash", "satellite_remote_exec"), tool result blocks, and inline images (32 of them). No 12+ empty "Assistant" bubbles. Take screenshot to `/tmp/webui-tool-rendering-e2e.png`.
  - **验证**: All 4 part types appear in API response; browser shows thinking + tool cards + images; no empty Assistant bubbles
  - **依赖**: 1.3, 2.4

## Verification

- [x] 全量 server tests: `cd packages/webui && timeout 60 npx vitest run server/test` — expect 125+ pass (was 120, +5 new in 1.3)
- [x] 全量 web tests: `cd packages/webui/web && timeout 30 npx vitest run` — expect 42+ pass (was 39, +3 new in 2.4)
- [x] Build: `cd packages/webui/web && timeout 60 npm run build` — clean
- [x] Type check: `cd /home/qjh/workspace/personal/pi && timeout 120 npm run check` — no NEW errors (pre-existing 10 pa/sqlite/satellite errors OK)
- [x] E2E: API returns all 4 part types for 019e7188; browser shows no empty bubbles

## 4. UI polish: match reference design

User feedback: current per-tool/per-result cards with raw JSON are too noisy. Reference (e.g. Claude.ai / ChatGPT) groups tool calls per turn, uses clean icons, hides details behind a click, and only shows a friendly summary (first line + length) by default.

- [x] 4.1 **Rewrite `MessageParts.tsx` to match reference design**
  - **文件**: `packages/webui/web/src/components/MessageParts.tsx` (Rewrite)
  - **内容**: Replace per-part cards with this structure for an assistant turn (parts in order):
    1. **Thinking header** (if any thinking parts): single `• 思考` button at the top, collapsed by default; click expands to monospace text
    2. **ToolGroup** (if any toolCall/toolResult/image parts): one container card with subtle border, contains a list of items separated by a faint dotted line:
       - Each **tool call item**: `Icon  name  friendly-summary  chevron ▸` on one line
         - `friendly-summary` = first arg (e.g. `read` → `/path/to/file`, `bash` → first line, `web_search` → query)
         - Default: collapsed (only summary visible)
         - Click item: expand to show full args JSON in monospace box
       - Each **tool result** (paired to its tool call by `toolCallId`, in JSONL order): right under the tool call item, indented
         - `↪ friendly-summary` on one line; first line non-empty + `(N.N KB)` size badge
         - Click: expand to show full content
       - Each **image**: inline `<img>` (data URL, max-h-96), grouped horizontally
    3. **Final text** (if any TextPart): plain `<p>` at the bottom, separated by a small gap
  - **Icons**: use lucide-react icons (already a dep): `Brain` (thinking), `Wrench` (tool call generic), `Database` (read), `Terminal` (bash), `Globe` (web_search/web_fetch), `ListTodo` (todowrite), `FolderOpen` (read file), `Image` (image part). Pick the best fit per `toolCall.name`. Unknown tools fall back to `Wrench`.
  - **Summary helpers** (top of file):
    - `summarizeToolCall(part: ToolCallPart): string` — extract `args.path`/`args.query`/`args.command` first arg
    - `summarizeToolResult(content: string): { text: string; bytes: number }` — first non-empty line trimmed to 80 chars + total byte count
  - **No emoji**: replace 🔧/💭/↪/📷 with proper lucide icons
  - **Empty parts**: keep `(empty turn)` placeholder (defensive)
  - **Single tailwind class palette**: `bg-white` for assistant bubble, `bg-blue-50` for user bubble, gray-500 text for metadata, `border-gray-200` for cards, `border-l-2 border-gray-200` for tool item separators
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "MessageParts\.tsx" | head -5` (no errors)
  - **依赖**: 2.1

- [x] 4.2 **Update existing 8 `MessageParts.test.tsx` to match new rendering**
  - **文件**: `packages/webui/web/src/components/MessageParts.test.tsx` (Modify)
  - **内容**: Existing tests assert things like "thinking (show)" button text. Update to match new text (e.g. "思考"). Also: tool result test asserted `screen.getByText(/Show full output/)`; new design uses `(N.N KB)` size badge instead of "Show full output" header — update assertion to `screen.getByText(/\d+\.\d KB/)`. The expand/collapse flow stays but button text changes; rename selectors. Add 2 new tests: (a) "tool calls grouped into single ToolGroup card" — render 2 toolCall + 2 toolResult parts; assert they are in the same outer container, not separate cards. (b) "image is inline" — render ImagePart, assert `<img>` with data URL is in DOM.
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui/web && timeout 30 npx vitest run src/components/MessageParts.test.tsx` (8+ tests pass, all updated)
  - **依赖**: 4.1

- [x] 4.3 **E2E: rebuild + screenshot 019e7188 + compare to old screenshot**
  - **文件**: 无 (just run commands)
  - **内容**: `cd /home/qjh/workspace/personal/pi/packages/webui/web && npm run build`; kill old server, restart from `~/.pi/agent` cwd; use `chrome-devtools_navigate_page` to open `http://127.0.0.1:8741/session/019e7188-274d-74c6-8dc3-4a6a62000fc1`, `chrome-devtools_take_snapshot` to capture accessibility tree (verify presence of "思考" + "Database"/"Terminal" icons + size badge text like `5.0 KB`), `chrome-devtools_take_screenshot` to save to `/tmp/webui-tool-rendering-e2e-v2.png` for user comparison.
  - **验证**: chrome-devtools snapshot shows: thinking collapsed with "思考" text, tool calls grouped, no raw JSON visible by default, size badge text present in tool result summary
  - **依赖**: 4.2

