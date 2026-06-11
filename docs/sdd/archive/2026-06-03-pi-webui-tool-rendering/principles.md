# 原则: pi-webui-tool-rendering

## 新增原则 (本 change 独有)

1. **消息以 turn 为单位渲染** — 一个 user 消息 = 一气泡;一个 assistant 逻辑 turn (text + thinking + toolCalls + toolResults) = 一气泡,不按 JSONL entry 拆分。
2. **API 返回结构化 parts** — `Message.parts: Part[]` 数组,Part 是 discriminated union (text|thinking|toolCall|toolResult|image),不返回单 `content: string`。
3. **空 assistant 也要可见** — 只含 thinking + toolCall 没 text 的 assistant turn 仍然渲染(折叠的 thinking + tool cards),不消失为 12+ 连续空泡。
4. **Thinking 默认折叠** — 默认显示 `💭 Thinking [展开]` 按钮,展开后是 monospace 灰字,可二次折叠。
5. **Tool result 长度限高 5KB** — 默认显示前 5KB + "Show full output (N KB)" 展开按钮,避免超长输出撑爆页面。
6. **Image inline 渲染** — `image` part 走 `data:${mediaType};base64,${data}` data URL,`<img>` 元素 `max-h-96` (384px) 防止单图占满屏;多张图 flex-wrap。

## 已存在原则 (从 CLAUDE.md 继承,本 change 强化)

- Server is single source of truth: JSONL 决定显示内容,客户端不做推断
- 失败降级优于抛错:坏行 skip,未知 part type 降级为 text
- TypeScript 严格类型:5 种 Part 用 discriminated union,避免 `any`
- React key stable:每条 Message 的 `id` (从 JSONL 拿) 作 key,不重新生成
