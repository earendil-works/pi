# Verification Checklist: pi-webui-redesign

> 生成时间: 2026-06-03 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 初始页面加载显示左栏 5 段 (Brand/IconRow/SearchBox/ConversationList/NewChatButton) | chat-app-shell:L13 | chrome-devtools | `navigate_page` to `http://127.0.0.1:8741/`, `take_snapshot`, 验证 uid 含 "pi webui" / "v" / "Filter conversations" / "+ New conversation" | 左栏 5 段全部可见 | [ ] |
| S2 | Brand 显示 π + "pi webui" + 版本 | chat-app-shell:L19 | chrome-devtools | snapshot 查 Brand 区域文本 | 含 "π" + "pi webui" + "v0.X.Y" | [ ] |
| S3 | IconRow 5 个 lucide 图标垂直排列 | chat-app-shell:L24 | chrome-devtools | snapshot 查 IconRow 区域, 5 个 nav 元素 | 5 个图标 + MessageSquare active | [ ] |
| S4 | 搜索 "deploy" 过滤会话列表 | chat-app-shell:L34 | chrome-devtools | `fill` SearchBox with "deploy", 验证只显示含 deploy 的会话 | 列表行数 < 总数 | [ ] |
| S5 | 搜索 "xyz123" 无结果显示 "No conversations match" | chat-app-shell:L40 | chrome-devtools | fill SearchBox with "xyz123", 验证 placeholder 文本 | placeholder "No conversations match" 出现 | [ ] |
| S6 | 点 + New conversation 跳到 /session/:id | chat-app-shell:L52 | chrome-devtools | click "+ New conversation", 验证 URL 变更 | URL 含 `/session/<uuid>` | [ ] |
| S7 | pi --new-session 失败降级 UUID | chat-app-shell:L61 | manual | 临时 rename `pi` binary, 点 + New conversation, 验证仍创建会话 + server log warn | 创建成功 + console.warn 含 "fallback to UUID" | [ ] |
| S8 | Hover 会话行显示 Trash 图标 | chat-app-shell:L73 | chrome-devtools | `hover` 会话行, 验证 Trash uid 出现 | Trash 按钮 opacity 100 | [ ] |
| S9 | 点 Trash + 确认 → 乐观删除 + 调 DELETE | chat-app-shell:L78 | chrome-devtools | click Trash, accept confirm, 验证 row 消失 + 主页跳转 | 列表无该行 + URL 为 `/` | [ ] |
| S10 | 点 Trash + 取消 → 保留 | chat-app-shell:L85 | chrome-devtools | click Trash, dismiss confirm, 验证 row 仍在 | 列表行不变 | [ ] |
| S11 | 长标题 truncate 30 字符 | chat-app-shell:L91 | unit-test | `ConversationList.test.tsx` render session with 200-char title, 查 "…" | 文本以 "…" 结尾且 ≤ 31 字符 | [ ] |
| S12 | 空标题显示 "New Chat" | chat-app-shell:L97 | unit-test | render session with title="", 查 "New Chat" | 文本含 "New Chat" | [ ] |
| S13 | Topbar 滚动时 sticky 顶部 | chat-app-shell:L106 | chrome-devtools | 长会话滚动 main, 验证 Topbar 仍可见 | Topbar 位置不变 (y=0) | [ ] |
| S14 | 切换会话清空输入草稿 | chat-app-shell:L111 | chrome-devtools | 在 A 输入 "hello", 切到 B, 切回 A, 验证 A 输入框为空 | A 输入框无文本 | [ ] |
| S15 | 左栏宽度 260px | chat-app-shell:L122 | chrome-devtools | inspect sidebar 元素, 查 width computed style | 260px | [ ] |
| S16 | Cron 路由在主区域而非顶栏 tab | chat-app-shell:L128 | chrome-devtools | click Clock 图标, 验证 cron 内容在 main + 无顶栏 tab | 主区域显示 cron 页面 | [ ] |
| S17 | 顶栏 "31 messages" 显示 | chat-topbar:L11 | chrome-devtools | 进入有 31 条消息的会话, 验证 Topbar 副标题 | 文本含 "31 messages" | [ ] |
| S18 | 空会话 "0 messages" | chat-topbar:L17 | chrome-devtools | 进入新会话, 验证副标题 | 文本含 "0 messages" | [ ] |
| S19 | ModelSelector 点开下拉 | chat-topbar:L25 | chrome-devtools | click 模型徽章, 验证下拉列表出现 | 下拉含 providers 列表 | [ ] |
| S20 | 选新模型 PATCH settings | chat-topbar:L31 | chrome-devtools | select `openai/gpt-4o`, 验证 badge 变更 + settings.json 更新 | badge 文本变更 + 文件含 `defaultModel: "openai/gpt-4o"` | [ ] |
| S21 | 点下拉外关闭 | chat-topbar:L37 | chrome-devtools | open dropdown, click body, 验证 dropdown 消失 | dropdown 不在 DOM | [ ] |
| S22 | 长模型名 truncate 16 | chat-topbar:L43 | unit-test | `ModelSelector.test.tsx` render 30-char model name, 查 "..." | 文本以 "..." 结尾且 ≤ 19 字符 | [ ] |
| S23 | Clear 按钮清空 messages | chat-topbar:L51 | chrome-devtools | click Clear, accept confirm, 验证 messages 数组空 + 无 API 调用 | messages.length === 0 + Network 面板无 DELETE | [ ] |
| S24 | ⚙ 按钮无操作 (placeholder) | chat-topbar:L59 | chrome-devtools | click ⚙, 验证无 modal 出现 + 无 console error | 无变化 | [ ] |
| S25 | Header 渲染身份 (avatar/name/time/model) | chat-message-rendering:L23 | chrome-devtools | 渲染 assistant 消息, 验证 header 含 P 圆 + "pi" + "2h ago" + model badge | 4 元素都在 | [ ] |
| S26 | Footer "3.1M in · 9.7k out" | chat-message-rendering:L29 | chrome-devtools | 渲染有 usage={input:3100000,output:9700} 的消息, 查 footer | 文本含 "3.1M in · 9.7k out" | [ ] |
| S27 | 无 usage 不渲染 footer | chat-message-rendering:L35 | chrome-devtools | 渲染无 usage 的消息, 验证无 footer 元素 | footer 不在 DOM | [ ] |
| S28 | 大数字格式 "1.5B in · 250.0K out" | chat-message-rendering:L41 | unit-test | `MessageFooter.test.tsx` render usage={input:1.5e9,output:250000} | 文本完全匹配 | [ ] |
| S29 | formatToken(500) → "500" | chat-message-rendering:L60 | unit-test | `format.test.ts` expect "500" | test pass | [ ] |
| S30 | formatToken(1500) → "1.5K" | chat-message-rendering:L66 | unit-test | `format.test.ts` expect "1.5K" | test pass | [ ] |
| S31 | formatToken(3.1M) → "3.1M" | chat-message-rendering:L72 | unit-test | `format.test.ts` expect "3.1M" | test pass | [ ] |
| S32 | formatToken(1.5B) → "1.5B" | chat-message-rendering:L78 | unit-test | `format.test.ts` expect "1.5B" | test pass | [ ] |
| S33 | formatToken(0) → "0" | chat-message-rendering:L84 | unit-test | `format.test.ts` expect "0" | test pass | [ ] |
| S34 | formatToken(NaN) → "0" | chat-message-rendering:L90 | unit-test | `format.test.ts` expect "0" | test pass | [ ] |
| S35 | formatRelativeTime 30s → "just now" | chat-message-rendering:L99 | unit-test | `format.test.ts` mock Date.now +30s | expect "just now" | [ ] |
| S36 | formatRelativeTime 2h → "2h ago" | chat-message-rendering:L105 | unit-test | mock Date.now +2h | expect "2h ago" | [ ] |
| S37 | formatRelativeTime 3d → "3d ago" | chat-message-rendering:L111 | unit-test | mock Date.now +3d | expect "3d ago" | [ ] |
| S38 | formatRelativeTime 14d → "May 20" 格式 | chat-message-rendering:L117 | unit-test | mock Date.now +14d | expect date string | [ ] |
| S39 | assistant 有 usage 字段 | chat-message-rendering:L125 | unit-test | `sessions-routes.test.ts` mock JSONL with usage | response 含 usage | [ ] |
| S40 | assistant 无 usage 不含该字段 | chat-message-rendering:L131 | unit-test | mock JSONL without usage | response.usage === undefined | [ ] |
| S41 | user 消息无 usage 字段 | chat-message-rendering:L137 | unit-test | mock user message | response.usage === undefined | [ ] |
| S42 | 单张 image inline 渲染 | chat-message-rendering:L145 | chrome-devtools | 渲染工具返回的图片, 验证 img 元素 | img 元素含 data URL + max-h-96 class | [ ] |
| S43 | 多张图横排 flex-wrap | chat-message-rendering:L151 | chrome-devtools | 渲染 3 张图的 toolResult, 验证 flex 容器 | container 3 children + flex + flex-wrap | [ ] |
| S44 | 大图 max-h-96 不破版 | chat-message-rendering:L157 | unit-test | render 5MB image, 验证 img 元素 class | 含 max-h-96 | [ ] |
| S45 | 点图开 lightbox | chat-message-rendering:L163 | chrome-devtools | click img, 验证 portal 内容 | body 含 lightbox + 黑色 backdrop | [ ] |
| S46 | ESC 关 lightbox | chat-message-rendering:L169 | chrome-devtools | open lightbox, press_key Escape, 验证 portal 消失 | lightbox 不在 body | [ ] |
| S47 | 点 backdrop 关 lightbox | chat-message-rendering:L175 | chrome-devtools | open lightbox, click backdrop, 验证消失 | lightbox 不在 body | [ ] |
| S48 | 大图 lazy load | chat-message-rendering:L181 | chrome-devtools | render >1MB image, 验证 img 元素 | loading="lazy" attribute | [ ] |
| S49 | Paperclip 按钮开 file picker | chat-image-input:L11 | chrome-devtools | click 📎, 验证 file input 被 click | `<input type="file" accept="image/*">` click() 被触发 | [ ] |
| S50 | 选 PNG 加入预览 | chat-image-input:L17 | unit-test | `ImageInput.test.tsx` 模拟选 file | 预览列表多 1 项 | [ ] |
| S51 | 拖图高亮虚线 | chat-image-input:L27 | chrome-devtools | dispatchEvent dragover, 验证 class | 含 border-blue-500 border-dashed | [ ] |
| S52 | 拖 PNG 到 textarea 加预览 | chat-image-input:L33 | chrome-devtools | dispatchEvent drop with file | 预览多 1 项 | [ ] |
| S53 | 拖 PDF 弹 "Unsupported file type" | chat-image-input:L39 | chrome-devtools | dispatchEvent drop with pdf | alert 文本含 "Unsupported" | [ ] |
| S54 | Cmd+V 粘贴剪贴板图 | chat-image-input:L47 | chrome-devtools | dispatchEvent paste with image clipboard | 预览多 1 项 | [ ] |
| S55 | bmp 文件被拒 | chat-image-input:L57 | unit-test | `image.test.ts` validateImageFile(bmp) | {ok:false, reason:"type"} | [ ] |
| S56 | 8MB 文件被拒 | chat-image-input:L63 | unit-test | validateImageFile(8MB png) | {ok:false, reason:"size"} | [ ] |
| S57 | 第 5 张图被拒 | chat-image-input:L69 | unit-test | validateImageFile(4 images) | {ok:false, reason:"count"} | [ ] |
| S58 | 累积超 20MB 被拒 | chat-image-input:L75 | unit-test | validateImageFile(18MB total + 3MB) | {ok:false, reason:"total"} | [ ] |
| S59 | 预览 2 张图横排 | chat-image-input:L84 | unit-test | render 2 images, 验证 DOM | 2 img + flex 容器 | [ ] |
| S60 | 点 X 删图 | chat-image-input:L90 | unit-test | click X on first, 验证列表 | 列表少 1 项 | [ ] |
| S61 | 发送文本无 images 字段 | chat-image-input:L100 | unit-test | submit text only, 验证 WS msg | msg.images === undefined | [ ] |
| S62 | 发送文本+1 图 | chat-image-input:L106 | unit-test | submit with 1 image, 验证 WS msg | msg.images.length === 1 + mediaType | [ ] |
| S63 | 发送文本+多图 | chat-image-input:L113 | unit-test | submit with 3 images | msg.images.length === 3 | [ ] |
| S64 | Shift+Enter 不发送 | chat-image-input:L119 | unit-test | dispatchEvent keydown Shift+Enter | 文本含 \n, 无 WS send | [ ] |
| S65 | WS 接收 valid images 透传 | webui-ws-protocol:L11 | unit-test | `ws-handler.test.ts` send valid prompt with image | pool.prompt called + no error | [ ] |
| S66 | WS 拒 5 张图 | webui-ws-protocol:L17 | unit-test | send 5 images | error sent, no pool.prompt | [ ] |
| S67 | WS 拒 6MB 单图 | webui-ws-protocol:L23 | unit-test | send 6MB image | error sent | [ ] |
| S68 | WS 拒 21MB 总量 | webui-ws-protocol:L29 | unit-test | send 21MB total | error sent | [ ] |
| S69 | WS 拒 bmp MIME | webui-ws-protocol:L35 | unit-test | send image/bmp | error sent | [ ] |
| S70 | session-pool 写 content 数组 | webui-ws-protocol:L48 | unit-test | `session-pool.test.ts` call prompt with image | stdin JSON 含 content array 含 text+image | [ ] |
| S71 | session-pool 文本提示无 image | webui-ws-protocol:L56 | unit-test | call prompt("hello") only | content array 仅含 text part | [ ] |
| S72 | GET /api/models 返回 providers | webui-ws-protocol:L65 | unit-test | `models.test.ts` mock models.json | 200 + providers 数组 | [ ] |
| S73 | GET /api/models 缺文件返 [] | webui-ws-protocol:L71 | unit-test | mock missing file | 200 + {providers:[]} | [ ] |
| S74 | GET /api/settings 返回对象 | webui-ws-protocol:L80 | unit-test | `settings.test.ts` mock settings.json | 200 + 完整对象 | [ ] |
| S75 | GET /api/settings 缺文件返 {} | webui-ws-protocol:L86 | unit-test | mock missing | 200 + {} | [ ] |
| S76 | PATCH /api/settings merge | webui-ws-protocol:L94 | unit-test | send partial {webui:{defaultModel}} | 文件更新 + 其他字段保留 | [ ] |
| S77 | PATCH /api/settings 保留其他 | webui-ws-protocol:L100 | unit-test | send {webui:{defaultModel}} over {personalAssistant, webui:{theme}} | 文件含 personalAssistant + theme + defaultModel | [ ] |
| S78 | Hermes 主题加载 | theme:L13 | chrome-devtools | 设置 webui.theme="hermes", 刷新, 验证 :root CSS vars | --accent: #3b82f6 等 | [ ] |
| S79 | 未知主题 fallback | theme:L19 | chrome-devtools | 设置 webui.theme="nonexistent", 刷新 | 加载失败无报错 + 默认色 | [ ] |
| S80 | codewhale 主题仍工作 | theme:L26 | chrome-devtools | 设置 webui.theme="codewhale", 刷新 | codewhale 配色生效 | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Application Shell Two-Column Layout | chat-app-shell ADDED | code-review | `packages/webui/web/src/components/AppShell.tsx` 存在 + 含 Sidebar/Main 2-col flex | [ ] |
| R2 | Sidebar Search Filters Conversations | chat-app-shell ADDED | unit-test | `SearchBox.test.tsx` + `ConversationList.test.tsx` 含 case-insensitive 过滤 | [ ] |
| R3 | New Conversation via pi --new-session | chat-app-shell ADDED | unit-test | `new-session.test.ts` 5+ 测试, 验证 spawn + UUID fallback | [ ] |
| R4 | Conversation List Item (hover trash, confirm, truncate) | chat-app-shell ADDED | unit-test | `ConversationList.test.tsx` 5+ 测试 | [ ] |
| R5 | Sticky Topbar in Main Region | chat-app-shell ADDED | code-review | `Topbar.tsx` 含 `sticky top-0 z-10` class | [ ] |
| R6 | Switch Session Clears Drafts | chat-app-shell ADDED | code-review | `ChatPage.tsx` useEffect on id change → setInputText("") + setInputImages([]) | [ ] |
| R7 | Webui Layout Two-Column (MODIFIED) | chat-app-shell MODIFIED | code-review | `App.tsx` 删 Layout(), 改用 AppShell | [ ] |
| R8 | Topbar Title with Message Count | chat-topbar ADDED | code-review | `Title.tsx` 含 messageCount prop + 渲染 "N messages" | [ ] |
| R9 | Model Selector with Dropdown | chat-topbar ADDED | unit-test | `ModelSelector.test.tsx` 5+ 测试 + PATCH /api/settings 调用 | [ ] |
| R10 | Topbar Clear and Settings Actions | chat-topbar ADDED | unit-test | `Actions.test.tsx` 含 confirm + Clear handler | [ ] |
| R11 | Three-Segment Assistant Message (MODIFIED) | chat-message-rendering MODIFIED | code-review | `MessageBubble.tsx` 渲染 MessageHeader + MessageParts + MessageFooter 三段 | [ ] |
| R12 | Token Formatting Utility (MODIFIED) | chat-message-rendering MODIFIED | unit-test | `format.test.ts` 6+ 测试 | [ ] |
| R13 | Relative Time Formatting (MODIFIED) | chat-message-rendering MODIFIED | unit-test | `format.test.ts` 4+ 时间测试 | [ ] |
| R14 | Server Returns Usage Per Message (MODIFIED) | chat-message-rendering MODIFIED | unit-test | `sessions-routes.test.ts` 含 usage 字段测试 + `usage-parser.test.ts` | [ ] |
| R15 | Image Block Inline Renders With Lightbox (MODIFIED) | chat-message-rendering MODIFIED | unit-test + code-review | `MessageParts.tsx` 含 ImagePart 渲染 + `Lightbox.tsx` 存在 | [ ] |
| R16 | Image Input via Paperclip Button | chat-image-input ADDED | unit-test | `ImageInput.test.tsx` 含 click → file input trigger | [ ] |
| R17 | Image Input via Drag and Drop | chat-image-input ADDED | unit-test | `ImageInput.test.tsx` 含 dragover/drop 测试 | [ ] |
| R18 | Image Input via Clipboard Paste | chat-image-input ADDED | unit-test | `ImageInput.test.tsx` 含 paste listener | [ ] |
| R19 | Image Validation | chat-image-input ADDED | unit-test | `image.test.ts` 4 拒绝分支测试 | [ ] |
| R20 | Image Preview With Remove | chat-image-input ADDED | unit-test | `ImagePreview.test.tsx` 缩略图 + X 删除 | [ ] |
| R21 | Send Prompt With Images | chat-image-input ADDED | unit-test | `ChatPage.test.tsx` WS send 验证 | [ ] |
| R22 | Prompt Message Images Field (MODIFIED) | webui-ws-protocol MODIFIED | unit-test | `ws-handler.test.ts` 4 验证测试 | [ ] |
| R23 | Server Stdin Content Array (MODIFIED) | webui-ws-protocol MODIFIED | unit-test | `session-pool.test.ts` content array 测试 | [ ] |
| R24 | GET Models Endpoint | webui-ws-protocol ADDED | unit-test | `models.test.ts` 2+ 测试 | [ ] |
| R25 | GET Settings Endpoint | webui-ws-protocol ADDED | unit-test | `settings.test.ts` 2+ 测试 | [ ] |
| R26 | PATCH Settings Endpoint | webui-ws-protocol ADDED | unit-test | `settings.test.ts` PATCH 测试 | [ ] |
| R27 | Hermes Theme (MODIFIED) | theme MODIFIED | code-review | `themes/hermes.json` 存在 + 8 color tokens | [ ] |
| R28 | Existing Themes Preserved (MODIFIED) | theme MODIFIED | code-review | `codewhale.json` 未改 + 主题加载逻辑无破坏 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S80) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R28) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果
