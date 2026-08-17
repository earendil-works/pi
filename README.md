# PiQuest

PiQuest is a game-development-focused coding agent built on Pi (the `pi-mono` monorepo). It does not rewrite Pi or build a generic agent framework from scratch: it preserves upstream Pi's agent, model/provider, session, tool, and TUI infrastructure and layers game-development behavior on top.

The repository currently tracks upstream Pi (v0.84.2). Upstream mergeability is a first-class concern; PiQuest-specific code is isolated in PiQuest-owned packages.

## Status

Foundation stage. The repo is a plain upstream Pi clone with the PiQuest development rules established in `AGENTS.md`. Game-development features are not implemented yet.

## Architecture

Three tiers, in decreasing order of mergeability with upstream:

- **Upstream-owned packages** (`packages/agent`, `packages/ai`, `packages/tui`, `packages/client`, `packages/protocol`, `packages/server`, `packages/session-backends`, `packages/telemetry`, `packages/evals`) stay as close to upstream as possible.
- **`packages/coding-agent`** is the primary Pi integration surface: programmatic SDK, session APIs, extension APIs, tool factories, and presentation hooks.
- **PiQuest-owned code** will live in `packages/piquest/`: the `piquest` CLI entry point, branding and presentation, project/game context, engine detection and adapters, game-specific tools, and run/playtest/verification workflows.

Engine-specific functionality lives behind explicit engine adapter boundaries. Unity is the first target; there is no speculative multi-engine support.

## Development

```bash
npm install --ignore-scripts  # Install dependencies without lifecycle scripts
npm run check         # Lint, format, typecheck, and dependency checks
./test.sh             # Run tests without API keys
./pi-test.sh          # Run the agent from sources
```

See `AGENTS.md` for detailed development rules (architecture boundaries, upstream policy, commands, testing).

## License

MIT. PiQuest is derived from [Pi](https://github.com/earendil-works/pi), MIT licensed.
