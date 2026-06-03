# 变更提案: pi-webui-redesign

## 动机

参考 Hermes v0.34.3 的视觉与交互,重做 pi-webui 的左栏和聊天顶栏。当前的 2-column 极简布局 (200px 文本链接左栏 + 中间聊天) 在会话量上升后存在以下痛点:

1. 缺乏品牌区和应用图标,看起来像内部工具,辨识度低
2. 左栏没有搜索/过滤,会话多了 (用户已有 100+ session) 难以定位
3. 聊天顶栏信息密度低: 没有 inline 模型选择,没有 Clear 按钮,无 token 统计
4. 助手消息无头像/名字/时间戳,无法一眼分辨不同 turn
5. Token 用量不显示,无法评估对话成本和上下文长度
6. Cron/Atoms 占顶栏 tab,挤占视觉空间
7. 助手身份 (是 "pi" 还是 "Claude") 没有可识别的视觉锚点

参考图显示: Hermes 把 cron/atoms 移到了左栏 icon row,把 token 统计显示在每条助手消息底部,把模型选择器 inline 放在顶栏,把所有"控制"操作集中到左栏 + 顶栏,中间聊天区域纯净。

## 影响范围

- 新增 Capability:
  - `chat-conversation-management`: 多会话管理 (扁平列表/搜索/创建/删除),支持 inline 过滤
  - `chat-assistant-identity`: 助手身份显示 (字母头像 + 名字 + 相对时间戳 + 模型徽章)
  - `chat-token-stats`: 从 JSONL `entry.message.usage` 提取并聚合 token 用量,在消息底部展示
  - `chat-topbar-controls`: 聊天顶栏 control plane (模型 inline 选择器 + Clear 按钮 + Settings 占位)
  - `chat-app-shell`: 应用 shell (左栏 + 主区域),含品牌区 + icon row + 搜索 + 会话列表
  - `chat-image-input`: 图片输入 (file picker + 拖拽 + 粘贴 + 多图预览 + 发送为 image content part),支持 PNG/JPEG/GIF/WebP

- 修改 Capability:
  - `webui`: 整体布局 2-column (sidebar 260px 紧凑 + chat 居中),Cron 从顶栏 tab 移到左栏 icon row
  - `chat-message-rendering`: 助手消息从纯内容渲染升级为 "header (avatar/name/time/model) + body (parts) + footer (token stats)" 三段式
  - `chat-image-viewing`: (继承自 pi-webui-tool-rendering 归档的 ImagePart 规范) 图片消息 inline 渲染,多图横排,带 lightbox
  - `theme`: 沿用现有 themes 机制,新增 Hermes 风格配色 (左栏紧凑灰白 + 聊天温暖米白)
  - `webui-ws-protocol`: WS `prompt` 消息的 `images` 字段从 `string[]` 升级为 `{mediaType, data}[]`,单图 ≤ 5MB

- 删除 Capability:
  - (无功能删除,仅视觉/结构重构)

## 非目标

- 文件管理 / 右栏文件树 (用户明确排除)
- 非图片附件 (PDF/文档/压缩包) - 仅图片类型
- 语音输入、视频输入、模型多模态输出 (仅图片输入)
- 会话分组 (Pinned / Today) - 用户明确不要,扁平列表
- Token 实时估算 (只展示已生成消息的 usage,不预测未来)
- 自定义主题编辑器 (沿用现有 themes 目录,不改 themes API)
- 自托管分享/多用户/权限系统
- 端到端加密/审计日志
- 图片编辑 (裁剪/旋转/标注) - 仅上传原图
- 图片 OCR / 视觉分析标记 - 留给 pi core 处理

## 验收标准

### 左栏 (260px)
1. 顶部品牌区: 蓝色 "π" 字母 (24px) + "pi webui" (16px semibold) + "v0.X.Y" (10px gray) 三段式
2. icon row: 5 个 lucide 图标垂直排列 (MessageSquare / Clock / Brain / Folder / User),每个 18px,active 状态蓝色高亮
3. 搜索框: "Filter conversations..." placeholder,实时过滤会话列表 (大小写不敏感,匹配 title)
4. 会话列表: 扁平列表,每行 `truncate(title, 30)`,hover 时显示 Trash icon
5. 底部: "+ New conversation" 按钮 (蓝色,full-width)

### 聊天页顶栏
6. 左侧: 标题 (18px semibold) + 副标题 "N messages" (12px gray)
7. 右侧: 模型 inline 选择器 (蓝色徽章,点击下拉) + Clear 按钮 (灰) + Settings ⚙ (灰,占位,暂不打开)
8. 顶栏 sticky 在主区域顶部,scroll 不消失

### 助手消息结构
9. 头部: 圆形字母头像 (24px, 蓝色背景) + 名字 (14px semibold, "pi" 默认) + 相对时间戳 (12px gray, "2h ago" 格式) + 模型徽章 (10px, 灰底)
10. 主体: 沿用现有 MessageParts (ThinkingPart / ToolCallPart / ToolResultPart / ImagePart / TextPart)
11. 底部: token 统计 "X in · Y out" (10px gray),无 usage 时不渲染

### 行为
12. "+ New conversation" → server 调 `pi --mode rpc --new-session` (复用当前 cwd) → 返回新 sessionId → 跳转到 `/session/<id>`
13. 搜索框输入 → 客户端实时过滤,空时显示全部
14. Clear 按钮 → 清空当前会话消息 (本地状态,可选调 API,先仅前端)
15. 模型选择器切换 → 调 API 写入 `settings.json`,下次新建会话生效
16. Token 统计从 JSONL `entry.message.usage.{input,output}` 读取,聚合到消息级

### 图片输入 (新增)
17. 输入框左侧: Paperclip (📎) 图标按钮,点击打开文件选择器,只允许 image/* MIME 类型
18. 输入框区域: 拖拽图片到 textarea 区域,显示蓝色虚线高亮,松手后图片加入预览
19. 全局: Ctrl/Cmd+V 粘贴剪贴板图片,自动加入预览
20. 预览区: 输入框上方横向 flex 容器,每张图 80×80 缩略图 + 右上角 X 删除按钮,最多 4 张
21. 图片类型过滤: 只接受 `image/png|image/jpeg|image/gif|image/webp`,其他类型提示 "Unsupported image type"
22. 大小限制: 单图原始 ≤ 5MB (超过提示 "Image too large, max 5MB")
23. 发送: 文本 + 图片作为 content 数组 `[{type:"text",text}, {type:"image",mediaType,data}, ...]` 一起发到 pi core
24. 已发送图片: 在用户消息流中显示为小缩略图 (40×40) 在文本上方

### 图片查看 (从归档能力继承)
25. 助手/工具返回的图片: 自动 inline `<img src="data:${mediaType};base64,${data}">` 渲染,`max-h-96 object-contain`
26. 多张图片: 横向 flex-wrap 容器,间距 8px
27. 点击图片: 打开 lightbox 全屏查看,ESC 关闭,背景黑色 90% 透明
28. 大图 (>1MB base64): 仍 inline 渲染,使用 `loading="lazy"` 推迟加载
29. 工具结果中的 image content: 包含在 ToolResultPart 的 content 数组里,与文本混排

### 视觉
30. 沿用 themes/ 机制,新增 `hermes.json` 主题 (左栏 #f5f5f4 暖灰 + 聊天 #fafaf9 米白)
31. 所有交互 hover/focus 状态,圆角 6px,过渡 150ms
32. 字号阶梯 10/12/14/16/18px,无字重 italic
33. 间距阶梯 4/8/12/16/24px,严格 4 倍数

### 技术
34. 零 pi core 改动 (所有改动在 packages/webui/)
35. server 端需新增 `POST /api/sessions` 的 pi --new-session 路径 (可降级到 randomUUID 兼容)
36. server 端 `GET /api/sessions/:id/messages` 返回 `usage` 字段 (在 message envelope 上,不污染 parts)
37. 现有 MessageParts (从 pi-webui-tool-rendering 归档) 保留,新增 MessageHeader / MessageFooter 包装
38. WS `prompt` 消息: `images: {mediaType: string, data: string}[]` 替代现有 `string[]`,单图 ≤ 5MB,总大小 ≤ 20MB
39. session-pool.prompt: 透传完整 content 数组到 pi core (现有 `{type:"prompt", message, images:[]}` 升级为 `content: [{type, ...}]`)
40. 输入图片存储: 内存中,刷新即丢 (与 React state 同生命周期)
41. lightbox: 纯 portal + backdrop,无第三方库
42. 视觉参考图: Hermes v0.34.3 (用户已提供截图)
