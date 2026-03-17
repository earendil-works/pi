# packages/mom

## Purpose
Package root for `@mariozechner/pi-mom` -- Slack bot that delegates messages to the pi coding agent with per-channel isolation and Docker sandboxing.

## Technology
TypeScript, ESM, npm package. Build: `tsgo`. Slack: `@slack/socket-mode` + `@slack/web-api`.

## Contents
- `package.json` - Package manifest (v0.59.0), CLI binary `mom`
- `README.md` - Setup and usage documentation
- `CHANGELOG.md` - Version history
- `tsconfig.build.json` - Build TypeScript configuration
- `dev.sh` - Development run script
- `docker.sh` - Docker build/run script
- `src/` - Source code (see `src/agentic_instructions.md`)
- `docs/` - Setup and configuration documentation
- `scripts/` - Deployment helper scripts

## CRUD Entry Points
- **Build**: `npm run build` (tsgo + chmod)
- **Run**: `mom [--sandbox=host|docker:<name>] <working-directory>`
- **Env vars**: `MOM_SLACK_APP_TOKEN`, `MOM_SLACK_BOT_TOKEN`
