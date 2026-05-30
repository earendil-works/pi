# 快速开始

[English](quickstart.md) | 简体中文

本页会带你从安装走到一次有用的 pi 会话。

## 安装

Pi 以 npm 包形式分发：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装期间禁用依赖生命周期脚本。Pi 的常规 npm 安装不需要安装脚本。

### 卸载

使用安装 pi 时所用的包管理器。curl 安装器使用全局 npm，因此 curl 和 npm 安装都用 npm 移除：

```bash
# curl installer or npm install -g
npm uninstall -g @earendil-works/pi-coding-agent

# pnpm
pnpm remove -g @earendil-works/pi-coding-agent

# Yarn
yarn global remove @earendil-works/pi-coding-agent

# Bun
bun uninstall -g @earendil-works/pi-coding-agent
```

卸载 pi 会保留 `~/.pi/agent/` 中的设置、凭据、会话和已安装的 pi packages。

然后在你希望 pi 处理的项目目录中启动它：

```bash
cd /path/to/project
pi
```

## 认证

Pi 可以通过 `/login` 使用订阅类 provider，也可以通过环境变量或 auth 文件使用 API-key provider。

### 选项 1：订阅登录

启动 pi 并运行：

```text
/login
```

然后选择 provider。内置订阅登录包括 Claude Pro/Max、ChatGPT Plus/Pro（Codex）和 GitHub Copilot。

### 选项 2：API key

启动 pi 前设置 API key：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

你也可以运行 `/login` 并选择 API-key provider，把 key 存到 `~/.pi/agent/auth.json`。

所有支持的 provider、环境变量和云 provider 设置见 [Providers](providers.md)。

## 第一次会话

pi 启动后，输入一个请求并按 Enter：

```text
Summarize this repository and tell me how to run its checks.
```

默认情况下，pi 会给模型四个工具：

- `read` - 读取文件
- `write` - 创建或覆盖文件
- `edit` - patch 文件
- `bash` - 运行 shell 命令

其他内置只读工具（`grep`、`find`、`ls`）可通过工具选项启用。Pi 在当前工作目录中运行，并可以修改其中的文件。如果你希望能轻松回滚，请使用 git 或其他 checkpoint 工作流。

## 给 pi 项目指令

Pi 启动时会加载上下文文件。添加 `AGENTS.md` 文件，告诉它如何在项目中工作：

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Pi 会加载：

- `~/.pi/agent/AGENTS.md` 作为全局指令
- 父目录和当前目录中的 `AGENTS.md` 或 `CLAUDE.md`

修改上下文文件后，请重启 pi，或运行 `/reload`。

## 常见尝试

### 引用文件

在编辑器中输入 `@` 可模糊搜索文件，也可以在命令行传入文件：

```bash
pi @README.md "Summarize this"
pi @src/app.ts @src/app.test.ts "Review these together"
```

图片可以用 Ctrl+V（Windows 上 Alt+V）粘贴，或拖入支持的终端。

### 运行 shell 命令

在交互模式中：

```text
!npm run lint
```

命令输出会发送给模型。使用 `!!command` 可以运行命令但不把输出加入模型上下文。

### 切换模型

使用 `/model` 或 Ctrl+L 选择模型。使用 Shift+Tab 循环 thinking level。使用 Ctrl+P / Shift+Ctrl+P 循环 scoped models。

### 之后继续

会话会自动保存：

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览之前的会话
pi --name "my task"    # 启动时设置会话显示名称
pi --session <path|id> # 打开特定会话
```

在 pi 内部，使用 `/resume`、`/new`、`/tree`、`/fork` 和 `/clone` 管理会话。

### 非交互模式

一次性 prompt：

```bash
pi -p "Summarize this codebase"
cat README.md | pi -p "Summarize this text"
pi -p @screenshot.png "What's in this image?"
```

使用 `--mode json` 输出 JSON 事件，或使用 `--mode rpc` 做进程集成。

## 下一步

- [使用 Pi](usage.zh-CN.md) - 交互模式、slash commands、会话、上下文文件和 CLI 参考。
- [Providers](providers.md) - 认证和模型设置。
- [Settings](settings.md) - 全局和项目配置。
- [Keybindings](keybindings.md) - 快捷键和自定义。
- [Pi Packages](packages.md) - 安装共享 extensions、skills、prompts 和 themes。

平台说明：[Windows](windows.md)、[Termux](termux.md)、[tmux](tmux.md)、[Terminal setup](terminal-setup.md)、[Shell aliases](shell-aliases.md)。
