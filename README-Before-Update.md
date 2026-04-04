<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="pi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# Pi Monorepo

> **Looking for the pi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-mom](packages/mom)** | Slack bot that delegates messages to the pi coding agent |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Local Customizations (IMPORTANT)

This is a fork of `aeitroc/pi-mono`. We maintain local customizations that live **inside the repo tree** but are NOT committed upstream. These files will be overwritten by `git pull` if upstream touches the same paths — or destroyed by force pushes.

### Custom Plan-Mode Extension (Prometheus)

The upstream repo ships a basic plan-mode example at `packages/coding-agent/examples/extensions/plan-mode/`. We replaced it with a full Prometheus 3-phase orchestrator. See the [plan-mode README](packages/coding-agent/examples/extensions/plan-mode/README.md) for architecture details.

**Custom files at risk during upstream sync:**

| Path | Description |
|------|-------------|
| `packages/coding-agent/examples/extensions/plan-mode/index.ts` | Full orchestrator (~1000 lines, upstream is ~300) |
| `packages/coding-agent/examples/extensions/plan-mode/utils.ts` | Extended utilities (~700 lines, upstream is ~130) |
| `packages/coding-agent/examples/extensions/plan-mode/phases.ts` | State machine + intent classification (does NOT exist upstream) |
| `packages/coding-agent/examples/extensions/plan-mode/prompts.ts` | Prometheus prompts for all phases (does NOT exist upstream) |
| `packages/coding-agent/examples/extensions/plan-mode/plan-mode-overview.*` | Architecture diagrams (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-phases.test.ts` | Intent/clearance/verdict tests (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-complexity.test.ts` | Complexity heuristic tests (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-slash-bypass.test.ts` | Slash command bypass tests (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-verification.test.ts` | Tool audit + verification tests (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-execution-ui.test.ts` | Execution UI regression tests for hidden dispatch messages and full todo rendering (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-waves.test.ts` | Wave extraction tests (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-utils.test.ts` | Extended utils tests (upstream has a smaller version) |

### Custom Interactive Subagent Extension (Phase 1)

On 2026-03-18 we extended the example `subagent` extension with pane-based iteration and resume support. This work is local customization and is also at risk during upstream syncs.

**Custom files at risk during upstream sync:**

| Path | Description |
|------|-------------|
| `packages/coding-agent/examples/extensions/subagent/index.ts` | Local extension now includes `/iterate`, `subagent_resume`, and `set_tab_title` |
| `packages/coding-agent/examples/extensions/subagent/cmux.ts` | New mux helper for cmux, tmux, and zellij (does NOT exist upstream) |
| `packages/coding-agent/examples/extensions/subagent/session.ts` | New session readers for resume/summary extraction (does NOT exist upstream) |
| `packages/coding-agent/examples/extensions/subagent/subagent-done.ts` | New pane-session shutdown helper (does NOT exist upstream) |
| `packages/coding-agent/test/subagent-extension.test.ts` | Extension registration regression test (does NOT exist upstream) |
| `packages/coding-agent/test/subagent-session.test.ts` | Session helper regression tests (does NOT exist upstream) |

**Runtime links outside git:**

These symlinks were added under `~/.pi/agent/extensions/subagent/` so the installed local pi runtime can resolve the new helper modules:

- `/Users/besi/.pi/agent/extensions/subagent/index.ts`
- `/Users/besi/.pi/agent/extensions/subagent/agents.ts`
- `/Users/besi/.pi/agent/extensions/subagent/cmux.ts`
- `/Users/besi/.pi/agent/extensions/subagent/session.ts`
- `/Users/besi/.pi/agent/extensions/subagent/subagent-done.ts`

These symlinks are **not** managed by git. A repo pull does not delete them. They only break if the target repo files are moved, deleted, or renamed.

### Custom Model Profile Switcher

On 2026-03-19 we added a named profile switcher so the main session model, `enabledModels`, subagent `model:` fields, and fallback targets can move together.

**Custom files at risk during upstream sync:**

| Path | Description |
|------|-------------|
| `packages/coding-agent/examples/extensions/profile-switcher/index.ts` | `/profile <name>` command plus `--profile <name>` startup flag |
| `packages/coding-agent/examples/extensions/profile-switcher/profiles.ts` | Profile parsing, default profile generation, and agent-frontmatter rewrite helpers |
| `packages/coding-agent/test/profile-switcher.test.ts` | Profile extension regression tests |

**Runtime files outside git:**

- `/Users/besi/.pi/agent/profiles.json`
- `/Users/besi/.pi/agent/extensions/profile-switcher/index.ts`
- `/Users/besi/.pi/agent/extensions/profile-switcher/profiles.ts`
- `/Users/besi/.pi/agent/extensions/model-fallback/index.ts`
- `/Users/besi/.pi/agent/settings.json`

Practical answer:

- A repo pull does **not** delete `~/.pi/agent/profiles.json` or the `profile-switcher` symlinks.
- If upstream touches the repo-owned `profile-switcher` files, re-merge those changes and then re-check the symlink targets under `~/.pi/agent/extensions/profile-switcher/`.
- The live fallback behavior now depends on `profiles.json`. If that file is malformed, the fallback extension drops back to its hardcoded default target.

Current live profile packs:

| Profile | Main model | Specialist routing |
|------|-------------|--------------------|
| `openai` | `factory-openai/gpt-5.4:xhigh` | `devops`, `frontend`, `librarian` -> `claude-opus-4-6`; `explore` -> `gpt-5.3-codex-spark`; `memory` -> `gpt-5.4-mini`; everything else -> `gpt-5.4` |
| `anthropic` | `factory-openai/claude-opus-4-6:xhigh` | `explore`, `memory` -> `claude-sonnet-4-6`; `reviewer`, `sentinel`, `tester`, `tla-precheck` -> `gpt-5.4`; everything else -> `claude-opus-4-6` |

Model registry note:

- `~/.pi/agent/models.json` now also includes `claude-sonnet-4-6`.
- If that model entry disappears, `/profile anthropic` will fail validation instead of applying partially.

### Custom Interactive Widget Rendering

On 2026-03-18 we also changed the interactive renderer so long plan todo widgets no longer hard-truncate after 10 lines. This is a repo customization outside the extension directories, so it needs its own recovery note.

**Custom files at risk during upstream sync:**

| Path | Description |
|------|-------------|
| `packages/coding-agent/src/core/extensions/types.ts` | Widget API now supports `maxLines?: number | null` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Renderer now allows per-widget opt-out from truncation |
| `packages/coding-agent/test/interactive-mode-widgets.test.ts` | Regression test for renderer truncation behavior (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-execution-ui.test.ts` | Plan-mode regression test now also proves full todo rendering |

Practical answer:

- If upstream changes `interactive-mode.ts` or `types.ts`, long plan todo lists may truncate again until the local renderer changes are re-merged.
- `/reload` is **not** enough for this customization because the truncation behavior lives in the interactive renderer, not just the extension layer. Restart `pi` from the updated repo/build after syncing.

### Safe Upstream Sync Procedure

```bash
# 1. ALWAYS check what upstream changed before pulling
git fetch origin
git diff HEAD..origin/main --stat -- \
  packages/coding-agent/examples/extensions/plan-mode/ \
  packages/coding-agent/test/plan-mode-* \
  packages/coding-agent/examples/extensions/subagent/ \
  packages/coding-agent/test/subagent-* \
  packages/coding-agent/examples/extensions/profile-switcher/ \
  packages/coding-agent/test/profile-switcher.test.ts \
  packages/coding-agent/src/core/extensions/types.ts \
  packages/coding-agent/src/modes/interactive/interactive-mode.ts \
  packages/coding-agent/test/interactive-mode-widgets.test.ts

# 2. If upstream touched plan-mode or subagent files, back up first
git stash push -m "local-pi-customizations" -- \
  packages/coding-agent/examples/extensions/plan-mode/ \
  packages/coding-agent/test/plan-mode-*.test.ts \
  packages/coding-agent/examples/extensions/subagent/ \
  packages/coding-agent/test/subagent-*.test.ts \
  packages/coding-agent/examples/extensions/profile-switcher/ \
  packages/coding-agent/test/profile-switcher.test.ts \
  packages/coding-agent/src/core/extensions/types.ts \
  packages/coding-agent/src/modes/interactive/interactive-mode.ts \
  packages/coding-agent/test/interactive-mode-widgets.test.ts \
  README-Before-Update.md

# 3. Pull
git pull --rebase origin main

# 4. Restore local customizations
git stash pop
# Resolve any conflicts manually

# 5. Verify the live runtime symlinks still resolve
ls -l /Users/besi/.pi/agent/extensions/subagent
```

### Will A Repo Update Break The 2026-03-18 Subagent Work?

Usually: **no silent breakage**, but there are 3 concrete risks:

1. If you pull while these local repo changes are still uncommitted, `git pull --rebase` may stop with conflicts or refuse to continue. That is good. It means git protected the local work instead of overwriting it.
2. If upstream changes the same `packages/coding-agent/examples/extensions/subagent/*` files, you will need to re-merge our local changes into the new upstream version.
3. If upstream renames or removes the repo files that the live symlinks point to, the installed runtime at `~/.pi/agent/extensions/subagent/` will fail to load until the symlinks are refreshed.

Practical answer:

- A normal repo update does **not** automatically break this change.
- The main risk is merge conflict, not silent loss.
- The only outside-git part to re-check after an update is the `~/.pi/agent/extensions/subagent/*.ts` symlink set.
- The profile switcher also adds a second symlink set at `~/.pi/agent/extensions/profile-switcher/*.ts` plus the live file `~/.pi/agent/profiles.json`.

For the widget-rendering customization, also re-check:

- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/test/interactive-mode-widgets.test.ts`

### If Files Were Already Lost

Pi-rewind captures worktree snapshots including uncommitted changes. Recovery:

```bash
# Find snapshots
git log --all --oneline | grep pi-rewind | head -10

# Check if a snapshot has our files
git show <commit>  # Look for worktree-tree hash in commit message
git ls-tree -r <worktree-tree-hash> -- packages/coding-agent/examples/extensions/plan-mode/ | grep phases

# Recover a file from its blob
git cat-file -p <blob-hash> > packages/coding-agent/examples/extensions/plan-mode/phases.ts
```

### Incident Log

| Date | What happened | Impact | Recovery |
|------|--------------|--------|----------|
| 2026-03-18 | Upstream force-pushed main. `git pull --rebase` overwrote index.ts, utils.ts, README.md with vanilla versions. phases.ts/prompts.ts deleted. | Lost full Prometheus orchestrator + 6 test files | Recovered from pi-rewind worktree snapshot |

### Agent Definitions And Prompt Pack (Safe)

Our 15 custom agents live in `~/.pi/agent/agents/` (outside the repo). They are NOT affected by upstream pulls: backend, debug, devops, explore, frontend, librarian, memory, metis, momus, orchestrator, prometheus, reviewer, sentinel, tester, tla-precheck.

Prompt integrity notes:

- `~/.pi/agent/agents/prometheus.md` is now only a compatibility prompt for direct subagent use. The real interactive planner remains `packages/coding-agent/examples/extensions/plan-mode/prompts.ts`.
- `backend` is now part of the live local agent roster, and the repo-side execution prompt knows to route server-side work to it.
- `memory`, `metis`, `frontend`, `tla-precheck`, `librarian`, `momus`, `sentinel`, and `tester` were cleaned up so their prompt instructions match their real tool contracts more closely.

### Local Pi Installation Snapshot (2026-03-18)

This section tracks the local pi runtime outside the repo so future recovery/sync work has complete context.

| Item | Value |
|------|-------|
| Install root | `/Users/besi/.pi` |
| Runtime root | `/Users/besi/.pi/agent` |
| Runtime AGENTS file | `/Users/besi/.pi/agent/AGENTS.MD` -> `/Users/besi/.claude/CLAUDE.md` (symlink) |
| Settings file | `/Users/besi/.pi/agent/settings.json` |
| Installed packages (`settings.json > packages`) | `npm:pi-mcp-adapter`, `npm:pi-rewind`, `https://github.com/davebcn87/pi-autoresearch` |
| Installed `pi-autoresearch` checkout | `/Users/besi/.pi/agent/git/github.com/davebcn87/pi-autoresearch` |
| Agent specs directory | `/Users/besi/.pi/agent/agents` |
| Current custom agent count | `15` |
| Models registry | `/Users/besi/.pi/agent/models.json` |
| Extra local model | `claude-sonnet-4-6` |
| Profiles registry | `/Users/besi/.pi/agent/profiles.json` |
| Extensions directory | `/Users/besi/.pi/agent/extensions` |
| Active model profile | `openai` |
| Startup presentation | `quietStartup: true` plus `startup-ascii` extension |
| Subagent extension symlinks | `agents.ts`, `cmux.ts`, `index.ts`, `session.ts`, `subagent-done.ts` |
| Profile-switcher symlinks | `index.ts`, `profiles.ts` |
| Fallback policy source | `~/.pi/agent/profiles.json > activeProfile > fallbackTargets` |

Current extension directories:
- `model-fallback`
- `plan-mode`
- `pre-commit-gate`
- `profile-switcher`
- `quality-gate`
- `ralph`
- `startup-ascii`
- `subagent`

Maintenance rule:
- When anything in `/Users/besi/.pi/agent/settings.json`, `/Users/besi/.pi/agent/agents/`, or `/Users/besi/.pi/agent/extensions/` changes, update this section and [`AGENTS.md`](AGENTS.md) in the same task.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
