# Development Rules

## Project Identity

PiQuest is a game-development-focused derivative of Pi, built on the Pi monorepo (currently plain upstream Pi, version 0.84.2). The goal is not to rewrite Pi or build a generic agent framework from scratch: preserve as much of upstream Pi as practical and add a game-development product layer on top.

- Long-term CLI identity is `piquest`, not `pi`. Do not perform a repository-wide Pi to PiQuest string replacement.
- Do not rename packages, binaries, config directories, or namespaces yet.
- Keep upstream mergeability a first-class concern. This repository should remain capable of absorbing upstream Pi changes.

## Architecture Boundaries

Three tiers, in decreasing order of mergeability with upstream.

### Upstream-owned packages

Keep these as close to upstream Pi as reasonably possible:

- `packages/agent`, `packages/ai`, `packages/tui`, `packages/client`, `packages/protocol`, `packages/server`, `packages/session-backends`, `packages/telemetry`, `packages/evals`

Do not introduce game-specific concepts into these packages unless there is a demonstrated architectural need.

### `packages/coding-agent`

This is the primary Pi integration surface. Prefer its public SDK, session APIs, extension APIs, tool factories, and presentation infrastructure:

- Programmatic SDK: `createAgentSession`, `createAgentSessionRuntime`, `createCodingTools` and per-tool factories in `src/core/sdk.ts`.
- Extension API (`src/core/extensions/types.ts`): register tools, commands, shortcuts, CLI flags, providers, message/entry renderers, markdown transformers. UI hooks include `setHeader`, `setFooter`, `setWidget`, `setStatus`, `setTheme`, `setTitle`, custom editors/overlays.
- Identity: `package.json` `piConfig` (name, configDir) already drives `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, env-var prefixes, and the terminal title (`src/config.ts`). A rebranded package automatically skips upstream-specific first-time-setup branding (`src/cli/startup-ui.ts`).
- Shipping resources: `package.json` `pi` manifest field lists extensions/skills/prompts/themes (`src/core/pi-manifest.ts`).
- Extensions load from `.pi/extensions/` (project), `~/.pi/agent/` (global), and packages; extension modules resolve bundled packages (`typebox`, `@earendil-works/pi-*`, `@earendil-works/pi-coding-agent`) via the loader's virtual modules.

Avoid scattering PiQuest conditionals throughout `packages/coding-agent`. Bad direction:

```
if (isPiQuest) ...
if (gameMode) ...
if (engine === "godot") ...
```

through many unrelated Pi files. Prefer explicit extension points and dependency injection.

### PiQuest-owned code

PiQuest-specific functionality lives in a future `packages/piquest/` package. This should eventually own: the `piquest` CLI entry point, PiQuest branding and presentation, game-development system behavior, project/game context, engine detection, engine adapters, game-specific tools, and run/playtest/verification workflows.

- Keep it one coherent package. Split into multiple packages only when real architectural pressure appears.
- Do not fork generic TUI primitives for PiQuest branding; compose above `@earendil-works/pi-tui`.
- Do not duplicate the entire Pi interactive UI; make presentation configurable and supply a PiQuest presentation layer.

## Upstream Policy

"Do not modify Pi core merely because a feature is game-development-related. First prove that the feature cannot cleanly live in PiQuest-owned code."

- Minimize edits to upstream-owned files.
- Keep PiQuest-specific code isolated.
- Avoid large cosmetic rewrites of inherited Pi code.
- Avoid unrelated formatting churn.
- Separate upstream/core refactors from PiQuest feature work when practical.
- Prefer small, reviewable integration patches.
- Preserve existing Pi behavior unless a PiQuest requirement explicitly changes it.
- Check whether an existing Pi extension point already solves a problem before modifying core code.
- Small upstream-friendly refactors are acceptable when necessary to expose clean extension points (for example, making branding/presentation configurable). Keep such extension points generic enough that they could plausibly be useful outside PiQuest, and document important deviations from upstream.

## Engine Policy

- Do not tightly couple PiQuest core to one engine.
- Engine-specific functionality lives behind explicit engine adapter boundaries.
- Prove the architecture with one engine before expanding. Unity is the first target. Do not add speculative multi-engine support.
- Do not select or implement an engine without a demonstrated need.

## Development Discipline

- Inspect before editing. Read files in full before wide-ranging changes.
- Follow existing repository conventions. Keep changes scoped to the current task.
- Do not redesign unrelated Pi systems.
- Do not create abstractions before they have a real caller.
- Avoid speculative multi-agent orchestration.
- Prefer tests for architectural boundaries and behavior.
- If a new `packages/piquest` package is created, it must satisfy the same root checks as every other package (see Commands) and be added to the root `package.json` workspaces and `tsconfig.json` `paths`.

## Conversational Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text.
- Technical prose only, be direct.
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Runs biome (with `--write`), pinned-dep/import/shrinkwrap/install-lock checks, `tsgo --noEmit`, and a browser smoke test. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
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
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent,piquest)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Testing Interactive Mode with tmux

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
- Do not create changelog entries when working on a branch other than `main`.

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes.

The upstream release flow (`scripts/release.mjs`, local smoke via `npm run release:local`, CI publish/announcement in `.github/workflows/build-binaries.yml`) is inherited from upstream Pi and assumes upstream infrastructure. Before publishing this fork:

- Revalidate the release scripts, npm package scope, OIDC publish environment, and announcement flow for PiQuest's own publishing targets.
- Do not assume `pi.dev`, R2 markers, or upstream npm accounts apply to PiQuest.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
