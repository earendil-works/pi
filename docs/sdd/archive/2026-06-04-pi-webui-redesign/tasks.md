# Tasks: pi-webui-redesign

> **Design:** design.md | **Base:** 0cb8d79c5cd7873c557a143c42d8367edb8fc86f

**Goal:** 重做 pi-webui 的左栏 (品牌+5 icon+搜索+会话列表) 和聊天顶栏 (标题+模型+Clear),新增图片输入/查看、token 统计、lightbox,沿用 Hermes v0.34.3 视觉风格。

**Architecture:** 全新 `AppShell.tsx` 接管 2-col 布局,Sidebar 拆 5 子组件,Topbar 拆 3 子组件,消息三段式 (header/body/footer),图片输入 state 放在 ChatPage,lightbox 用 React Portal。Server 端: `GET /api/models` 解析 models.json,`POST /api/sessions` 调 `pi --new-session` (失败降级 UUID),`GET /api/sessions/:id/messages` 提取 usage,WS `prompt.images` 升级为 `{mediaType, data}[]`。

**Tech Stack:** React 18 + TypeScript + Tailwind, lucide-react, Vite, Express, vitest + @testing-library/react, pi RPC (JSONL).

## Notes

- **`依赖`** = 执行顺序 (sdd:develop DAG 用)
- **`前置阅读`** = 仅上下文 (不阻塞并行)
- 每个任务 TDD: 写失败测试 → 跑确认 FAIL → 实现 → 跑确认 PASS → 提交

## 1. Server 基础 Server 基础

- [x] 1.1 **`parseModelsJson` 工具 + 单测**
  - **文件**: `packages/webui/server/lib/parse-models.ts` (Create), `packages/webui/server/lib/parse-models.test.ts` (Create)
  - **内容**: 实现 `parseModelsJson(jsonStr: string): {providers: Array<{name: string; models: Array<{id: string; name: string}>}>}`,读 `~/.pi/agent/models.json`,处理 3 种 schema: `{providers:[{name,models}]}` / `{[name]: models[]}` / 数组。处理空文件/格式错误返回 `{providers: []}`。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/lib/parse-models.test.ts` (5+ 测试, 包含正常/异常/边界)
  - **依赖**: 无

- [x] 1.2 **`GET /api/models` 路由 + 集成测试**
  - **文件**: `packages/webui/server/routes/models.ts` (Create), `packages/webui/server/routes/models.test.ts` (Create)
  - **内容**: 新路由 `app.get("/api/models", (_req, res) => ...)`,调 `parseModelsJson(fs.readFileSync("~/.pi/agent/models.json","utf-8"))`,返回 JSON。`app.locals.homeDir` 注入 home 路径(测试用 stub)。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/routes/models.test.ts` (3+ 测试: 正常 models.json、空文件、文件不存在)
  - **依赖**: 1.1

- [x] 1.3 **`extractUsage` 工具 + 单测**
  - **文件**: `packages/webui/server/lib/usage-parser.ts` (Create), `packages/webui/server/lib/usage-parser.test.ts` (Create)
  - **内容**: 实现 `extractUsage(jsonlLine: string): {input: number; output: number} | undefined`,解析 `entry.message.usage.{input,output}`,处理缺失字段、字符串数字、负数返回 undefined。**只返回数字** ,不接触 parts。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/lib/usage-parser.test.ts` (6+ 测试: 正常/缺失 usage/字符串/0/负数/坏 JSON)
  - **依赖**: 无

- [x] 1.4 **`readMessages` 返回 usage 字段 + 测试**
  - **文件**: `packages/webui/server/routes/sessions.ts` (Modify, readMessages 函数), `packages/webui/server/test/sessions-routes.test.ts` (Modify, 加 2 测试)
  - **内容**: 修改 readMessages, 对 assistant 消息构造 `usage?: {input, output}` 字段 (从 `extractUsage(line)`)。`Message` interface 扩展 `usage?: {input: number; output: number}`。返回 message 对象顺序不变。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/test/sessions-routes.test.ts` (现有测试 + 2 新测试, 验证含 usage 的 message 含 usage 字段, 不含 usage 的不渲染该字段)
  - **依赖**: 1.3

- [x] 1.5 **`spawnPiNewSession` + UUID 降级 + 测试**
  - **文件**: `packages/webui/server/lib/new-session.ts` (Create), `packages/webui/server/lib/new-session.test.ts` (Create)
  - **内容**: 实现 `spawnPiNewSession(cwd: string, opts: {timeoutMs?: number}): Promise<{sessionId: string, sessionFile: string}>`,5s 超时内 spawn `pi --mode rpc --new-session --cwd <cwd>`,监听 stdout 等 `{type:"session_created", sessionId}`.失败 (timeout / non-zero exit) 降级: 调 `randomUUID()`,写空 header JSONL 到 `<sessionsDir>/<iso>_<uuid>.jsonl`。`console.warn` 打印 fallback 原因。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/lib/new-session.test.ts` (5+ 测试: pi 成功/pi 超时/pi 错误输出/UUID 降级/超时回退时序)
  - **依赖**: 无

- [x] 1.6 **`POST /api/sessions` 用 `spawnPiNewSession`**
  - **文件**: `packages/webui/server/routes/sessions.ts` (Modify, POST handler), `packages/webui/server/test/sessions-routes.test.ts` (Modify, 加 2 测试)
  - **内容**: 替换现有 POST /api/sessions 的 `randomUUID()` 路径,调 `spawnPiNewSession(cwd)`,返回 `{id, sessionFile}`。失败时仍走 UUID fallback 路径(由 spawnPiNewSession 内部处理)。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/test/sessions-routes.test.ts` (现有测试通过 + 2 新测试: 调用了 spawnPiNewSession, 失败时降级)
  - **依赖**: 1.5

- [x] 1.7 **WS `prompt.images` 验证升级 + 测试**
  - **文件**: `packages/webui/server/ws/handler.ts` (Modify, prompt case), `packages/webui/server/test/ws-handler.test.ts` (Modify, 加 4 测试)
  - **内容**: WS handler 接收 `images?: Array<{mediaType: string; data: string}>`,验证: 数组长度 ≤ 4,每图 data 长度 ≤ 5MB (5 * 1024 * 1024),总 base64 长度 ≤ 20MB,mediaType 在白名单 `image/png|image/jpeg|image/gif|image/webp`。验证失败 `sendError`。验证通过 `pool.prompt(sessionId, text, images)`。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/test/ws-handler.test.ts` (现有测试 + 4 新测试: 正常 / > 4 张 / 单图 > 5MB / 非法 MIME)
  - **依赖**: 无

- [x] 1.8 **`session-pool.prompt` 透传 `content[]` 给 pi**
  - **文件**: `packages/webui/server/session-pool.ts` (Modify, prompt 方法), `packages/webui/server/test/session-pool.test.ts` (Modify, 加 1 测试)
  - **内容**: `prompt(sessionId, text, images?: Array<{mediaType, data}>)` 写 stdin: `{type:"prompt", sessionId, content:[{type:"text", text}, ...images.map(i => ({type:"image", mediaType: i.mediaType, data: i.data}))], message: text}`。向后兼容: 若 images 为空仍发 message 字段 (老 pi 也接受)。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/test/session-pool.test.ts` (现有测试 + 1 新测试: 验证 stdin JSON 含 content 数组含 text+image)
  - **依赖**: 1.7

## 2. Web 工具 + 原子组件 Web 工具 + 原子组件 (大部分可并行)

- [x] 2.0 **从归档导入 `MessageParts.tsx` + `MessageParts.test.tsx`**
  - **文件**: `packages/webui/web/src/components/message/MessageParts.tsx` (Create, copy from archive), `packages/webui/web/src/components/message/MessageParts.test.tsx` (Create, copy from archive)
  - **内容**: 从 `docs/sdd/archive/2026-06-03-pi-webui-tool-rendering/` 找到 MessageParts 源文件 (5 Part 类型 + ToolGroup 容器 + lucide 图标 + summarizeToolCall/Result + formatBytes), 复制到 `packages/webui/web/src/components/message/MessageParts.tsx`。同时复制对应的 `MessageParts.test.tsx` (12 测试)。修复 import 路径 (从 `../lib/api` → 实际位置)。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/message/MessageParts.test.tsx` (12 测试全 pass)
  - **依赖**: 无
  - **前置阅读**: `docs/sdd/archive/2026-06-03-pi-webui-tool-rendering/proposal.md` (了解 MessageParts 设计)

- [x] 2.1 **`formatToken` + `formatRelativeTime` 工具 + 单测**
  - **文件**: `packages/webui/web/src/lib/format.ts` (Create), `packages/webui/web/src/lib/format.test.ts` (Create)
  - **内容**: 
    - `formatToken(n: number): string`: `< 1000 → "${n}"`, `< 1M → "${(n/1000).toFixed(1)}K"`, `< 1B → "${(n/1M).toFixed(1)}M"`, else `"${(n/1B).toFixed(1)}B"`。NaN/Infinity 返回 "0"。
    - `formatRelativeTime(iso: string): string`: 用 `Intl.RelativeTimeFormat`: `< 1min → "just now"`, `< 1h → "${min}m ago"`, `< 24h → "${h}h ago"`, `< 7d → "${d}d ago"`, else 用 `Intl.DateTimeFormat` 显示 "Mar 5"。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/lib/format.test.ts` (10+ 测试, 覆盖每个分支 + 边界)
  - **依赖**: 无

- [x] 2.2 **`validateImageFile` + `fileToBase64` + 单测**
  - **文件**: `packages/webui/web/src/lib/image.ts` (Create), `packages/webui/web/src/lib/image.test.ts` (Create)
  - **内容**:
    - `validateImageFile(file: File, currentTotal: number, currentCount: number): {ok:true, image:InputImage} | {ok:false, reason:"type"|"size"|"count"|"total"}`: 检 MIME 白名单、size ≤ 5MB、count < 4、total + size ≤ 20MB。
    - `fileToBase64(file: File): Promise<{mediaType:string, dataUrl:string, size:number}>`: 用 `FileReader.readAsDataURL`,resolve {mediaType: file.type, dataUrl: reader.result, size: file.size}。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/lib/image.test.ts` (8+ 测试, 包含各 reject 分支 + 正常 + 累积超限)
  - **依赖**: 无

- [x] 2.3 **`Brand` + `IconRow` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/sidebar/Brand.tsx` (Create), `packages/webui/web/src/components/sidebar/IconRow.tsx` (Create), `packages/webui/web/src/components/sidebar/Brand.test.tsx` (Create), `packages/webui/web/src/components/sidebar/IconRow.test.tsx` (Create)
  - **内容**: 
    - `Brand({version: string})`: 蓝色 "π" (text-2xl font-bold text-blue-600) + "pi webui" (text-base font-semibold) + `v${version}` (text-xs text-stone-500) 三段式,垂直 padding 4,水平 padding 3。
    - `IconRow({activePage: "chat"|"cron"|"atoms"|"files"|"profile"})`: 5 个 lucide 图标 (MessageSquare/Clock/Brain/Folder/User) NavLink 路由,active 蓝色高亮 (bg-blue-100 text-blue-900)。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/sidebar/` (4+ 测试, 含 default + active state)
  - **依赖**: 无

- [x] 2.4 **`SearchBox` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/sidebar/SearchBox.tsx` (Create), `packages/webui/web/src/components/sidebar/SearchBox.test.tsx` (Create)
  - **内容**: `<input>` with `Search` lucide icon 左侧, `placeholder="Filter conversations..."`, `value={query}` 受控, `onChange={(e) => onChange(e.target.value)}` 上抛。`className="w-full px-3 py-2 text-sm border border-stone-200 rounded-md"`,focus ring 蓝色。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/sidebar/SearchBox.test.tsx` (3+ 测试, 含 typing 触发 onChange)
  - **依赖**: 无

- [x] 2.5 **`ConversationList` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/sidebar/ConversationList.tsx` (Create), `packages/webui/web/src/components/sidebar/ConversationList.test.tsx` (Create)
  - **内容**: 接收 `sessions: SessionInfo[]`, `currentId?: string`, `onSelect(id)`, `onDelete(id)`, `filterQuery?: string`。渲染: 过滤 (title.toLowerCase().includes(filterQuery.toLowerCase())) 后, 每行 `MessageSquare` 图标 + `truncate(title, 30)` + hover 显示 Trash 图标 (点击触发 `window.confirm` → 确认后 `onDelete(id)`)。current 高亮蓝色。无结果显示 "No conversations match" 或 "No sessions yet"。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/sidebar/ConversationList.test.tsx` (5+ 测试, 含空/过滤/active/delete confirm)
  - **依赖**: 无

- [x] 2.6 **`NewChatButton` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/sidebar/NewChatButton.tsx` (Create), `packages/webui/web/src/components/sidebar/NewChatButton.test.tsx` (Create)
  - **内容**: `Plus` lucide 图标 + 文字 "+ New conversation", `w-full px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700`, `disabled?: boolean` + `loading?: boolean` 时显示 `Loader2` spin。点击触发 `onClick`。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/sidebar/NewChatButton.test.tsx` (3+ 测试, 含 click + loading 状态)
  - **依赖**: 无

- [x] 2.7 **`Title` + `Actions` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/topbar/Title.tsx` (Create), `packages/webui/web/src/components/topbar/Actions.tsx` (Create), `packages/webui/web/src/components/topbar/Title.test.tsx` (Create), `packages/webui/web/src/components/topbar/Actions.test.tsx` (Create)
  - **内容**:
    - `Title({title: string, messageCount: number})`: "Chat" (text-lg font-semibold) + "N messages" (text-xs text-stone-500) 两段。
    - `Actions({onClear, onSettings})`: 横向 flex,Clear 按钮 (灰) + ⚙ 按钮 (灰),`window.confirm` 在 Clear 触发。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/topbar/` (5+ 测试)
  - **依赖**: 无

- [ ] 2.8 **`ModelSelector` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/topbar/ModelSelector.tsx` (Create), `packages/webui/web/src/components/topbar/ModelSelector.test.tsx` (Create)
  - **内容**: 接收 `current: {provider, model}`, `providers: ModelsResponse["providers"]`, `onChange({provider, model})`。显示: 蓝色徽章 `text-${provider}/${model}` (truncate 16 字符)。点击展开下拉,列出所有 provider/model,选中后调 `onChange`。`useState<boolean>` 控下拉开关, click-outside 关闭。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/topbar/ModelSelector.test.tsx` (5+ 测试, 含 open/close/select/click-outside/truncate)
  - **依赖**: 2.1

- [ ] 2.9 **`MessageHeader` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/message/MessageHeader.tsx` (Create), `packages/webui/web/src/components/message/MessageHeader.test.tsx` (Create)
  - **内容**: 接收 `{name: string, timestamp: string, model?: string, avatarLetter?: string}`。渲染: 圆形 24px 蓝色背景 (bg-blue-500) + 白色字母 (默认 `name[0]?.toUpperCase() ?? "?"`) + 名字 (text-sm font-semibold) + 相对时间 (`formatRelativeTime`) + 模型徽章 (text-xs bg-stone-100 px-1.5 py-0.5 rounded, 仅 model 存在时)。`flex items-center gap-2`。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/message/MessageHeader.test.tsx` (4+ 测试)
  - **依赖**: 2.1

- [ ] 2.10 **`MessageFooter` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/message/MessageFooter.tsx` (Create), `packages/webui/web/src/components/message/MessageFooter.test.tsx` (Create)
  - **内容**: 接收 `{usage?: {input, output}}`。无 usage → 返回 null。有 usage → `text-xs text-stone-400 text-right`, 文本 `"${formatToken(usage.input)} in · ${formatToken(usage.output)} out"`。`mt-1` margin。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/message/MessageFooter.test.tsx` (4+ 测试, 含无 usage/小数字/大数字)
  - **依赖**: 2.1

- [ ] 2.11 **`MessageBubble` 重写 + 测试**
  - **文件**: `packages/webui/web/src/components/message/MessageBubble.tsx` (Create, 替换现有), `packages/webui/web/src/components/message/MessageBubble.test.tsx` (Create)
  - **内容**: 接收 `{message: Message}`。按 role 分支:
    - user: 缩进 (pl-12), 单行气泡, 内容: image 缩略图 (40x40) 横向 flex + text part 段落
    - assistant: `<MessageHeader name="pi" timestamp={message.timestamp} model={message.model} />` + `<MessageParts parts={message.parts} />` + `<MessageFooter usage={message.usage} />`
    - toolResult: toolResult 角色消息直接合并到上一个 assistant 的 toolResult 渲染 (新方案: 此处不渲染, 留给 ChatMessages 处理)
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/message/MessageBubble.test.tsx` (5+ 测试)
  - **依赖**: 2.0, 2.9, 2.10, 3.1

- [x] 2.12 **`Lightbox` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/Lightbox.tsx` (Create), `packages/webui/web/src/components/Lightbox.test.tsx` (Create)
  - **内容**: 接收 `image: {url, alt} | null, onClose`。`null` → 不渲染。否则: `createPortal` 到 `document.body`, 全屏 fixed 黑色 90% 透明 backdrop + 居中图片 (`max-w-[90vw] max-h-[90vh] object-contain`)。`useEffect` 注册 `keydown` 监听 ESC 关闭, 卸载时清理。点击 backdrop 关闭。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/Lightbox.test.tsx` (4+ 测试, 含 open/ESC/backdrop/null 不渲染)
  - **依赖**: 无

- [x] 2.13 **`ImagePreview` 组件 + 测试**
  - **文件**: `packages/webui/web/src/components/input/ImagePreview.tsx` (Create), `packages/webui/web/src/components/input/ImagePreview.test.tsx` (Create)
  - **内容**: 接收 `images: InputImage[]`, `onRemove(id)`。渲染: 横向 `flex flex-wrap gap-2`, 每张图 `relative 80x80 rounded overflow-hidden border`, `<img src={img.dataUrl} className="w-full h-full object-cover">`, 右上角 `<button aria-label="Remove" className="absolute top-0 right-0 bg-black/50 text-white p-0.5 rounded-bl">×</button>`。空数组 → 不渲染。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/input/ImagePreview.test.tsx` (3+ 测试)
  - **依赖**: 无

- [ ] 2.14 **`ImageInput` 组件 + 测试 (复杂)**
  - **文件**: `packages/webui/web/src/components/input/ImageInput.tsx` (Create), `packages/webui/web/src/components/input/ImageInput.test.tsx` (Create)
  - **内容**: 接收 `images: InputImage[]`, `onAdd(image)`, `onError(reason)`。包含:
    - Paperclip 按钮 (左), click 触发隐藏的 `<input type="file" accept="image/*">`
    - 监听 `dragover/dragleave/drop` 在 textarea 父容器, 添加 `border-blue-500 border-dashed` 状态
    - 全局 `paste` 监听 (clipboardData.files), 过滤 image/*
    - 收到 File 后调 `validateImageFile`, 通过调 `fileToBase64` 再 `onAdd`, 失败调 `onError(reason)` + alert toast
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/input/ImageInput.test.tsx` (5+ 测试, 含 click/drop/paste/validation reject/4 limit)
  - **依赖**: 2.2

## 3. 集成层 集成层

- [x] 3.1 **`api.ts` 扩展 (`Message` 类型重写 + `ModelsResponse` + `InputImage` + 4 个 API helper)**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Modify, **重写 `Message` interface**), `packages/webui/web/src/lib/api.test.ts` (Modify, 加测试)
  - **内容**: 
    - **重写 `Message` interface** (从 design.md 类型定义复制): `Message { id, sessionId, role: "user" | "assistant" | "toolResult", parts: Part[], timestamp, usage?: {input, output}, model?: string }`。
    - **新增 `Part` 类型联合**: `TextPart | ThinkingPart | ToolCallPart | ToolResultPart | ImagePart` (从 chat-message-rendering 归档 spec 复制)。
    - **新增 `InputImage` interface** (id, mediaType, dataUrl, size, name?)。
    - **新增 `ModelsResponse` interface** + `api.getModels(): Promise<ModelsResponse>` + `api.getSettings(): Promise<unknown>` + `api.setDefaultModel({provider, model}): Promise<void>` (PATCH /api/settings)。
    - 删除旧 `content: string` 字段 (从 server 端不返回 content, web 不再读)。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/lib/api.test.ts` (现有测试 + 5 新测试: getModels / getSettings / setDefaultModel / Message.parts 类型 / Part 联合)
  - **依赖**: 无

- [ ] 3.2 **`AppShell` 2-col 布局**
  - **文件**: `packages/webui/web/src/components/AppShell.tsx` (Create), `packages/webui/web/src/components/AppShell.test.tsx` (Create)
  - **内容**: 接收 `children: ReactNode`。`<div className="flex h-full">` + `<aside className="w-[260px] h-full border-r border-stone-200 flex flex-col">` (Sidebar 内部) + `<main className="flex-1 overflow-auto flex flex-col">` + children。Sidebar 由 5 个子组件组合: `<Brand version={...} />` + `<IconRow activePage="chat" />` + `<SearchBox value={filter} onChange={...} />` + `<ConversationList ... filterQuery={filter} />` + `<NewChatButton onClick={...} />`。AppShell 接收 props: `sessions`, `currentId`, `onSelect`, `onDelete`, `onNewChat`, `onSettings`, `version`。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/AppShell.test.tsx` (3+ 测试, 渲染 Brand/IconRow/SearchBox/ConversationList/NewChatButton)
  - **依赖**: 2.3, 2.4, 2.5, 2.6

- [ ] 3.3 **`App.tsx` 委托给 `AppShell`**
  - **文件**: `packages/webui/web/src/App.tsx` (Modify)
  - **内容**: 删内联 `Layout()`, 改为 `<AppShell><Outlet /></AppShell>` 包裹路由。AppShell 接收 sessions/currentId/onSelect/onDelete/onNewChat 状态, 用 `useState` + `useEffect` 加载 sessions。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/App.test.tsx` (新建 + 1 测试, 渲染 <AppShell> + <Outlet>)
  - **依赖**: 3.2

- [ ] 3.4 **`ChatPage` 重写 - 顶栏 + 输入 + 消息**
  - **文件**: `packages/webui/web/src/pages/ChatPage.tsx` (Modify), `packages/webui/web/src/pages/ChatPage.test.tsx` (Modify, 加 4 测试)
  - **内容**: 重写为:
    - state: `messages`, `inputText`, `inputImages`, `isStreaming`, `currentModel`
    - 渲染: `<Topbar title="Chat" messageCount={messages.length} modelSelector={<ModelSelector ... />} actions={<Actions onClear onSettings />} />` (sticky) + `<ChatMessages messages={messages}>` + `<InputArea images={inputImages} text={inputText} onAddImage onRemoveImage onChangeText onSubmit />` (固定底部)
    - WS subscribe + message_end handler 构造完整 parts (含 text/image/thinking/toolCall)
    - handleSubmit: 构造 `content: [{type:"text"}, ...images.map(...)]`, `ws.send({type:"prompt", text, images: images.map(i => ({mediaType, data: base64FromDataUrl(i.dataUrl)})), sessionId})`
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/pages/ChatPage.test.tsx` (现有测试 + 4 新测试: 输入/添加图片/提交/切会话清空)
  - **依赖**: 3.1, 3.2, 2.0, 2.7, 2.8, 2.11, 2.13, 2.14

- [ ] 3.5 **`InputArea` 整合 (preview + input + text)**
  - **文件**: `packages/webui/web/src/components/input/InputArea.tsx` (Create), `packages/webui/web/src/components/input/InputArea.test.tsx` (Create)
  - **内容**: 接收 `images: InputImage[]`, `text: string`, `onChangeText`, `onAddImage`, `onRemoveImage`, `onSubmit`, `onError`。渲染: 顶部 `<ImagePreview images={images} onRemove={onRemoveImage} />` + 下方 `<div className="flex gap-2 items-end">` + `<ImageInput images={images} onAdd={onAddImage} onError={onError} />` + `<textarea>` + `<Send>` 按钮。`Enter` (无 Shift) 触发 submit, Shift+Enter 换行。
  - **验证**: `cd packages/webui/web && timeout 30 node ../../../node_modules/vitest/dist/cli.js --run src/components/input/InputArea.test.tsx` (4+ 测试)
  - **依赖**: 2.13, 2.14

- [x] 3.6 **`themes/hermes.json` + 主题注入**
  - **文件**: `themes/hermes.json` (Create), `packages/webui/web/src/main.tsx` (Modify)
  - **内容**: 
    - `themes/hermes.json`: `{name:"hermes", colors: {bg:"#fafaf9", bgSidebar:"#f5f5f4", bgBubble:"#ffffff", text:"#1c1917", textMuted:"#78716c", border:"#e7e5e4", accent:"#3b82f6", accentText:"#ffffff"}}`
    - `main.tsx`: 启动时 fetch `/api/settings`, 读 `webui.theme`, 加载 `themes/${theme}.json`, 注入 CSS vars 到 `:root`。fallback 用 default。
  - **验证**: 手动查 `themes/hermes.json` 内容合法 + 浏览器 devtools `:root` 含 `--accent: #3b82f6`
  - **依赖**: 无

- [x] 3.7 **`GET /api/settings` 端点 (用于 main.tsx 加载)**
  - **文件**: `packages/webui/server/routes/settings.ts` (Create), `packages/webui/server/routes/settings.test.ts` (Create)
  - **内容**: `GET /api/settings` 读 `~/.pi/agent/settings.json` 返回对象, `PATCH /api/settings` 接收部分对象 merge 写回 (model theme 等)。失败返回 500。
  - **验证**: `cd packages/webui && timeout 30 node ../../node_modules/vitest/dist/cli.js --run server/routes/settings.test.ts` (3+ 测试)
  - **依赖**: 无

## 4. 验证 + 收尾 验证 + 收尾

- [ ] 4.1 **全量 server 测试通过**
  - **文件**: 无 (验证步骤)
  - **内容**: 跑全套 server tests, 确认现有 125 + 新增 20+ 全部通过
  - **验证**: `cd packages/webui && timeout 120 node ../../node_modules/vitest/dist/cli.js --run server/test server/lib server/routes`
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 3.7

- [ ] 4.2 **全量 web 测试通过**
  - **文件**: 无 (验证步骤)
  - **内容**: 跑全套 web tests, 确认现有 51 + 新增 35+ 全部通过
  - **验证**: `cd packages/webui/web && timeout 120 node ../../../node_modules/vitest/dist/cli.js --run`
  - **依赖**: 2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6

- [ ] 4.3 **`npm run check` 通过**
  - **文件**: 无
  - **内容**: 跑 repo root check, 修所有新错误/警告/info
  - **验证**: `cd /home/qjh/workspace/personal/pi && timeout 180 npm run check` (无新增 error/warn/info)
  - **依赖**: 4.1, 4.2

- [ ] 4.4 **E2E: build + serve + chrome-devtools verify**
  - **文件**: 无
  - **内容**: 
    1. `cd packages/webui/web && npm run build`
    2. `cd /home/qjh/.pi/agent && npx tsx --tsconfig packages/webui/tsconfig.json packages/webui/server/index.ts`
    3. `curl -s http://127.0.0.1:8741/api/sessions` → 200
    4. `curl -s http://127.0.0.1:8741/api/models` → 200 含 providers
    5. chrome-devtools_navigate_page to `http://127.0.0.1:8741/`, take snapshot, 验证:
       - 左栏有 Brand (π + "pi webui" + version)
       - 左栏有 5 IconRow 图标
       - 搜索框 placeholder "Filter conversations..."
       - "+ New conversation" 按钮
       - 顶栏 "Chat" + "N messages" + model badge + Clear + ⚙
       - 切到 /session/<id> 后: input area + image input (clip)
  - **依赖**: 4.1, 4.2, 4.3

## 验证 (Phase 4 完成后) (Phase D 完成后)

- [ ] 全量 server tests pass: `cd packages/webui && timeout 120 node ../../node_modules/vitest/dist/cli.js --run`
- [ ] 全量 web tests pass: `cd packages/webui/web && timeout 120 node ../../../node_modules/vitest/dist/cli.js --run`
- [ ] `npm run check` 0 new errors
- [ ] E2E: 打开浏览器看到新左栏 + 顶栏 + 输入框 (见 4.4)
- [ ] Manual: 创建会话 + 发图片 (拖拽) + 看 lightbox + 切模型
