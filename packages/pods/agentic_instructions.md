# packages/pods

## Purpose
Package root for `@mariozechner/pi` -- CLI tool for managing vLLM deployments on remote GPU pods via SSH.

## Technology
TypeScript, ESM, npm package. Build: `tsgo`. SSH-based remote execution.

## Contents
- `package.json` - Package manifest (v0.59.0), CLI binary `pi-pods`
- `README.md` - Setup and usage documentation
- `tsconfig.build.json` - Build TypeScript configuration
- `src/` - Source code (see `src/agentic_instructions.md`)
- `docs/` - Setup and usage documentation
- `scripts/` - Remote setup scripts (vLLM installation)

## CRUD Entry Points
- **Build**: `npm run build` (tsgo + chmod + copy scripts)
- **Run**: `pi-pods <command>` (pods, shell, ssh, start, stop, list, logs, agent)
