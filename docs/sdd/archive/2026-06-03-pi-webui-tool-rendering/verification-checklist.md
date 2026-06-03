# Verification Checklist: pi-webui-tool-rendering

> 生成时间: 2026-06-02 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | User 消息正常显示 (parts 单 TextPart) | scenarios.md 正常 #1 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "user message with text returns single TextPart"` | PASS | [ ] |
| S2 | Assistant 纯文本消息 (parts 单 TextPart) | scenarios.md 正常 #2 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "assistant with thinking + toolCall + text"` | PASS | [ ] |
| S3 | Assistant turn 多 parts 顺序保留 | scenarios.md 正常 #3 | unit-test | 同上 (验证 parts 顺序: ThinkingPart → ToolCallPart → TextPart) | PASS | [ ] |
| S4 | Thinking 默认折叠 | scenarios.md 正常 #4 | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/components/MessageParts.test.tsx -t "thinking default closed"` | PASS | [ ] |
| S5 | 点击 expand 显 thinking | scenarios.md 正常 #4 | unit-test | 同上 -t "click expand shows thinking text" | PASS | [ ] |
| S6 | ToolCallCard 显名字+arg 摘要 | scenarios.md 正常 #5 | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/components/MessageParts.test.tsx -t "ToolCallCard shows name and arg summary"` | PASS | [ ] |
| S7 | ToolResult 5KB 限高 | scenarios.md 正常 #6 | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/components/MessageParts.test.tsx -t "tool result > 5KB shows truncation"` | PASS | [ ] |
| S8 | ToolResult 跟随 ToolCall | scenarios.md 正常 #7 | unit-test | 集成测试: ChatMessages 渲染顺序 | PASS | [ ] |
| S9 | 空 assistant turn 不显空泡 | scenarios.md 异常 #1 | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/components/MessageParts.test.tsx -t "empty assistant (only thinking + toolCall"` | PASS | [ ] |
| S10 | toolResult role 不过滤 | scenarios.md 异常 #2 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "toolResult is not filtered"` | PASS | [ ] |
| S11 | 坏 JSON 行不挂 | scenarios.md 异常 #3 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "malformed JSON line is skipped"` | PASS | [ ] |
| S12 | 未知 part type 降级 | scenarios.md 异常 #4 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "unknown content type falls back"` | PASS | [ ] |
| S13 | 极长 thinking 不爆 DOM | scenarios.md 异常 #5 | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/components/MessageParts.test.tsx -t "Very long thinking stays performant"` | PASS | [ ] |
| S14 | 0 messages EmptyState | scenarios.md 边界 #1 | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/components/ChatMessages.test.tsx -t "0 messages shows EmptyState"` | PASS | [ ] |
| S15 | 3664 messages session 渲染流畅 | scenarios.md 边界 #4 | chrome-devtools | `cd ~/.pi/agent && nohup ./node_modules/.bin/tsx server/index.ts &` 然后 chrome-devtools 打开 `/session/019e7188`, 测 scroll 流畅 (60fps) | 3600+ messages 渲染,scroll 流畅 | [ ] |
| S16 | Image inline 渲染 | scenarios.md 边界 (image 1) | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/components/MessageParts.test.tsx -t "Image renders inline"` | PASS, `<img src="data:..." max-h-96>` in DOM | [ ] |
| S17 | 多 image 横向 flex | scenarios.md 边界 (image 2) | unit-test | 同上 -t "Multiple images lay out horizontally" | PASS | [ ] |
| S18 | 大图不撑爆 | scenarios.md 边界 (image 3) | unit-test | 同上 -t "Very large image is constrained" | PASS | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Structured Message Parts (5 种 Part discriminated union) | spec.md ADDED #1 | code-review | `packages/webui/web/src/lib/api.ts` 定义 5 个 Part type + Part union;`Message.parts: Part[]` 替换 `content: string`;`Message.role` 加 `"toolResult"` | [ ] |
| R2 | readMessages 返 parts: Part[] | spec.md ADDED #1 | code-review | `packages/webui/server/routes/sessions.ts:readMessages` 返 `parts: Part[]`,role whitelist 移除 (允许 toolResult) | [ ] |
| R3 | Thinking Block is Collapsible | spec.md ADDED #2 | code-review | `packages/webui/web/src/components/MessageParts.tsx:ThinkingBlock` 默认 `expanded=false`,useState toggle,展开后 `<pre>` 渲染 | [ ] |
| R4 | Tool Call Card | spec.md ADDED #3 | code-review | `MessageParts.tsx:ToolCallCard` 显 `🔧 {name}` + args 摘要;`<details>` 完整 JSON | [ ] |
| R5 | Tool Result Block with Size Limit | spec.md ADDED #4 | code-review | `MessageParts.tsx:ToolResultBlock` `max-h-96 overflow-auto`;>5120 截断 + "Show full" 按钮 toggle | [ ] |
| R6 | Image Block Inline Renders | spec.md ADDED #5 | code-review | `MessageParts.tsx:ImageBlock` `<img src="data:${mediaType};base64,${data}" max-h-96>`,多 image flex-wrap 父容器 | [ ] |
| R7 | One Bubble Per Turn | spec.md ADDED #6 | code-review | `ChatMessages.tsx:MessageBubble` 渲染整个 `message.parts` (一个 turn 一气泡),空 `parts` 显 `(empty turn)` placeholder | [ ] |
| R8 | Live streaming 构造 parts | spec.md MODIFIED #1 | code-review | `packages/webui/web/src/pages/ChatPage.tsx:message_end handler` 用 `toPart(c)` helper 构造 parts | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S18) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R8) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果
- [ ] 125 个 server 单元测试全过 (120 旧 + 5 新)
- [ ] 42 个 web 单元测试全过 (39 旧 + 3 新)
- [ ] vite build 成功
- [ ] `npm run check` 干净 (无新增错误)
- [ ] E2E: 019e7188 session 在浏览器显 thinking + tool cards + images,无 12+ 连续空泡
- [ ] E2E 截图保存到 /tmp/webui-tool-rendering-e2e.png
