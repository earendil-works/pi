@h 1 Development Rules
@h 2 Conversational Style
@b Keep answers short and concise
@b No emojis in commits, issues, PR comments, or code
@b No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
@b Technical prose only, be direct
@b Use concise, clear, simple language. Define unavoidable jargon before using it.
@b Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
@b Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
@b When the user asks a question, answer it first before making edits or running implementation commands.
@b When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.
@h 2 Code Quality
@b Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
@b No `any` unless absolutely necessary.
@b Inline single-line helpers that have only one call site.
@b Check node_modules for external API types; don't guess.
@b **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
@b Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
@b Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
@b Always ask before removing functionality or code that appears intentional.
@b Do not preserve backward compatibility unless the user asks for it.
@b Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
@b Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.
@h 2 Commands
@b After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
@b Never run `npm run build` or `npm test` unless requested by the user.
@b Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
@b Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
@b `packages/tui` (`node:test`): `node --test test/specific.test.ts`
@b If you create or modify a test file, run it and iterate on test or implementation until it passes.
@b For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
@b Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
@b For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
@b Never commit unless the user asks.
@h 2 Dependency and Install Security
@b Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
@b When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
@b Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
@b If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
@b If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
@b Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.
@h 2 Git
@p Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:
@p Committing:
@b Only commit files YOU changed in THIS session.
@b Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
@b Before committing, run `git status` and verify you are only staging your files.
@b `packages/ai/src/models.generated.ts` may always be included alongside your files.
@b Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.
@p Never run (destroys other agents' work or bypasses checks):
@b `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.
@p If rebase conflicts occur:
@b Resolve conflicts only in files you modified.
@b If a conflict is in a file you did not modify, abort and ask the user.
@b Never force push.
@h 2 Issues and PRs
@p See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).
@p When reviewing PRs:
@b Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
@b Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
@b If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.
@p When creating issues:
@b Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.
@p When posting issue/PR comments:
@b Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
@b Keep comments concise, technical, in the user's tone.
@b End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).
@p When closing issues via commit:
@b Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.
@h 2 Testing pi Interactive Mode with tmux
@p Run the TUI in a controlled terminal (from the repo root):
@c bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
@c
@h 2 Changelog
@p Location: `packages/*/CHANGELOG.md` (one per package).
@p Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.
@p Rules:
@b All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
@b Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
@p Attribution:
@b Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
@b External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`
@h 2 Releasing
@p **Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.
@n **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.
@n **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
@p    ```bash
@p    npm run release:local -- --out /tmp/pi-local-release --force
@p    cd /tmp
@p    # Node package install smoke tests
@p    /tmp/pi-local-release/node/pi --help
@p    /tmp/pi-local-release/node/pi --version
@p    /tmp/pi-local-release/node/pi --list-models
@p    /tmp/pi-local-release/node/pi -p "Say exactly: ok"
@p    /tmp/pi-local-release/node/pi
@p    # Bun binary smoke tests
@p    /tmp/pi-local-release/bun/pi --help
@p    /tmp/pi-local-release/bun/pi --version
@p    /tmp/pi-local-release/bun/pi --list-models
@p    /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
@p    /tmp/pi-local-release/bun/pi
@p    ```
@p    Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.
@n **Run the release script**:
@p    ```bash
@p    PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
@p    PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
@p    ```
@p    Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.
@p    The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.
@n **CI verifies and announces the npm release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required. After publishing, `announce-pi-dev-release` verifies every public workspace package resolves at the exact release version and that its npm tarball is available, then writes the verified release marker to R2. `pi.dev/api/latest-version` reads that marker; it must never announce a release from npm before this job succeeds.
@n **If CI publish or announcement fails**: inspect the failed job. The publish helper is idempotent and skips package versions already present on npm; the announcement job rechecks availability before updating the R2 marker. Rerun the failed job or workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.
@h 2 User Override
@p If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
