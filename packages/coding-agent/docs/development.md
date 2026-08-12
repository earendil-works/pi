# Development

See [AGENTS.md](../../AGENTS.md) for additional guidelines.

## Setup

```bash
git clone git@github.com:earendil-works/pi.git
cd pi
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
```

Run from source:

```bash
./pi-test.sh
```

The script can be run from any directory. Pi keeps the caller's current working directory. Pass `--no-env` to run without API keys (unsets provider credential environment variables).

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.pi/agent/pi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh         # Run non-LLM tests in an isolated home (no API keys needed)
npm test          # Run all tests (requires API keys for LLM-dependent tests)
```

`./test.sh` wipes the environment and runs `npm test` with an empty temporary `HOME`, so it never picks up your credentials or user resources. To run a specific test file, invoke the workspace test runner directly:

```bash
# Vitest (most packages)
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts

# node:test (packages/tui)
node --test test/specific.test.ts
```

## Project Structure

```
packages/
  ai/                     # @earendil-works/pi-ai: unified multi-provider LLM API with model discovery
  agent/                  # @earendil-works/pi-agent-core: agent runtime, transport abstraction, state, attachments
  tui/                    # @earendil-works/pi-tui: terminal UI library with differential rendering
  coding-agent/           # @earendil-works/pi-coding-agent: interactive coding agent CLI
  telemetry/              # @earendil-works/pi-telemetry: vendor-neutral telemetry contracts and typed schemas
  protocol/               # @earendil-works/pi-protocol: transport-neutral CBOR protocol for remote sessions
  client/                 # @earendil-works/pi-client: transport-neutral client over framed CBOR bytes
  server/                 # @earendil-works/pi-server: experimental server package
  session-backends/
    sqlite-node/          # @earendil-works/pi-session-backend-sqlite-node: Node sqlite session backend
  evals/                  # @earendil-works/pi-evals: evaluations
```
