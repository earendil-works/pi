<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下项目慷慨捐赠：
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

> 新贡献者提交的新 issue 和 PR 默认会被自动关闭。维护者每天会审查自动关闭的 issue。请参阅 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

[English](README.md) | 简体中文

---

# Pi Agent Harness Mono Repo

这里是 pi agent harness 项目的主页，其中包含可自扩展的编码 agent。

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**：交互式编码 agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**：带工具调用和状态管理的 agent 运行时
* **[@earendil-works/pi-ai](packages/ai)**：统一的多提供商 LLM API（OpenAI、Anthropic、Google 等）

了解 pi：

* [访问 pi.dev](https://pi.dev)，查看带演示的项目网站
* [阅读文档](https://pi.dev/docs/latest)，也可以直接让 agent 解释它自己

## 分享你的开源编码 agent 会话

如果你在开源工作中使用 pi 或其他编码 agent，请分享你的会话。

公开的开源会话数据可以用真实任务、工具使用、失败和修复来改进编码 agent，而不是只依赖玩具基准。

完整说明见 [X 上的这篇帖子](https://x.com/badlogicgames/status/2037811643774652911)。

要发布会话，请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。请阅读它的 README.md 了解设置步骤。你只需要一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看[这个视频](https://x.com/badlogicgames/status/2041151967695634619)，其中展示了如何发布自己的 `pi-mono` 会话。

我会定期把自己的 `pi-mono` 工作会话发布在这里：

- [Hugging Face 上的 badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 所有包

| 包 | 说明 |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多提供商 LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 带工具调用和状态管理的 agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编码 agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 带差分渲染的终端 UI 库 |

Slack/聊天自动化和工作流请参阅 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat)。

## 贡献

贡献指南见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)，项目特定规则见 [AGENTS.md](AGENTS.md)（适用于人类和 agent）。

## 开发

```bash
npm install --ignore-scripts  # 安装所有依赖，不运行生命周期脚本
npm run build        # 构建所有包
npm run check        # 运行 lint、格式检查和类型检查
./test.sh            # 运行测试（没有 API key 时会跳过依赖 LLM 的测试）
./pi-test.sh         # 从源码运行 pi（可在任意目录运行）
```

## 供应链加固

我们把 npm 依赖变更视为需要审查的代码变更。

- 直接外部依赖会固定到精确版本。内部 workspace 包仍使用版本范围。
- `.npmrc` 设置了 `save-exact=true` 和 `min-release-age=2`，以避免 npm 解析到当天刚发布的依赖版本。
- `package-lock.json` 是依赖事实来源。除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`，否则 pre-commit 会阻止意外提交 lockfile。
- `npm run check` 会验证直接依赖固定、原生 TypeScript import 兼容性，以及生成的 coding-agent shrinkwrap。
- 发布的 CLI 包包含 `packages/coding-agent/npm-shrinkwrap.json`，它从根 lockfile 生成，用于为 npm 用户固定传递依赖。
- 发布冒烟测试使用 `npm run release:local`，在打标签发布前在仓库外构建、打包，并创建隔离的 npm 和 Bun 安装。
- 本地发布安装、文档中的 npm 安装，以及 `pi update --self` 会在支持时使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装依赖，并通过定时 GitHub workflow 运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- shrinkwrap 生成对依赖生命周期脚本有显式 allowlist；包含新生命周期脚本的依赖会导致检查失败，直到被审查。

## 许可证

MIT
