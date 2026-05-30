# Pi 文档

[English](index.md) | 简体中文

Pi 是一个极简的终端编码 harness。它的核心保持小而专注，并通过 TypeScript 扩展、skills、prompt templates、themes 和 pi packages 来扩展能力。

## 快速开始

使用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装期间禁用依赖生命周期脚本。Pi 的常规 npm 安装不需要安装脚本。

在 Linux 或 macOS 上，也可以使用安装脚本：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

要卸载 pi 本身，curl 和 npm 安装都使用 npm：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

如果使用 pnpm、Yarn 或 Bun 安装，请使用对应的全局移除命令：`pnpm remove -g @earendil-works/pi-coding-agent`、`yarn global remove @earendil-works/pi-coding-agent` 或 `bun uninstall -g @earendil-works/pi-coding-agent`。

然后在项目目录中运行：

```bash
pi
```

订阅类 provider 可使用 `/login` 认证；也可以在启动 pi 前设置 API key，例如 `ANTHROPIC_API_KEY`。

完整的首次运行流程见[快速开始](quickstart.zh-CN.md)。

## 从这里开始

- [快速开始](quickstart.zh-CN.md) - 安装、认证，并运行第一次会话。
- [使用 Pi](usage.zh-CN.md) - 交互模式、slash commands、上下文文件和 CLI 参考。
- [Providers](providers.md) - 内置 provider 的订阅和 API key 设置。
- [Settings](settings.md) - 全局和项目设置。
- [Keybindings](keybindings.md) - 默认快捷键和自定义快捷键。
- [Sessions](sessions.md) - 会话管理、分支和树形导航。
- [Compaction](compaction.md) - 上下文压缩和分支摘要。

## 自定义

- [Extensions](extensions.md) - 用于工具、命令、事件和自定义 UI 的 TypeScript 模块。
- [Skills](skills.md) - 可复用、按需调用的 Agent Skills。
- [Prompt templates](prompt-templates.md) - 可通过 slash commands 展开的可复用 prompts。
- [Themes](themes.md) - 内置和自定义终端主题。
- [Pi packages](packages.md) - 打包并共享 extensions、skills、prompts 和 themes。
- [Custom models](models.md) - 为受支持的 provider API 添加模型条目。
- [Custom providers](custom-provider.md) - 实现自定义 API 和 OAuth 流程。

## 编程式使用

- [SDK](sdk.md) - 在 Node.js 应用中嵌入 pi。
- [RPC mode](rpc.md) - 通过 stdin/stdout JSONL 集成。
- [JSON event stream mode](json.md) - 带结构化事件的 print mode。
- [TUI components](tui.md) - 为扩展构建自定义终端 UI。

## 参考

- [Session format](session-format.md) - JSONL 会话文件格式、条目类型和 SessionManager API。

## 平台设置

- [Windows](windows.md)
- [Android 上的 Termux](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## 开发

- [Development](development.md) - 本地设置、项目结构和调试。
