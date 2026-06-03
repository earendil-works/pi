# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Verify npm authentication**: run `npm whoami` before starting the release script. If it fails, stop and tell the user to run `npm login` manually first, then retry after they confirm `npm whoami` succeeds.

4. **Brief the user on the WebAuthn flow before running anything**. Print exactly the following message and then stop and wait for the user to confirm in their next message:

   ```
   Before the release publish step, read this carefully:

   - `npm publish` uses WebAuthn 2FA.
   - The safest flow is for you to run the publish command yourself, because you can see and open the npm authentication URL immediately.
   - I will tell you the exact command to run.
   - When npm prints an auth URL, cmd/ctrl-click it, log in in the browser, and select the "don't ask again for N minutes" option if available.
   - This may happen more than once during publish.
   - Do not rerun `npm run release:patch` or `npm run release:minor` after a failed publish; only rerun the publish command I give you.

   Reply "ready" once you have read this and are ready to run the command locally.
   ```

   Do not proceed to step 5 until the user explicitly confirms.

5. **Run the release script**:
   ```bash
   npm run release:patch    # fixes + additions
   npm run release:minor    # breaking changes
   ```
   Do not pass a `timeout` to the bash tool for this call. If publish fails during the WebAuthn/OTP step after version bump, stop and tell the user to run `npm run publish` themselves from the repo root. Never rerun the version bump on your own. After the user reports publish success, continue with the post-publish steps.

6. **After publish succeeds**:
   - Add fresh `## [Unreleased]` sections to package changelogs.
   - Commit with `Add [Unreleased] section for next cycle`.
   - Push `main` and the release tag.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

---

## TUI 主题原则

- TUI 视觉改进通过主题 JSON 文件实现，不修改默认主题。
- 新主题必须通过 `theme-schema.json` 校验，颜色值必须使用 hex 格式。
- Footer mode chip 使用语义颜色（Plan=amber, Agent=blue, YOLO=red），不使用随机色。
- 消息卡片背景色必须与文字色对比度 ≥ 4.5:1（WCAG AA）。

## Customization Guide

Extensions, Skills, Prompt Templates, Themes, Custom Models, and Custom Providers are documented in `docs/pi-custom-guide.md`.

## Core Principles

<!-- One-line principles accumulated from archived SDD changes. Source: docs/sdd/archive/*/principles.md -->

- pi 核心代码不被 WebUI 改动，WebUI 进程通过 RPC 模式（`pi --mode rpc`）与 pi 通信，所有交互都走 stdin/stdout JSON-line 协议。
- Session 状态完全归属 pi 进程（JSONL 文件 + pi 的 SessionManager），Web Server 只持内存中的 session 引用，重启后从磁盘扫描 `~/.pi/agent/sessions/` 恢复。
- 复用 `extensions/personal-assistant/cron.ts` 已有的 `cron_write` 工具（4-action），仅追加 `trigger_now` action 升级为 5-action；不新建独立的 cron 工具。
- 复用 `extensions/personal-assistant/memory.ts` 已有的 memory atoms 系统（SQLite FTS5）；Web Server 删除 session 时抽取的 atoms 直接写入 `memory.db`，不新建独立的 memory 文件。
- 记忆抽取必须使用现有的 7 种 atom 类型（constraint/preference/workflow/knowledge/event/solution/insight），不发明新的摘要结构。
- 记忆抽取失败不阻止删除（compaction 钩子会兜底），但要让用户知道被跳过了。
- 工具描述优先于 system prompt 描述来约束 cron 行为（如 schedule 必填、prompt 必填）—— "Adapt the tool to the agent, don't try to change the agent" 原则的延伸。
- Web Server 仅绑定 loopback（127.0.0.1），不暴露到公网，所有跨网络访问由用户在终端用 SSH tunnel / ngrok 自行解决。
- Web Server 退出时必须清理所有 spawn 的 pi 子进程（先 SIGTERM，超时 5s 后 SIGKILL），不留僵尸进程。
- WebUI 是单用户本地工具，不实现多账号/认证/权限系统。
- cron 触发依赖 pi 进程（session_start hook），不依赖 Web Server 在线；Web Server 仅做展示。
- Cron Dashboard 是 WebUI 的一级视图（独立路由 `/cron`），不是埋在某页的子模块；用户能直接打开表盘管理所有定时任务，把 cron jobs 当"代办"看待。
- Cron Dashboard 的所有读写直接对 `~/.pi/agent/data/cron.json` 操作，与 TUI/extension 共用单一数据源，无需通知/同步。
- WebUI 永远跑在调用 `pi --web` 时的父 cwd,不是 webui 包 cwd
- session 标题 = 第一条 user 消息的前 30 字符(创建时未知,首次发送后写定)
- DELETE 永远乐观:UI 不等后端 IO(LLM 抽 atoms 是 fire-and-forget,失败日志记录)
- 主路由 `/` 是 chat-first 布局,左栏常驻 session 列表,新对话是空状态
- WebUI 和 pi 子进程走真 RPC 协议(`message` 不是 `text`),任何字段名错配都让 prompt 静默失败
- 左栏是 control plane,主区域是 work plane;控制操作不侵占聊天空间
- 助手消息三段式恒成立: header (身份) + body (内容) + footer (成本);缺哪段就缺哪段,不发明第四段
- 图片是 content part,不是附件;和文本一起进同一个 `content` 数组
- 所有控制可逆且显式: 删除需 confirm,模型切换只影响新会话,Clear 仅前端
- 失败降级优于失败拒绝: `pi --new-session` 失败时降级 randomUUID,绝不阻塞用户操作
- Token 统计只展示已发生,绝不预测;格式统一为 `N.NK/M` 一档,绝不带逗号
- 输入图片生命周期 = 输入草稿生命周期;刷新即丢,不写盘不持久化
- 视觉密度优先: 左栏 260px 紧凑,主区域留白;字号严格 4 倍阶梯 |
