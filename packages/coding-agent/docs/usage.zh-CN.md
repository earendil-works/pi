# 使用 Pi

[English](usage.md) | 简体中文

本页汇总日常使用细节，这些内容不适合放在快速开始页中。

## 交互模式

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

界面有四个主要区域：

- **启动 header** - 快捷键、已加载的上下文文件、prompt templates、skills 和 extensions
- **Messages** - 用户消息、assistant 响应、工具调用、工具结果、通知、错误和扩展 UI
- **Editor** - 输入区域；边框颜色表示当前 thinking level
- **Footer** - 工作目录、会话名称、token/cache 使用量、成本、上下文使用量和当前模型

编辑器可以被 `/settings` 等内置 UI 临时替换，也可以被自定义扩展 UI 替换。

### 编辑器功能

| 功能 | 用法 |
|---------|-----|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter，或 Windows Terminal 上 Ctrl+Enter |
| 图片 | 用 Ctrl+V 粘贴，Windows 上 Alt+V，或拖入终端 |
| Shell 命令 | `!command` 运行命令并把输出发送给模型 |
| 隐藏 Shell 命令 | `!!command` 运行命令但不把输出发送给模型 |
| 外部编辑器 | Ctrl+G 打开 `$VISUAL` 或 `$EDITOR` |

所有快捷键和自定义方式见 [Keybindings](keybindings.md)。

## Slash Commands

在编辑器中输入 `/` 打开命令补全。扩展可以注册自定义命令，skills 会以 `/skill:name` 形式可用，prompt templates 会通过 `/templatename` 展开。

| 命令 | 说明 |
|---------|-------------|
| `/login`, `/logout` | 管理 OAuth 或 API-key 凭据 |
| `/model` | 切换模型 |
| `/scoped-models` | 启用/禁用用于 Ctrl+P 循环的模型 |
| `/settings` | Thinking level、主题、消息投递、传输方式 |
| `/resume` | 从之前的会话中选择 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置会话显示名称 |
| `/session` | 显示会话文件、ID、消息、tokens 和成本 |
| `/tree` | 跳到会话中的任意点并从那里继续 |
| `/fork` | 从之前的用户消息创建新会话 |
| `/clone` | 将当前活动分支复制为新会话 |
| `/compact [prompt]` | 手动压缩上下文，可附加自定义指令 |
| `/copy` | 将上一条 assistant 消息复制到剪贴板 |
| `/export [file]` | 将会话导出为 HTML |
| `/share` | 上传为私有 GitHub gist，并生成可分享的 HTML 链接 |
| `/reload` | 重新加载 keybindings、extensions、skills、prompts 和上下文文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 pi |

## 消息队列

agent 仍在工作时，你也可以提交消息：

- **Enter** 会排队一条 steering message，在当前 assistant turn 执行完工具调用后投递。
- **Alt+Enter** 会排队一条 follow-up message，在 agent 完成所有工作后投递。
- **Escape** 会中止并把排队消息恢复到编辑器。
- **Alt+Up** 会把排队消息取回编辑器。

在 Windows Terminal 中，Alt+Enter 默认是全屏快捷键。如果希望 pi 接收该快捷键，请按 [Terminal setup](terminal-setup.md) 中的说明重新映射。

可在 [Settings](settings.md) 中通过 `steeringMode` 和 `followUpMode` 配置投递方式。

## 会话

会话会自动保存到 `~/.pi/agent/sessions/`，并按工作目录组织。

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览并选择会话
pi --no-session        # 临时模式；不保存
pi --name "my task"    # 启动时设置会话显示名称
pi --session <path|id> # 使用特定会话文件或会话 ID
pi --fork <path|id>    # 将某个会话 fork 为新的会话文件
```

有用的会话命令：

- `/session` 显示当前会话文件和 ID。
- `/tree` 可在文件内会话树中导航，并能总结被放弃的分支。
- `/fork` 从更早的用户消息创建新会话。
- `/clone` 将当前活动分支复制为新会话文件。
- `/compact` 总结较早消息以释放上下文。

详情见 [Sessions](sessions.md) 和 [Compaction](compaction.md)。

## 上下文文件

Pi 启动时会从以下位置加载 `AGENTS.md` 或 `CLAUDE.md`：

- `~/.pi/agent/AGENTS.md`，作为全局指令
- 从当前工作目录向上遍历的父目录
- 当前目录

使用上下文文件记录项目约定、命令、安全规则和偏好。可用 `--no-context-files` 或 `-nc` 禁用加载。

### System Prompt 文件

用以下文件替换默认 system prompt：

- 项目中的 `.pi/SYSTEM.md`
- 全局的 `~/.pi/agent/SYSTEM.md`

如果只想追加到默认 prompt，而不是替换它，请在任一位置使用 `APPEND_SYSTEM.md`。

## 导出和分享会话

使用 `/export [file]` 将会话写入 HTML。

使用 `/share` 上传私有 GitHub gist，并生成可分享的 HTML 链接。

如果你把 pi 用于开源工作，并希望为模型、prompt、工具和评测研究发布会话，请参阅 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。它会把会话发布到 Hugging Face datasets。

## CLI 参考

```bash
pi [options] [@files...] [messages...]
```

### Package Commands

```bash
pi install <source> [-l]     # 安装 package，-l 表示项目本地安装
pi remove <source> [-l]      # 移除 package
pi uninstall <source> [-l]   # remove 的别名
pi update [source|self|pi]   # 更新 pi 和 packages；协调固定的 git refs
pi update --extensions       # 仅更新 packages；协调固定的 git refs
pi update --self             # 仅更新 pi
pi update --extension <src>  # 更新一个 package
pi list                      # 列出已安装 packages
pi config                    # 启用/禁用 package resources
```

这些命令管理 pi packages，而不是 pi CLI 安装。要卸载 pi 本身，请参阅[快速开始](quickstart.zh-CN.md#卸载)。

package 来源和安全说明见 [Pi Packages](packages.md)。

### 模式

| Flag | 说明 |
|------|-------------|
| default | 交互模式 |
| `-p`, `--print` | 打印响应并退出 |
| `--mode json` | 将所有事件输出为 JSON lines；见 [JSON mode](json.md) |
| `--mode rpc` | 通过 stdin/stdout 使用 RPC mode；见 [RPC mode](rpc.md) |
| `--export <in> [out]` | 将会话导出为 HTML |

在 print mode 中，pi 还会读取 piped stdin 并合并到初始 prompt：

```bash
cat README.md | pi -p "Summarize this text"
```

### 模型选项

| 选项 | 说明 |
|--------|-------------|
| `--provider <name>` | Provider，例如 `anthropic`、`openai` 或 `google` |
| `--model <pattern>` | 模型 pattern 或 ID；支持 `provider/id` 和可选的 `:<thinking>` |
| `--api-key <key>` | API key，覆盖环境变量 |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `--models <patterns>` | 用于 Ctrl+P 循环的逗号分隔 patterns |
| `--list-models [search]` | 列出可用模型 |

### 会话选项

| 选项 | 说明 |
|--------|-------------|
| `-c`, `--continue` | 继续最近的会话 |
| `-r`, `--resume` | 浏览并选择会话 |
| `--session <path\|id>` | 使用特定会话文件或部分 UUID |
| `--fork <path\|id>` | 将会话文件或部分 UUID fork 为新会话 |
| `--session-dir <dir>` | 自定义会话存储目录 |
| `--no-session` | 临时模式；不保存 |
| `--name <name>`, `-n <name>` | 启动时设置会话显示名称 |

### 工具选项

| 选项 | 说明 |
|--------|-------------|
| `--tools <list>`, `-t <list>` | 允许特定内置、扩展和自定义工具 |
| `--exclude-tools <list>`, `-xt <list>` | 禁用特定内置、扩展和自定义工具 |
| `--no-builtin-tools`, `-nbt` | 禁用内置工具，但保留扩展/自定义工具 |
| `--no-tools`, `-nt` | 禁用所有工具 |

内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。

### 资源选项

| 选项 | 说明 |
|--------|-------------|
| `-e`, `--extension <source>` | 从路径、npm 或 git 加载扩展；可重复 |
| `--no-extensions` | 禁用扩展发现 |
| `--skill <path>` | 加载 skill；可重复 |
| `--no-skills` | 禁用 skill 发现 |
| `--prompt-template <path>` | 加载 prompt template；可重复 |
| `--no-prompt-templates` | 禁用 prompt template 发现 |
| `--theme <path>` | 加载主题；可重复 |
| `--no-themes` | 禁用主题发现 |
| `--no-context-files`, `-nc` | 禁用 `AGENTS.md` 和 `CLAUDE.md` 发现 |

将 `--no-*` 和显式 flags 组合使用，可以只加载你需要的内容并忽略 settings。例如：

```bash
pi --no-extensions -e ./my-extension.ts
```

### 其他选项

| 选项 | 说明 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认 prompt；仍会追加上下文文件和 skills |
| `--append-system-prompt <text>` | 追加到 system prompt |
| `--verbose` | 强制显示详细启动信息 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

### 文件参数

给文件加 `@` 前缀可将其包含进消息：

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### 示例

```bash
# 带初始 prompt 的交互模式
pi "List all .ts files in src/"

# 非交互
pi -p "Summarize this codebase"

# 带 piped stdin 的非交互
cat README.md | pi -p "Summarize this text"

# 命名的一次性会话
pi --name "release audit" -p "Audit this repository"

# 不同模型
pi --provider openai --model gpt-4o "Help me refactor"

# 带 provider 前缀的模型
pi --model openai/gpt-4o "Help me refactor"

# 带 thinking level 简写的模型
pi --model sonnet:high "Solve this complex problem"

# 限制模型循环
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "Review the code"

# 禁用一个扩展或内置工具，同时保留其他工具
pi --exclude-tools ask_question
```

### 环境变量

| 变量 | 说明 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录；默认是 `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储目录；会被 `--session-dir` 覆盖 |
| `PI_PACKAGE_DIR` | 覆盖 package 目录，对 Nix/Guix store 路径有用 |
| `PI_OFFLINE` | 禁用启动时网络操作，包括更新检查、package 更新检查和安装/更新 telemetry |
| `PI_SKIP_VERSION_CHECK` | 跳过启动时的 Pi 版本更新检查。这会阻止对 `pi.dev` 最新版本的请求 |
| `PI_TELEMETRY` | 覆盖安装/更新 telemetry：`1`/`true`/`yes` 或 `0`/`false`/`no`。这不会禁用更新检查 |
| `PI_CACHE_RETENTION` | 对支持的 provider，设置为 `long` 可启用扩展 prompt cache |
| `VISUAL`, `EDITOR` | Ctrl+G 使用的外部编辑器 |

## 设计原则

Pi 保持核心很小，并把工作流特定行为推到 extensions、skills、prompt templates 和 packages 中。

它有意不内置 MCP、sub-agents、permission popups、plan mode、todos 或 background bash。你可以把这些工作流构建或安装为 extensions 或 packages，也可以使用 containers 和 tmux 等外部工具。

完整理由请阅读[这篇博客文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。
