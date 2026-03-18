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
| `packages/coding-agent/test/plan-mode-waves.test.ts` | Wave extraction tests (does NOT exist upstream) |
| `packages/coding-agent/test/plan-mode-utils.test.ts` | Extended utils tests (upstream has a smaller version) |

### Safe Upstream Sync Procedure

```bash
# 1. ALWAYS check what upstream changed before pulling
git fetch origin
git diff HEAD..origin/main --stat -- packages/coding-agent/examples/extensions/plan-mode/ packages/coding-agent/test/plan-mode-*

# 2. If upstream touched plan-mode files, back up first
git stash push -m "local-plan-mode" -- \
  packages/coding-agent/examples/extensions/plan-mode/ \
  packages/coding-agent/test/plan-mode-*.test.ts

# 3. Pull
git pull --rebase origin main

# 4. Restore local customizations
git stash pop
# Resolve any conflicts manually
```

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

### Agent Definitions (Safe)

Our 14 custom agents live in `~/.pi/agent/agents/` (outside the repo). They are NOT affected by upstream pulls: debug, devops, explore, frontend, librarian, memory, metis, momus, orchestrator, prometheus, reviewer, sentinel, tester, tla-precheck.

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
| Extensions directory | `/Users/besi/.pi/agent/extensions` |

Current extension directories:
- `model-fallback`
- `plan-mode`
- `pre-commit-gate`
- `quality-gate`
- `ralph`
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
