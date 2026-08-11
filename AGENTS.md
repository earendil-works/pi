# Development Rules

## Conversational Style

- Keep answers short/concise, no emojis in commits/issues/PRs/code.
- No fluff or cheerful filler (e.g., "Thanks @user" not "Thanks so much @user!").
- Define unavoidable jargon before using it.
- For non-trivial designs: state the problem, short example/trace, solution, and why it is necessary vs optional complexity.
- Prefer concrete behavior/small illustrations over abstract summaries, dense terms, or unexplained change lists.
- Answer the user's question before editing or running commands.
- When responding to feedback or an analysis, explicitly say whether you agree or disagree before describing what you changed.

## Code Quality

- Read files fully before wide-ranging changes, before editing uninvestigated files, and when asked to investigate or audit; do not rely on search snippets.
- No `any` unless absolutely necessary.
- Inline single-line helpers with one call site.
- Check `node_modules` for external API types; do not guess.
- Top-level imports only: no `await import()`, `import("pkg").Type`, or dynamic type imports.
- Do not remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- In `packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`, use only erasable TypeScript syntax (Node strip-only mode): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or constructs needing JS emit. Use explicit fields with constructor assignments.
- Ask before removing apparently intentional functionality.
- Do not preserve backward compatibility unless asked.
- Never hardcode key checks (e.g., `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.
- Never edit `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` and regenerate. Including the resulting diff is always OK.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors/warnings/infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested.
- Never run the full vitest suite directly; it includes e2e tests that activate when endpoint/auth env vars are present. For non-e2e tests, run `./test.sh` from repo root. Package-specific tests:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test, run it and iterate until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions in `packages/coding-agent/test/suite/regressions/<issue-number>-<short-slug>.test.ts`.
- Ad-hoc scripts: write to `/tmp` (or similar), run/edit/remove. Do not embed multi-line scripts in bash commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Pin external deps to exact versions.
- Read `undici` changelog/release notes for the target version and evaluate impact before updating.
- Local: `npm install --ignore-scripts`; clean/CI: `npm ci --ignore-scripts`. Do not run lifecycle scripts unless asked.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- Regen `packages/coding-agent/npm-shrinkwrap.json` with `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts need review and an allowlist entry; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Do not bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may run in this cwd concurrently. Git operations touching other sessions' files stomp their work. Follow these rules:

Committing:

- Only commit files you changed in this session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` or `git add .`.
- Before committing, run `git status` and verify only your files are staged.
- `packages/ai/src/models.generated.ts` may always be included.
- Commit format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>` (multi-line OK). Keep it informative/concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

Rebase conflicts:

- Resolve only in files you modified.
- If a conflict is in an unmodified file, abort and ask.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

Reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or move the worktree to the PR branch unless asked.
- Use `gh pr view`, `gh pr diff`, `gh api`, `git show`, and `git diff` against fetched refs to inspect PR metadata, commits, and patches without switching branches.
- Need PR file contents? Fetch/read them into temp files or use `git show <ref>:<path>` without switching branches.

Creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

Posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line from the originating prompt (e.g., `This comment is AI-generated by '/wr'`).

Closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` to auto-close on merge. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

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

`## [Unreleased]` sections: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- Append new entries to existing `## [Unreleased]` subsections after reading the section; never duplicate subsections.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External PRs: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask whether the user ran `/cl` on the latest `main` commit. If not, they must run `/cl` first to audit/update each package's `[Unreleased]` section.

2. **Local smoke test**: build an unpublished release and smoke-test from outside the repo (no workspace resolution):

```bash
npm run release:local -- --out /tmp/pi-local-release --force
cd /tmp

# Node
/tmp/pi-local-release/node/pi --help
/tmp/pi-local-release/node/pi --version
/tmp/pi-local-release/node/pi --list-models
/tmp/pi-local-release/node/pi -p "Say exactly: ok"
/tmp/pi-local-release/node/pi

# Bun
/tmp/pi-local-release/bun/pi --help
/tmp/pi-local-release/bun/pi --version
/tmp/pi-local-release/bun/pi --list-models
/tmp/pi-local-release/bun/pi -p "Say exactly: ok"
/tmp/pi-local-release/bun/pi
```

Verify Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. Run each bare command in tmux, submit a prompt, and wait for a model reply. Failures are release blockers unless the user accepts the risk.

3. **Run the release script**:

```bash
PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
```

Use `npm_config_min_release_age=0` only for the release command; the age gate can block lockfile refresh if the workspace version was published recently. Review lockfile/shrinkwrap diffs before pushing.

The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI verifies and announces the npm release**: pushing `vX.Y.Z` triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses GitHub Actions OIDC trusted publishing (env `npm-publish`); no local `npm publish`, `npm whoami`, OTP, or WebAuthn. After publishing, `announce-pi-dev-release` verifies every workspace package resolves and its tarball is available, then writes the verified release marker to R2. `pi.dev/api/latest-version` must not announce a release from npm before this succeeds.

5. **If CI publish or announcement fails**: inspect the failed job and rerun after fixing CI or transient npm issues. The publish helper is idempotent and skips package versions already on npm; the announcement job rechecks availability before updating the R2 marker. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
