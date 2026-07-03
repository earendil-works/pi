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
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## WebUI deploy (manual copy required)

`packages/coding-agent/scripts/webui-update.sh` documents `npm run build` in `packages/coding-agent` as "copy webui artifacts", but the actual `build` script in `packages/coding-agent/package.json` only runs `tsgo + copy-assets` (theme/jsonl assets). It does **not** copy the webui bundle or frontend dist. After editing anything under `packages/webui/{src,server,web}`, the production webui at `http://127.0.0.1:8741` will not pick up the change unless you copy manually:

```bash
# 1. build webui (vite + esbuild)
(cd packages/webui && npm run build)

# 2. copy artifacts to the running prod location (script above does NOT do this)
cp packages/webui/dist/server.bundle.js packages/coding-agent/dist/webui/server.bundle.js
cp -r packages/webui/web/dist/. packages/coding-agent/dist/webui/web/

# 3. restart prod (the symlinked global `pi --web` reads dist/webui/ at startup)
bash packages/coding-agent/scripts/webui-restart.sh
```

Verify after restart: `curl -s http://127.0.0.1:8741/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'` should reflect the new bundle hash, and a sanity grep of the served JS should find your new strings.

If you only changed `web/`, step 2 only needs the second `cp` (frontend assets). If you only changed `server/`, only the first `cp` (server.bundle.js). The `index.html` references hashed asset names, so always re-copy `web/dist/` as a whole — partial copies leave the HTML pointing at deleted old hashes.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- **Native deps require a rebuild after `--ignore-scripts`.** `better-sqlite3` ships an `install` script (`prebuild-install || node-gyp rebuild --release`) that produces `node_modules/better-sqlite3/build/Release/better_sqlite3.node`. When `npm ci --ignore-scripts` runs, this script is skipped and the `.node` binding is missing — every DB operation then throws `MODULE_NOT_FOUND` and the webui returns HTTP 500. After any `--ignore-scripts` install/hydrate, run:
  ```bash
  cd node_modules/better-sqlite3 && npm run install
  ```
  Pre-built binaries (`lightningcss-linux-x64-gnu`, `sqlite-vec-linux-x64/vec0.so`, `@rolldown/binding-linux-x64-gnu`, `@rollup/rollup-linux-x64-gnu`, `@mariozechner/clipboard-linux-x64-gnu`) are unaffected by `--ignore-scripts` — only better-sqlite3 needs the rebuild.
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
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

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

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## Core Principles

- **门控只对有真实替代路径的工具生效**:引导 model 走 sub-tool 时,sub-tool 必须存在且比 bash 提供额外价值(原子 / 截断 / tracking);read/write/edit 满足,list/find/grep 不满足
- **门控建议的 sub-tool 名必须能在客户端解析**:不允许文案写 `tool="list"` 但实际工具叫 `ls`,或 `tool="ls"` 但工具未在 active 集合
- **权限分层由工具集决定,不重复在门控里**:local pi 用 `--tools read,grep,find,ls` 实现 read-only 模式,不在 bash hook 里二次过滤
- **Sub-tool 与 bash 的关系是 optional,不是强制**:sub-tool 存在时 model 可选用,不存在时 model 回退 bash;删除 sub-tool 不应导致 dead end

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

<!-- sddSpec:start -->
# sddSpec — Spec-Driven Development

This project uses **sddSpec** for structured changes through 6 phases:
brainstorm → plan → develop → review → release → archive.

## Commands

| Phase | Command | Output |
|-------|---------|--------|
| Start | `/change <name>` | New change dir + `.sdd.yaml` state |
| 1. Brainstorm | `/brainstorm <name>` | proposal / scenarios / principles / design |
| 2. Plan | `/write_plan <name>` | tasks + delta spec + verification checklist |
| 3. Develop | `/develop <name>` | TDD implementation via `@tdd-guide` |
| 4. Review | `/review <name>` | Checklist verification + code review |
| 5. Release | `/release <name>` | Simplify + security audit |
| 6. Archive | `/archive <name>` | Spec merge + archive |
| Quick fix | `/quickfix <name>` | Skip brainstorm for ≤3-file trivial fixes |
| Bug hunt | `/debug <bug-name>` | Root cause analysis + TDD fix |
| Auto | `/sdd <desc>` | Auto-detect current phase and route |

## Core Rules

- **Never write code** in brainstorm or write_plan — design first.
- **Never self-write code** in develop — dispatch `@tdd-guide`.
- **Never edit `.sdd.yaml` directly** — use `sdd-state.sh` or `sdd-guard.sh --apply`.
- **Reuse existing code** — `design.md` must list reused symbols with `path:line`, or declare greenfield.
- **GIVEN-WHEN-THEN** is mandatory for all scenarios.

## Where Things Live

- State: `docs/sdd/changes/<name>/.sdd.yaml`
- Main spec: `docs/sdd/specs/spec.md` (never moved)
- Change workdir: `docs/sdd/changes/<name>/`
- Archived: `docs/sdd/archive/<name>/`

<!-- sddSpec:end -->
1. **召回是优化, 故障必须降级不能停摆** — gate / rerank 是精度优化层, 任一故障跳过该层走老路径, 不阻塞 context 注入整体。
2. **gate 是 binary 决策不需要置信度** — `{need_memory}` 不带 confidence 也不产出 query, 边界情况一律偏向 false (压假阳性优先), 把判断责任交给 rerank。
3. **rerank 输出才是 format 的事实** — formatMemoryContext 接收 rerank_score 降序的 hit, RRF rrf 只作为同分时的 tie-breaker; 不再以 bge-m3 的 RRF 输出作为最终排序依据。
4. **gate 上下文最小化** — 仅取最近 2-3 条 user msg (不含 assistant), 不读 atom store, 不读 db; 上文场景识别靠对话短窗口, 不靠全 memory。
5. **threshold + gap 双重截断, 单一阈值不可** — threshold ≥0.5 防低分混入, gap >0.15 截在分界突变处; 任意单阈值都会有一类失败 (高阈值 leak 低, 低阈值 leak noise)。
6. **non-blocking 是 hard contract** — gate / rewrite / rerank 任何环节, 进 context hook 后默认异步 + timeout (gate 500ms, rewrite 5000ms, rerank 2000ms), 不得进 await critical path 之外; context hook 8s 总超时剩余的 4-7s 应留给 hybridSearch / format / modelRegistry 等。
7. **简单调用, 一个端点一个职责** — server.py 加 `/api/rerank`, 输入 `(query, hits[])` 输出 `[{id, score}]`, 不暴露 cross-encoder 模型自身参数 (threshold / gap 在客户端做, server 只返分); 客户端不下推截断策略到 server。
8. **不增加 schema 也不破坏向后兼容** — memory_vectors / memory_index schema 不动; `RecallResult` 加 `rerank_score?: number` 必须是 optional 字段, 老测试不破坏; `before_agent_start` hook 保留但仍能 skip-gate 流程入口。
9. **新模块单一 home** — gate 逻辑在 `extensions/personal-assistant/gate.ts`; rewrite 在 `extensions/personal-assistant/rewrite.ts`; merge 在 `extensions/personal-assistant/merge.ts`; rerank 客户端在 `extensions/personal-assistant/rerank.ts`; threshold/gap 在 rerank.ts 内部封装为 `rerankAndFilter()`, 不外溢到 search.ts / memory.ts。
