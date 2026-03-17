# packages/coding-agent/src

## Purpose
Root source directory for the pi coding agent CLI -- an AI-powered coding assistant with session management, extension system, tool execution, and interactive/print/RPC modes.

## Technology
TypeScript, ESM modules. Depends on `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`.

## Contents
- `index.ts` - Barrel export of all public APIs (session management, auth, compaction, extensions, tools, modes, UI components, themes, utilities)
- `cli.ts` - CLI entry point (`#!/usr/bin/env node`), shebang for `pi` binary
- `main.ts` - Main function: CLI argument parsing, extension loading, model resolution, session creation, mode dispatch (interactive/print/RPC), package management commands (install/remove/update/list)
- `config.ts` - Configuration paths and detection: `getAgentDir()`, `getPackageDir()`, `getThemesDir()`, `VERSION`, `APP_NAME`, install method detection (`npm`/`pnpm`/`yarn`/`bun-binary`)
- `migrations.ts` - Schema migrations for settings and auth storage between versions
- `cli/` - CLI argument parsing, model listing, session picking, file processing
- `core/` - Core business logic: session management, auth, model resolution, tools, extensions, compaction
- `modes/` - Execution modes (interactive TUI, print, RPC)
- `utils/` - Shared utilities: clipboard, git, image processing, shell, frontmatter

## Key Functions
- `main(args: string[])`: Main entry point, handles CLI parsing, extension loading, model resolution, and mode dispatch
- `getAgentDir()`: Returns `~/.pi/agent/` (or env override)
- `getPackageDir()`: Resolves package root (handles Bun binary, tsx, dist)
- `detectInstallMethod()`: Returns `"npm" | "pnpm" | "yarn" | "bun" | "bun-binary" | "unknown"`
- `VERSION`: Current package version from package.json

## Data Types
- `InstallMethod`: `"bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown"`
- `Args`: Parsed CLI arguments (model, provider, thinking, tools, session, mode, etc.)
- `CreateAgentSessionOptions`: Options for `createAgentSession()` SDK entry point

## Logging
Console output via `chalk`-colored messages. Errors to stderr.

## CRUD Entry Points
- **Create**: `createAgentSession(options)` to create a new coding agent session
- **Read**: `VERSION`, `getAgentDir()`, `getPackageDir()` for configuration
- **Update**: CLI flags modify session behavior (model, thinking, tools, etc.)
- **Delete**: Session cleanup handled by session manager

## Style Guide
- camelCase for functions/variables, PascalCase for types/classes
- Tab indentation, 120-char line width
- No inline imports (strict top-level only per AGENTS.md)
- `chalk` for colored terminal output
- Error messages include actionable instructions

```typescript
import { main } from "./main.js";
main(process.argv.slice(2));
```
