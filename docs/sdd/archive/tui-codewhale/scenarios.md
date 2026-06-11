# 使用场景

## 正常流程

### 场景: 切换到 CodeWhale 主题
**GIVEN** Pi TUI 启动并显示默认 dark 主题
**WHEN** 用户输入 `/theme codewhale`
**THEN** TUI 切换到 CodeWhale 深蓝主题，所有颜色立即更新

### 场景: Footer 显示 mode chip
**GIVEN** Pi TUI 使用 CodeWhale 主题
**WHEN** Agent 处于 Plan 模式
**THEN** Footer 显示 "🔍 Plan" mode chip，颜色与 mode 匹配

### 场景: Footer 显示 Agent mode
**GIVEN** Pi TUI 使用 CodeWhale 主题
**WHEN** Agent 处于正常 Agent 模式
**THEN** Footer 显示 "🤖 Agent" mode chip

### 场景: User 消息卡片化
**GIVEN** Pi TUI 使用 CodeWhale 主题
**WHEN** 用户发送消息
**THEN** User 消息显示在深墨蓝背景卡片中，与 assistant 消息视觉区分明显

### 场景: Tool 执行卡片化
**GIVEN** Pi TUI 使用 CodeWhale 主题
**WHEN** Agent 执行工具（bash、文件操作等）
**THEN** Tool 执行结果显示在带状态色的卡片中（pending=蓝色, success=绿色, error=红色）

### 场景: 代码块在深蓝背景下可读
**GIVEN** Pi TUI 使用 CodeWhale 主题
**WHEN** Agent 输出包含代码块
**THEN** 代码块使用 VS Code Dark+ 风格语法高亮，在深蓝背景下清晰可读

### 场景: 扩展状态在 Footer 显示
**GIVEN** Pi TUI 使用 CodeWhale 主题，且有扩展注册了状态
**WHEN** Footer 渲染
**THEN** 扩展状态显示在 Footer 第三行，颜色与 mode chip 匹配

## 异常流程

### 场景: 主题文件格式错误
**GIVEN** `~/.pi/agent/themes/codewhale.json` 格式不合法
**WHEN** Pi 加载主题
**THEN** 回退到默认 dark 主题，控制台显示错误信息

### 场景: 主题缺少必需字段
**GIVEN** `codewhale.json` 缺少 `colors` 中的必需字段
**WHEN** Pi 校验主题
**THEN** 回退到默认 dark 主题，控制台显示缺失字段信息

### 场景: 不支持 truecolor 的终端
**GIVEN** 终端不支持 24-bit truecolor
**WHEN** Pi 使用 CodeWhale 主题
**THEN** 颜色自动降级到 256-color 模式，使用最近似的颜色

## 边界条件

### 场景: 极窄终端宽度
**GIVEN** 终端宽度 < 60 列
**WHEN** Footer 渲染
**THEN** Mode chip 和 stats 自动截断，不溢出

### 场景: 高对比度终端背景
**GIVEN** 终端背景色与主题背景色冲突（如白色背景）
**WHEN** Pi 使用 CodeWhale 主题
**THEN** 颜色仍然可读（深蓝文字在白色背景上对比度足够）

### 场景: 多个扩展同时显示状态
**GIVEN** 5 个扩展同时注册了 Footer 状态
**WHEN** Footer 渲染
**THEN** 所有状态在第三行显示，截断不溢出
