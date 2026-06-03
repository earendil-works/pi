# 使用场景: pi-webui-redesign

## 正常流程

### 场景: 启动后看到左栏品牌区
**GIVEN** 用户在 `~/.pi/agent` 跑 `pi --web`,浏览器打开 `http://127.0.0.1:8741/`
**WHEN** 页面加载完成
**THEN** 左侧 260px 栏顶部显示蓝色 "π" 字母 + "pi webui" 文字 + "v0.X.Y" 版本号三段式品牌区
**AND** 品牌区下方是 5 个 icon 垂直排列 (MessageSquare/Clock/Brain/Folder/User),其中 MessageSquare 处于 active 状态 (蓝色高亮)

### 场景: 列出当前 cwd 的所有会话
**GIVEN** `~/.pi/agent/sessions/--home-qjh-.pi-agent--/` 下有 17 个 session 文件
**WHEN** 用户首次打开页面
**THEN** 左栏会话列表显示 17 行,每行显示 `truncate(title, 30)`,按 lastActive 倒序
**AND** 第一行背景为蓝色高亮 (active session 标识)

### 场景: 搜索框过滤会话
**GIVEN** 会话列表显示 17 行,标题包含 "deploy"、"cron"、"memory" 等关键词
**WHEN** 用户在搜索框输入 "deploy"
**THEN** 列表实时过滤,只显示标题包含 "deploy" (大小写不敏感) 的会话行
**AND** 清空搜索框后恢复显示全部 17 行

### 场景: 切换到另一个会话
**GIVEN** 用户当前在会话 A,左栏选中状态在 A
**WHEN** 用户点击会话 B 那一行
**THEN** URL 变成 `/session/<B-id>`,主区域加载 B 的消息
**AND** 左栏 B 行变为蓝色高亮,A 行高亮消失
**AND** 会话 A 的输入草稿被丢弃 (切换即清空,无持久化)

### 场景: 创建新会话
**GIVEN** 用户在主页 (无 active session)
**WHEN** 用户点击左栏底部的 "+ New conversation" 按钮
**THEN** 浏览器 POST `/api/sessions` → server 调 `pi --mode rpc --new-session` → 返回新 sessionId
**AND** 浏览器跳转到 `/session/<新-id>`,主区域显示空聊天界面
**AND** 左栏会话列表顶部新增一行 (optimistic update),标题暂为 "New Chat"

### 场景: 删除会话
**GIVEN** 用户在会话 A
**WHEN** 用户 hover 到左栏 A 行,点击右侧 Trash icon,弹出 confirm 框
**AND** 用户点击 "OK"
**THEN** 浏览器 DELETE `/api/sessions/<A-id>`,server 调 `runMemoryExtraction` (fire-and-forget) 后删 JSONL 文件
**AND** 左栏 A 行立刻消失 (optimistic)
**AND** 浏览器跳转到主页 `/`

### 场景: 聊天页顶栏显示会话元数据
**GIVEN** 用户在会话 A,A 有 31 条消息
**WHEN** 页面加载完成
**THEN** 顶栏左侧显示 "Chat" (18px semibold) + "31 messages" (12px gray) 两段
**AND** 顶栏右侧显示模型徽章 (蓝色 "Claude Sonnet 4.6" 或当前模型) + Clear 按钮 (灰) + ⚙ 图标 (灰)

### 场景: 切换模型
**GIVEN** 用户在会话 A,顶栏显示当前模型 "Claude Sonnet 4.6"
**WHEN** 用户点击模型徽章,下拉显示所有可用 provider/model
**AND** 用户选择 "GPT-4o"
**THEN** 浏览器 PATCH `/api/settings`,写入 `webui.defaultModel = "openai/gpt-4o"` 到 `~/.pi/agent/settings.json`
**AND** 顶栏徽章立即更新为 "GPT-4o"
**AND** 当前会话模型不变 (设置只影响新建会话)

### 场景: Clear 按钮清空当前会话消息
**GIVEN** 用户在会话 A,有 31 条消息
**WHEN** 用户点击顶栏 Clear 按钮,弹出 confirm 框
**AND** 用户点击 "OK"
**THEN** 客户端 setMessages([]),不调 API (本地状态清除,刷新后消息还在)
**AND** 用户可以继续输入新消息

### 场景: 助手消息头部显示
**GIVEN** 会话中有一条 assistant 消息,来自 Claude Sonnet 4.6,时间戳 2 小时前
**WHEN** 消息渲染
**THEN** 消息上方显示: 蓝色圆形 "C" 头像 (24px) + "pi" 名字 (14px semibold) + "2h ago" 灰色时间戳 (12px) + "Claude Sonnet 4.6" 灰色模型徽章 (10px)

### 场景: 助手消息主体多 part 渲染
**GIVEN** 一条 assistant 消息包含 thinking + toolCall (read) + toolResult (16.9KB) + final text
**WHEN** 消息渲染
**THEN** 主体按 JSONL 顺序展示: 折叠的 "思考 (展开)" 块 → ToolGroup 容器 (含 read 卡片 + 16.9KB 结果) → 最终文本

### 场景: 助手消息底部 token 统计
**GIVEN** 一条 assistant 消息,JSONL `entry.message.usage` = `{input: 3100000, output: 9700}`
**WHEN** 消息渲染
**THEN** 消息底部右侧显示 "3.1M in · 9.7k out" (10px gray)
**AND** 无 usage 字段的旧消息不显示该行

### 场景: 发送纯文本消息
**GIVEN** 用户在输入框输入 "hello world"
**WHEN** 用户按 Enter (或点 Send)
**THEN** 输入框清空
**AND** 用户消息立即出现在主区域 (optimistic)
**AND** WS 发送 `{type:"prompt", text:"hello world", sessionId}`
**AND** pi core 处理后,assistant 消息通过 `message_end` 事件流回前端

### 场景: 点击 Paperclip 按钮选择图片
**GIVEN** 用户在输入框,左侧有 📎 图标按钮
**WHEN** 用户点击 📎 按钮
**THEN** 弹出文件选择器,accept=`image/png,image/jpeg,image/gif,image/webp`
**AND** 用户选择 `screenshot.png` (2MB, image/png)
**THEN** 输入框上方出现 80×80 缩略图,右上角 X 删除按钮
**AND** 缩略图显示 `data:image/png;base64,...` 即时预览

### 场景: 拖拽图片到输入框
**GIVEN** 用户在输入框,textarea 区域可拖拽
**WHEN** 用户从 Finder/Explorer 拖一张 `diagram.jpg` (1.5MB) 到输入框
**THEN** textarea 显示蓝色虚线高亮边框
**AND** 用户松手后,图片加入预览区,与已选图片横向排列
**AND** 文件读取为 base64 后显示缩略图

### 场景: 粘贴剪贴板图片
**GIVEN** 用户在输入框,系统剪贴板有一张截图 (Cmd+C from Preview)
**WHEN** 用户按 Cmd+V
**THEN** 图片自动加入预览区,显示缩略图
**AND** 不需要先点击输入框获取焦点 (全局监听)

### 场景: 删除已选图片
**GIVEN** 预览区有 2 张图片
**WHEN** 用户点击第 1 张图右上角的 X
**THEN** 该图立刻从预览区消失
**AND** 预览区剩下 1 张图

### 场景: 发送文本+图片
**GIVEN** 用户在输入框输入 "看这个",预览区有 1 张 `chart.png`
**WHEN** 用户按 Enter
**THEN** 输入框清空,预览区清空
**AND** 用户消息立即出现: 文本 "看这个" 上方有 40×40 缩略图
**AND** WS 发送 `{type:"prompt", text:"看这个", images:[{mediaType:"image/png", data:"<base64>"}], sessionId}`
**AND** pi core 接收 `content: [{type:"text", text:"看这个"}, {type:"image", mediaType, data}]`

### 场景: 助手返回图片 (tool result)
**GIVEN** 助手调用 read 工具读取本地 PNG,工具返回 image content
**WHEN** tool result 渲染
**THEN** 工具结果块内显示图片 `<img src="data:image/png;base64,..." max-h-96 object-contain>`
**AND** 与其他工具结果一样在 ToolGroup 容器内

### 场景: 助手返回多张图片
**GIVEN** 助手调用工具返回 3 张 PNG
**WHEN** 渲染
**THEN** 3 张图横排 (flex-wrap),间距 8px,每张 max-h-96
**AND** 浏览器使用 `loading="lazy"` 推迟加载

### 场景: 点击图片打开 lightbox
**GIVEN** 主区域有助手返回的图片
**WHEN** 用户点击图片
**THEN** 全屏显示图片,背景黑色 90% 透明 (backdrop)
**AND** 按 ESC 或点击背景关闭 lightbox
**AND** 关闭后焦点回到原图片

## 异常流程

### 场景: 搜索无结果
**GIVEN** 会话列表 17 行
**WHEN** 用户输入 "xyz123" (无匹配)
**THEN** 列表区显示 "No conversations match" (灰色文字)
**AND** 不显示任何会话行

### 场景: pi --new-session 失败降级
**GIVEN** server 端 `pi --new-session` 命令失败 (binary 不存在)
**WHEN** 用户点击 "+ New conversation"
**THEN** server 捕获错误,降级为 `randomUUID()` 模式创建空 session
**AND** 返回新 sessionId 给浏览器,行为一致
**AND** server log 打印 "pi --new-session failed, using UUID fallback"

### 场景: 图片类型不支持
**GIVEN** 用户拖拽一个 `document.pdf` 到输入框
**WHEN** 拖拽完成
**THEN** 输入框不加入预览,弹出 toast "Unsupported file type, only images"
**AND** 蓝色高亮边框消失

### 场景: 单图超过 5MB
**GIVEN** 用户选择 `huge.png` (8MB)
**WHEN** 文件读取完成
**THEN** 不加入预览,弹出 toast "Image too large, max 5MB"
**AND** 文件 input 清空,可重新选择

### 场景: 总图片超过 20MB
**GIVEN** 预览区已有 3 张图,共 18MB
**WHEN** 用户添加第 4 张 3MB 图
**THEN** 第 4 张图不加入预览 (累积超 20MB)
**AND** 弹出 toast "Total image size exceeds 20MB"

### 场景: 图片预览超过 4 张
**GIVEN** 预览区已有 4 张图
**WHEN** 用户尝试添加第 5 张 (无论从按钮/拖拽/粘贴)
**THEN** 第 5 张图不加入预览
**AND** 弹出 toast "Max 4 images per message"

### 场景: WS 断线
**GIVEN** 用户在会话 A,正在 stream
**WHEN** 网络中断,WebSocket 断开
**THEN** 顶栏状态点从绿变红
**AND** 客户端按指数退避自动重连 (1s, 2s, 4s, 5s, 5s, ...)
**AND** 重连后自动 resubscribe 当前 session

### 场景: 消息 JSONL 解析失败
**GIVEN** session JSONL 文件有一行损坏
**WHEN** GET /api/sessions/:id/messages
**THEN** server 跳过损坏行,返回剩余消息
**AND** 响应 200 (不是 500)

### 场景: model_change / thinking_level_change 等系统条目
**GIVEN** session JSONL 含 `type: "model_change"` 或 `type: "thinking_level_change"` 条目
**WHEN** 消息列表返回
**THEN** 这些条目被过滤,不作为 message 返回
**AND** 只保留 `type: "message"` 的真实消息

### 场景: 删除会话时 runMemoryExtraction 失败
**GIVEN** 用户删除会话 A,server 启动 runMemoryExtraction
**WHEN** LLM 调用超时或 settings 配置错误
**THEN** memory extraction 失败,console.warn 打印原因
**AND** session 文件依然被删除,DELETE 响应 200 {ok: true, atomsExtracted: 0}

### 场景: 用户消息含 image part 但 pi core 不支持
**GIVEN** WS 发送 image part 到 pi core
**WHEN** 当前模型不支持 vision (e.g. text-only model)
**THEN** pi core 忽略 image part 或报错 (不在 webui 控制范围)
**AND** webui 仍按原计划显示缩略图 (乐观 UI)

## 边界条件

### 场景: 空会话
**GIVEN** 用户新建会话,还没发任何消息
**WHEN** 页面加载
**THEN** 主区域显示 "Start a conversation" 居中文字 + 居中的输入框
**AND** "31 messages" 副标题显示 "0 messages"

### 场景: 极长会话 (10000+ 消息)
**GIVEN** 会话有 10000 条消息
**WHEN** 打开页面
**THEN** server 默认返回最新 200 条 (limit=200, offset=0)
**AND** 用户滚动到顶部时按需加载前一批 (虚拟滚动 / infinite scroll)
**AND** 浏览器 DOM 节点 ≤ 500 (虚拟化)

### 场景: Token 用量极大
**GIVEN** 一条消息 usage.input = 100,000,000 (1 亿)
**WHEN** 显示
**THEN** 格式化为 "100.0M in" (1 decimal, 不会显示 100000000)
**AND** 任何 input < 1000 显示 "N in" (无单位)
**AND** 1000 ≤ input < 1,000,000 显示 "N.NK in" (e.g. 1.5K)
**AND** 1,000,000 ≤ input < 1,000,000,000 显示 "N.NM in" (e.g. 3.1M)

### 场景: 极短标题
**GIVEN** 会话标题为空字符串
**WHEN** 显示
**THEN** 显示 "New Chat" (placeholder, 不显示空白)

### 场景: 极长标题
**GIVEN** 会话标题 200 字符
**WHEN** 显示
**THEN** truncate 到 30 字符 + "…" 省略号

### 场景: 模型徽章名称极长
**GIVEN** 当前模型 "claude-3-7-sonnet-20250219-v1:0"
**WHEN** 顶栏显示
**THEN** truncate 到 16 字符 + "..." (e.g. "claude-3-7-sonn...")

### 场景: 大量会话 (100+)
**GIVEN** 会话列表 150 行
**WHEN** 渲染
**THEN** 虚拟滚动,DOM 中只渲染可视区域 ± 10 行
**AND** 搜索时仍然遍历全量 (内存中过滤, 无需分页)

### 场景: 极小屏幕
**GIVEN** 浏览器窗口宽度 < 640px
**WHEN** 渲染
**THEN** 左栏默认隐藏,主区域占满
**AND** 顶栏出现汉堡按钮,点击展开左栏为 overlay

### 场景: 中文/emoji 标题
**GIVEN** 会话标题 "🚀 部署 v2.0 到 德国集群"
**WHEN** 显示
**THEN** 原样保留,不被 truncate 中间切断 (按字符截断)

### 场景: 图片 base64 含换行
**GIVEN** 用户选了一张 base64 中含换行的图 (少见,但 base64 标准允许)
**WHEN** 存储到 React state
**THEN** 去掉所有换行,纯 base64 字符串 (服务端可解析)

### 场景: 同一图片选两次
**GIVEN** 用户选过 `chart.png`,后删除,再次选同一文件
**WHEN** 添加
**THEN** 不去重,作为新项加入预览 (可能用户想重新引用)

### 场景: 切换会话时清空输入草稿
**GIVEN** 用户在 A 输入 "hello",切换到 B
**WHEN** 切到 B
**THEN** A 的输入草稿丢失 (无持久化,符合预期)
**AND** 切回 A 时输入框为空

### 场景: 助手消息无任何 part
**GIVEN** assistant 消息 content = []
**WHEN** 渲染
**THEN** 仍显示 header (avatar/name/time) + 空 body + 无 token footer
**AND** 不显示 "empty turn" 占位

### 场景: 助手消息仅有 thinking + tool,无 final text
**GIVEN** assistant 消息 content = [{type:"thinking",...}, {type:"toolCall",...}, {type:"toolResult",...}]
**WHEN** 渲染
**THEN** 头部 + 折叠的 thinking + ToolGroup 容器 (tool call + result)
**AND** 不显示空文本气泡 (符合归档的 "Empty assistant turn still renders" 场景)
