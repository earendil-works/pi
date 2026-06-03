# Design: pi-webui-redesign

## Context

当前 pi-webui 是 2-column 极简布局 (200px 文本链接左栏 + 中间聊天),主要问题:

1. 缺乏品牌区和应用图标,辨识度低
2. 左栏没有搜索/过滤,会话多了难定位
3. 聊天顶栏信息密度低,缺 inline 模型选择,无 token 统计
4. 助手消息无头像/名字/时间戳/模型,无法一眼分辨 turn
5. Token 用量不显示,无法评估成本
6. Cron/Atoms 占顶栏 tab
7. 图片查看/输入能力缺失 (用户已发反馈)

参考 Hermes v0.34.3 的视觉与交互,重做 webui。本变更继承并扩展 `pi-webui-tool-rendering` 归档的 MessageParts 能力 (已支持 ImagePart 渲染),新增图片输入、token 统计、聊天顶栏 control plane、左栏重新设计。

## Goals / Non-Goals

- **Goals**:
  - 重做 2-column 布局,符合 Hermes 风格
  - 左栏: 品牌区 + 5 图标 + 搜索 + 会话列表 + 新建按钮
  - 顶栏: 标题 + "N messages" + 模型选择器 + Clear + ⚙
  - 助手消息: header (avatar/name/time/model) + body (parts) + footer (token)
  - 图片输入: Paperclip + 拖拽 + 粘贴 + 4 张预览
  - 图片查看: inline + 多图横排 + lightbox
  - Token 统计从 JSONL `entry.message.usage` 提取
  - 沿用 themes/ 机制,新增 `hermes.json`
  - 零 pi core 改动

- **Non-Goals**:
  - 文件管理 / 右栏文件树
  - 非图片附件 (PDF/文档/压缩包)
  - 语音输入、视频输入
  - 会话分组 (Pinned/Today)
  - Token 实时预测
  - 自定义主题编辑器
  - 多用户/权限/分享
  - 图片编辑 (裁剪/旋转/标注)
  - 端到端加密/审计

## Decisions

### 1. 全新 AppShell 接管 2-col 布局 (D1)
**Decision**: 新建 `AppShell.tsx` 替代现有 `App.tsx` + 内联 `Layout()`,作为 2-col 布局的唯一 owner。
**Rationale**: 现有 `App.tsx` + `Layout()` 把布局写死,Sidebar 混在 Layout 内,无法独立测试。AppShell 让布局成为纯组件,所有子组件可单独 storybook 化。
**Alternatives considered**:
- 保留 App.tsx + Layout,只改样式 — 改不动,布局/状态/路由耦合。

### 2. Sidebar 拆 5 子组件 (D2)
**Decision**: Sidebar 拆为 `Brand` + `IconRow` + `SearchBox` + `ConversationList` + `NewChatButton` 5 个独立组件,各持有自己的子状态。
**Rationale**: 单文件 173 行 Sidebar 责任过多 (品牌+导航+搜索+列表+删除+新建)。拆分后每个组件 < 80 行,职责清晰,易测试。
**Alternatives considered**:
- 保留单 Sidebar.tsx,内部堆 div — 测试和维护都难。

### 3. Topbar 拆 3 子组件 (D3)
**Decision**: Topbar 拆 `Title` + `ModelSelector` + `Actions` (Clear + ⚙)。
**Rationale**: 模型选择器需独立状态 (下拉打开/关闭 + 选中项),独立组件避免污染 ChatPage。
**Alternatives considered**:
- ChatPage 内联写 topbar — 状态全在 ChatPage,200+ 行变 350+ 行。

### 4. 助手消息 envelope 三段式 (D4)
**Decision**: MessageBubble = MessageHeader + MessageParts + MessageFooter。
**Rationale**: 严格三段式让"哪些是元数据/内容/成本"一目了然,新增/修改其中一段不污染其他。Header/Footer 独立可 storybook。
**Alternatives considered**:
- 单 MessageBubble 包含一切 — 改 token 显示要动整个 bubble。

### 5. 图片输入 state 在 ChatPage (D5)
**Decision**: `inputImages: InputImage[]` 存在 ChatPage,传 `onImagesChange` 给 `ImageInput`,渲染时由 `ImagePreview` 显示。
**Rationale**: ChatPage 已是输入和发送的 owner,加 images 字段最自然;Context 会引入 Provider/Hook 多余抽象。
**Alternatives considered**:
- React Context — 过度设计,单页使用 Context 不值得。
- useRef — 失去响应式,无法驱动 UI 重新渲染。

### 6. 图片预览用 data URL (D6)
**Decision**: 选完文件后立即 `FileReader.readAsDataURL` 生成 `data:image/png;base64,...`,存 React state,渲染时直接用此 URL。
**Rationale**: data URL 无副作用 (无需 revoke),刷新时自然释放,与 React state 同生命周期。
**Alternatives considered**:
- `URL.createObjectURL` — 需手动 revoke,容易内存泄漏;File 对象本身在 React state 序列化困难。

### 7. Lightbox 用 React Portal + useState (D7)
**Decision**: Lightbox 组件用 `createPortal` 挂到 `document.body`,`useState<{url, alt} | null>` 控开关。
**Rationale**: 纯 React,无第三方依赖;Portal 解决 z-index 嵌套问题;Esc 监听 + backdrop 点击关闭。
**Alternatives considered**:
- `react-image-lightbox` 等三方库 — 多 1 个 npm 依赖,版本控制风险。
- 无 lightbox,新窗口打开 — 跳出 webui 体验割裂。

### 8. 新会话走 pi --new-session (D8)
**Decision**: `POST /api/sessions` server 端 `child_process.spawn('pi', ['--mode', 'rpc', '--new-session', '--cwd', cwd])`,等 RPC `session_created` 事件拿到新 sessionId。失败降级为 randomUUID 模式。
**Rationale**: 复用 pi core session 机制 (内存、cwd 继承、设置应用),不重复发明。降级保证 UI 永不阻塞。
**Alternatives considered**:
- 改 pi core RPC 加 `create_session` 命令 — 违反"零 pi core 改动"约束。
- 只用 randomUUID 模式 — 不能享受 pi core 的 cwd/setup 初始化。

### 9. Token 提取在 server 端 (D9)
**Decision**: server `readMessages` 解析 `entry.message.usage`,作为 `Message.usage?: {input, output}` 字段返回,客户端直接渲染。
**Rationale**: server 已有文件 IO,顺手解析无额外成本;客户端避免再读 JSONL 浪费带宽。
**Alternatives considered**:
- 客户端 fetch JSONL 解析 — 重复 IO,延迟。
- 挂载到 parts — 污染 parts schema,语义不对 (usage 不是内容 part)。

### 10. 模型列表走 GET /api/models (D10)
**Decision**: 新增 `GET /api/models` 端点,server 读 `~/.pi/agent/models.json` 解析为 `{providers: [{name, models: [{id, name}]}]}` 返回。
**Rationale**: 复用现有 server 配置读取,客户端零直读。CORS/安全都集中 server。
**Alternatives considered**:
- 客户端 fetch models.json — CORS 阻塞,需 server 配 CORS。
- 硬编码 provider 列表 — 用户换 provider 失同步。

### 11. WS prompt images 升级 (D11)
**Decision**: WS `prompt` 消息 `images: {mediaType: string, data: string}[]` 替代现有 `string[]`,session-pool 透传完整 content 数组到 pi core stdin (`{type:"prompt", sessionId, content: [{type, ...}, ...]}`)。
**Rationale**: 现有 `string[]` 字段每个 < 1KB,无法承载真实图片。新 schema 与 pi core 内部 `ImageContent` 兼容。
**Alternatives considered**:
- 保留 string[] — 真实图片 > 100KB,验证失败。
- 上传到 server 暂存,只发 URL — 增加 server 复杂度,且刷新会丢。

### 12. 主题沿用 themes/ + 新增 hermes.json (D12)
**Decision**: 现有 themes/ 机制 (server 读,client 注入 CSS vars) 不变,新增 `hermes.json` 主题 (左栏 #f5f5f4 暖灰 + 聊天 #fafaf9 米白 + accent #3b82f6)。
**Rationale**: 现有 codewhale.json 已验证可工作,新主题只是 JSON 配色定义。
**Alternatives considered**:
- 改 themes API 加更多 token (spacing/font scale) — 重构量大,YAGNI。

### 13. 保留 MessageParts (D13)
**Decision**: 从 `pi-webui-tool-rendering` 归档保留 `MessageParts.tsx` (5 Part 类型 + ToolGroup 容器 + lucide 图标),不重写。
**Rationale**: 已通过 12 测试 + E2E 验证 (用户在浏览器看过渲染效果)。重写浪费 50+ 提交。
**Alternatives considered**:
- 推倒重写 — 浪费已工作代码,且 MessageParts 是核心,变更风险大。

### 14. Sticky 元素 (D14)
**Decision**: Topbar sticky 在主区域顶部 (z-10),IconRow sticky 在 sidebar 顶部 (z-10),输入框固定在主区域底部 (z-10)。
**Rationale**: 滚动长会话时,模型切换和搜索常驻可达,符合 Hermes 交互。
**Alternatives considered**:
- 全部随内容滚 — 长会话操作困难。

## Architecture

### 组件树

```
AppShell (新) - 2-col 布局
├── Sidebar (260px, 重写)
│   ├── Brand (新) - π + pi webui + v0.X.Y
│   ├── IconRow (新) - 5 lucide 图标 + NavLink
│   ├── SearchBox (新) - 实时过滤 input
│   ├── ConversationList (新) - 扁平列表 + hover trash
│   └── NewChatButton (新) - 蓝色 full-width
└── Main (flex-1, overflow-auto)
    ├── Topbar (新, sticky top-0)
    │   ├── Title (新) - "Chat" + "N messages"
    │   ├── ModelSelector (新) - 蓝色徽章下拉
    │   └── Actions (新) - Clear + ⚙
    ├── ChatMessages (沿用)
    │   └── MessageBubble (重写)
    │       ├── MessageHeader (新) - 圆形 avatar + name + time + model badge
    │       ├── MessageParts (沿用 from pi-webui-tool-rendering)
    │       │   ├── ThinkingPart → 折叠块
    │       │   ├── ToolGroup → 容器 (call+result)
    │       │   ├── ImagePart → img + click → Lightbox
    │       │   └── TextPart → 段落
    │       └── MessageFooter (新) - "3.1M in · 9.7k out"
    ├── InputArea (重写)
    │   ├── ImagePreview (新) - 80×80 缩略图 + X
    │   ├── ImageInput (新) - 📎 按钮 + 拖拽高亮 + 粘贴监听
    │   └── TextInput (沿用) - textarea + Send
    ├── Lightbox (新) - Portal + backdrop + ESC 关闭
    └── 子页: CronPage / AtomsPage
```

### 关键 Type 定义

```ts
// 输入图片 (草稿, 不持久化)
export interface InputImage {
  id: string;             // crypto.randomUUID()
  mediaType: string;      // "image/png"
  dataUrl: string;        // "data:image/png;base64,..."
  size: number;           // bytes
  name?: string;          // 原文件名 (可选)
}

// Server 返回的图片
export interface ImagePart {
  type: "image";
  mediaType: string;
  data: string;           // base64 (no prefix)
}

// Message envelope (扩展 from chat-message-rendering)
export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "toolResult";
  parts: Part[];
  timestamp: string;
  usage?: { input: number; output: number };  // 新增,assistant only
  model?: string;                              // 新增,assistant only
}

// Server 响应模型列表
export interface ModelsResponse {
  providers: Array<{
    name: string;
    models: Array<{ id: string; name: string }>;
  }>;
}
```

### WS 协议升级

```ts
// 旧
interface PromptMsg { type: "prompt"; text: string; images?: string[]; }

// 新
interface PromptMsg {
  type: "prompt";
  text: string;
  images?: Array<{ mediaType: string; data: string }>;  // 单图 ≤ 5MB, 总 ≤ 20MB, ≤ 4 张
}
```

### 数据流 (图片输入)

```
ImageInput (button click / drop / paste)
  → fileToBase64(file) → {mediaType, dataUrl, size}
  → onAdd(image)
ChatPage 持有 inputImages state
  → 传给 ImagePreview 渲染缩略图
  → X 点击 → onRemove(id)
User 按 Enter
  → handleSubmit: 构造 message.parts = [
      {type: "text", text: inputText},
      ...inputImages.map(img => ({type: "image", mediaType, data: base64FromDataUrl(img.dataUrl)}))
    ]
  → setMessages([..., userMsg]) (optimistic)
  → ws.send({type:"prompt", text, images: [...], sessionId})
  → setInputText(""); setInputImages([])  // 清空草稿
```

### Server `POST /api/sessions` 流程

```
1. 接收 POST /api/sessions {initialPrompt?}
2. 调 piProcess.spawn('pi', ['--mode','rpc','--new-session','--cwd', cwd])
3. 监听 stdout, 等待 JSON {type: 'session_created', sessionId: '...'}
4. 成功 → 返回 {id: sessionId, sessionFile: '<sessionsDir>/<iso>_<id>.jsonl'}
5. 失败 (5s 超时) → 降级: 写空 header JSONL, 返回 randomUUID sessionId
6. server log 警告 "pi --new-session failed, fallback to UUID"
```

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| 全新 AppShell 回归风险高 | 保留 51 web 测试 + 125 server 测试 + 新增 30+ 测试覆盖新组件;Phase 1 改 Sidebar,Phase 2 改 Topbar,逐步上线 |
| 图片内存峰值 20MB × 多 tab | 单 tab ≤ 4 张 × 5MB = 20MB 上限;React 卸载自然释放;ws.send 后立即清 state |
| pi --new-session spawn 慢 (1-2s) | Button disabled + spinner;失败 5s 内降级 randomUUID;console.warn 提示 |
| Hermes 主题与 codewhale 不兼容 | 独立 hermes.json,用户 settings.json 切换;两者用相同 CSS vars,组件用 vars 而非硬编码 |
| 100+ 会话虚拟滚动性能 | 先简单 `content-visibility: auto` + 渲染所有行;如果卡再加 intersection-observer 懒加载 |
| token 极大值 1e9 显示异常 | `formatToken(n)` 函数统一处理,1 decimal: < 1K 显示 "N", < 1M 显示 "N.NK", < 1B 显示 "N.NM", 否则 "N.NB" |
| lightbox 与 portal SSR 冲突 | webui 是纯 CSR (Vite),无 SSR 问题 |
| WS prompt 升级破坏老 client | 老 client 仍发 `images: string[]`,server 验证失败返回 error,新版识别新 schema 并透传;过渡期可双 schema 兼容 |

## Testing Strategy

- **单元测试** (web vitest):
  - `formatToken(n)` - 0 / 999 / 1000 / 1500 / 1e6 / 3.1e6 / 1e9 / 1e12
  - `summarizeToolCall` (已存在) / `summarizeToolResult` (已存在)
  - `validateImageFile(file)` - MIME / size / 总累积
  - `fileToBase64(file)` - 异步返回 dataURL
  - `parseModelsJson(json)` - 转 providers 结构
  - `parseMessageUsage(jsonlLine)` - 提取 input/output
  - `truncateTitle(title, maxLen)` - 已存在
  - `formatRelativeTime(iso)` - "2h ago" / "Yesterday" / "Mar 5"
- **组件测试** (web vitest + RTL):
  - Brand: 渲染 π + "pi webui" + 版本
  - IconRow: 5 图标 + active 状态
  - SearchBox: 输入过滤,空显示全部
  - ConversationList: 列表渲染 + hover trash + click select
  - NewChatButton: click 触发 onNewChat
  - Topbar: 标题 + "N messages" + ModelSelector + Clear
  - ModelSelector: 打开下拉 + 选中触发 onChange
  - MessageHeader: avatar + name + time + model badge
  - MessageFooter: token 格式化,无 usage 不渲染
  - ImagePreview: 缩略图 + X 删除
  - ImageInput: button click 触发 file picker;拖拽高亮;粘贴监听
  - Lightbox: 打开/关闭/ESC 关闭
- **集成测试** (web vitest + RTL):
  - AppShell 渲染 + 路由
  - ChatPage: 输入文本 → 提交 → message 出现
  - ChatPage: 添加图片 → 提交 → message 含 image part
  - ChatPage: 切换会话 → 状态清空
- **E2E** (server smoke + chrome-devtools):
  - 启动 webui → 打开主页 → 看到新左栏 + 顶栏
  - 新建会话 → 跳到 /session/:id
  - 发送 "hello" → 看到 user + assistant 消息
  - 搜索 "deploy" → 列表过滤
  - 切会话 → 状态切换
- **Server 测试** (vitest):
  - `POST /api/sessions` 调 pi --new-session, 失败降级
  - `GET /api/models` 解析 models.json
  - `GET /api/sessions/:id/messages` 返回 usage
  - WS `prompt` 接受 `images: [{mediaType, data}]`, 验证大小
  - WS `prompt` 单图 > 5MB 拒绝, 总量 > 20MB 拒绝, > 4 张拒绝

## Implementation Notes

### 实施顺序 (依赖关系)

1. **D13 保留** - 不动 MessageParts (已有 12 测试 + E2E 验证)
2. **Server: GET /api/models** (无依赖,纯 read JSON)
3. **Server: GET /api/sessions/:id/messages 加 usage 字段** (parser 扩展)
4. **Server: POST /api/sessions pi --new-session** (依赖 server.ts session spawn 已存在)
5. **Server: WS prompt images 升级** (含 maxBytes 验证)
6. **Web: AppShell.tsx 接管 2-col**
7. **Web: Sidebar 5 子组件** (Brand / IconRow / SearchBox / ConversationList / NewChatButton)
8. **Web: Topbar 3 子组件** (Title / ModelSelector / Actions)
9. **Web: MessageHeader / MessageFooter 包装 MessageParts**
10. **Web: InputArea + ImageInput + ImagePreview + Lightbox**
11. **Web: WS prompt images: {mediaType, data}[] 发送**
12. **Theme: hermes.json + CSS vars 注入**
13. **整合 + 回归测试**

### 关键工具函数 (待实现)

```ts
// formatToken
export function formatToken(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

// validateImageFile
export function validateImageFile(file: File, currentTotal: number):
  | { ok: true; image: InputImage }
  | { ok: false; reason: "type" | "size" | "count" | "total" } { ... }

// fileToBase64
export function fileToBase64(file: File): Promise<{ mediaType: string; dataUrl: string; size: number }> { ... }
```

### 配置变更

- `~/.pi/agent/settings.json` 新增 `webui.theme: "hermes" | "codewhale" | "default"`
- `~/.pi/agent/settings.json` 新增 `webui.defaultModel: "<provider>/<modelId>"` (ModelSelector 写入)
- `themes/hermes.json` 新建,内容:
  ```json
  {
    "name": "hermes",
    "colors": {
      "bg": "#fafaf9",
      "bgSidebar": "#f5f5f4",
      "bgBubble": "#ffffff",
      "text": "#1c1917",
      "textMuted": "#78716c",
      "border": "#e7e5e4",
      "accent": "#3b82f6",
      "accentText": "#ffffff"
    }
  }
  ```

### 不变 (零改动)

- pi core 0 行改动
- 现有 51 web 测试全保留 (不动测试文件)
- 现有 125 server 测试全保留
- MessageParts.tsx (从归档) 不动
- 现有 `/api/cron/*` 端点不动
- WS subscribe / unsubscribe / abort / switch_session 协议不动

### 已知 follow-up (本次不做)

- 7 MEDIUM + 6 LOW 安全 finding (来自 pi-webui-fixes review)
- cron / atoms 视觉细化 (子页面保持现有,只动左栏 icon)
- 虚拟滚动 (100+ 会话性能)
- 多用户/分享
- 端到端加密
- Token 预测
