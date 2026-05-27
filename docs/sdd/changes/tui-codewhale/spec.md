# Delta Spec

## Capability: theme

### ADDED

#### Requirement: codewhale.json 主题文件
系统 SHALL 支持通过 `/theme codewhale` 切换到 CodeWhale 深蓝风格主题。

##### Scenario: 切换到 CodeWhale 主题
- **GIVEN** Pi TUI 启动并显示默认 dark 主题
- **WHEN** 用户输入 `/theme codewhale`
- **THEN** TUI 切换到 CodeWhale 深蓝主题，所有颜色立即更新

##### Scenario: 主题文件格式错误
- **GIVEN** `~/.pi/agent/themes/codewhale.json` 格式不合法
- **WHEN** Pi 加载主题
- **THEN** 回退到默认 dark 主题，控制台显示错误信息

##### Scenario: 不支持 truecolor 的终端
- **GIVEN** 终端不支持 24-bit truecolor
- **WHEN** Pi 使用 CodeWhale 主题
- **THEN** 颜色自动降级到 256-color 模式，使用最近似的颜色

### ADDED

#### Requirement: CodeWhale 品牌色系
系统 SHALL 使用 CodeWhale 品牌色 `#3578E5` 作为 accent 颜色，深墨蓝 `#0B1526` 作为主要背景色。

##### Scenario: 用户消息卡片化
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** 用户发送消息
- **THEN** User 消息显示在深墨蓝背景卡片中，与 assistant 消息视觉区分明显

##### Scenario: 工具执行卡片化
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 执行工具（bash、文件操作等）
- **THEN** Tool 执行结果显示在带状态色的卡片中（pending=蓝色, success=绿色, error=红色）

##### Scenario: 代码块在深蓝背景下可读
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 输出包含代码块
- **THEN** 代码块使用 VS Code Dark+ 风格语法高亮，在深蓝背景下清晰可读

## Capability: footer

### ADDED

#### Requirement: Footer mode chip
系统 SHALL 在 Footer 第三行显示当前模式 chip（Plan/Agent/YOLO），使用语义颜色。

##### Scenario: Footer 显示 mode chip
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 处于 Plan 模式
- **THEN** Footer 显示 "📋 Plan" mode chip，颜色为 amber

##### Scenario: Footer 显示 Agent mode
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 处于正常 Agent 模式
- **THEN** Footer 显示 "🤖 Agent" mode chip，颜色为 blue

##### Scenario: 极窄终端宽度
- **GIVEN** 终端宽度 < 60 列
- **WHEN** Footer 渲染
- **THEN** Mode chip 和 stats 自动截断，不溢出

##### Scenario: 多个扩展同时显示状态
- **GIVEN** 5 个扩展同时注册了 Footer 状态
- **WHEN** Footer 渲染
- **THEN** 所有状态在第三行显示，截断不溢出
