# 变更提案: tui-codewhale

## 动机

Pi 的 TUI 视觉质量低于 CodeWhale（前 DeepSeek-TUI）的标准。用户希望将 CodeWhale 的现代深蓝主题美学引入 Pi 的 TUI，通过主题配色、Footer 优化和消息卡片化提升整体视觉体验。

CodeWhale 的设计特点：
- 深蓝品牌色 `#3578E5` + 深墨蓝背景 `#0B1526`
- Footer 有 mode chip（Plan/Agent/YOLO）和更好的层次感
- 消息卡片化：user/tool 消息有独立背景色，视觉区分明显

## 影响范围

- 新增 Capability: codewhale.json 自定义主题文件
- 修改 Capability: FooterComponent（mode chip、更好的层次感）
- 修改 Capability: UserMessageComponent / ToolExecutionComponent（消息卡片背景色）
- 修改 Capability: Theme 颜色定义（新增 codewhale 主题）

## 非目标

- 不新增 Sidebar 面板（tasks/agents/context tabs）
- 不新增 Header 组件（token bar + cost + whale 动画）
- 不重构 TUI 布局（保持单列滚动）
- 不改变现有功能（只美化视觉）

## 验收标准

- Pi TUI 启动后可通过 `/theme codewhale` 切换到 CodeWhale 风格主题
- Footer 显示 mode chip（Plan/Agent/YOLO），视觉层次更清晰
- User/Tool 消息有独立背景色，视觉区分明显
- 语法高亮和代码块在深蓝背景下可读
- 所有现有功能正常（session、model 切换、thinking level、扩展 widget）
