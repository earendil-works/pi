<!-- OSS_WEEKEND_START -->
# 🏖️ OSS Weekend

**Issue tracker reopens Monday, April 20, 2026.**

OSS weekend runs Monday, April 13, 2026 through Monday, April 20, 2026. New issues and PRs from unapproved contributors are auto-closed during this time. Approved contributors can still open issues and PRs if something is genuinely urgent, but please keep that to pressing matters only. For support, join [Discord](https://discord.com/invite/3cU7Bz4UPx).
<!-- OSS_WEEKEND_END -->

---

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

## Share your OSS coding agent sessions

If you use pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

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

## Fork Features (LLMpsycho)

This fork adds the following on top of upstream pi:

### Factory Model Integration
Load models from [Factory](https://factory.ai) settings (`~/.factory/settings.json`) automatically. Factory `customModels` appear alongside built-in models and are selectable via `/models` or `--model factory/<name>`. Per-model API keys are resolved from the Factory config — no extra env vars needed.

### Subagent System
A subagent extension that spawns isolated `pi` processes for delegated tasks. Supports single, parallel (up to 8), and chained (sequential with `{previous}` handoff) execution modes. Available agents are injected into the system prompt so the LLM can use them proactively.

**Installed agents:** api-designer, backend, debug, devops, explore, frontend, librarian, memory, metis, momus, oracle, prometheus, reviewer, sentinel, tdd-orchestrator, tdd-test-writer, tla-precheck.

### Plan Mode with Subagent Pipeline
`/plan <task>` runs a planning pipeline via subagents:
1. **metis** — intent analysis, risk identification, planning directives
2. **prometheus** — executable work plan with atomic tasks and dependencies
3. **momus** — plan review, loops until approved (up to 3 cycles)

Once approved, the plan is presented for execution with step tracking (`[DONE:n]` markers).

### Memory Hooks
A `memory-hooks` extension that connects session lifecycle to a Neo4j palace-structured knowledge graph:
- **On shutdown** — analyzes the session for save-worthy context (code changes, bug fixes, new features). If the session contained meaningful work, writes a Memory node into the palace graph with Wing/Room/Hall/Drawer structure and automatic cross-project tunneling.
- **On session start** — on the first user message of a new session, extracts keywords from the prompt and queries Neo4j for related memories. Matched memories are injected into the system prompt so the agent starts with relevant project context.

Connects via Neo4j HTTP API (port 7474). Configure with `NEO4J_HTTP_URL`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` env vars.

### Profile Switcher
Named model profiles that move the main session model, subagent routing, and fallback targets together. `/profile <name>` switches between preconfigured profiles (e.g., `openai` vs `anthropic`), and `--profile <name>` sets the profile at startup. Profiles are defined in `~/.pi/agent/profiles.json`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

### Iterative Development Workflow

For active development with the `pi` CLI available globally:

```bash
npm run build                              # Build all packages
cd packages/coding-agent && npm link       # Create global symlink for `pi` binary
pi --version                               # Verify installation (e.g., 0.65.2)
pi --help                                  # View full usage guide
```

After linking, use `pi` from any directory. Re-run `npm run build` after code changes to update the global binary.

## License

MIT
