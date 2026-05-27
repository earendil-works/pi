# 执行计划

## 任务列表

### Task 1: 创建 codewhale.json 主题文件
- **文件**: `~/.pi/agent/themes/codewhale.json`
- **内容**: 创建 CodeWhale 风格主题文件，包含深蓝品牌色 `#3578E5`、深墨蓝背景 `#0B1526`、语义颜色（success/error/warning）、语法高亮色（VS Code Dark+ 风格）
- **验证**: `npm run pi -- -p "hi" && /theme codewhale`，确认主题切换成功，颜色正确
- **依赖**: 无
- **状态**: [ ]
- **审查**: [ ]

### Task 2: 优化 Footer mode chip 显示
- **文件**: `packages/coding-agent/src/modes/interactive/components/footer.ts`
- **内容**: 在 Footer 第三行扩展状态前插入 mode chip：Plan 模式显示 `📋 Plan`（amber 色），Agent 模式显示 `🤖 Agent`（blue 色），默认显示 `🤖 Agent`。读取 `extensionStatuses` 中的 `plan-mode` 键判断当前模式
- **验证**: `npm run pi -- -p "hi"`，确认 Footer 第三行显示 mode chip
- **依赖**: Task 1
- **状态**: [ ]
- **审查**: [ ]

### Task 3: 优化 Tool 执行卡片背景色
- **文件**: `~/.pi/agent/themes/codewhale.json`（已在 Task 1 创建）
- **内容**: 确保 `toolPendingBg`（蓝色 `#0A1D3A`）、`toolSuccessBg`（绿色 `#0A2A0A`）、`toolErrorBg`（红色 `#2A0A0A`）在深蓝背景下有足够对比度
- **验证**: `npm run pi -- -p "hi"`，执行工具后确认卡片背景色正确
- **依赖**: Task 1
- **状态**: [ ]
- **审查**: [ ]

### Task 4: 优化 User 消息卡片背景色
- **文件**: `~/.pi/agent/themes/codewhale.json`（已在 Task 1 创建）
- **内容**: 确保 `userMessageBg`（深墨蓝 `#0B1526`）与 `userMessageText`（亮白 `#E0E0E0`）对比度 ≥ 4.5:1
- **验证**: `npm run pi -- -p "hi"`，发送消息后确认 user 消息有深蓝背景
- **依赖**: Task 1
- **状态**: [ ]
- **审查**: [ ]

## 验证策略
- 单元测试: 无（主题文件是 JSON 配置，无需单元测试）
- 集成测试: `npm run pi -- -p "hi"` 启动 TUI，手动验证视觉效果
- 安全检查: 无（纯视觉变更，不涉及安全敏感操作）
