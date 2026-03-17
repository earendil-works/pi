# packages/mom/src/tools

## Purpose
Custom agent tools for the mom Slack bot, providing file operations and bash execution adapted for the Slack bot context.

## Technology
TypeScript, `@mariozechner/pi-agent-core` AgentTool interface, `@sinclair/typebox` for parameter schemas.

## Contents
- `index.ts` - Barrel export of all tool factories
- `bash.ts` - Bash execution tool adapted for mom bot context
- `read.ts` - File reading tool for mom bot
- `write.ts` - File writing tool for mom bot
- `edit.ts` - File editing tool (string replacement) for mom bot
- `attach.ts` - Slack attachment handling tool
- `truncate.ts` - Output truncation utilities shared across tools

## Key Functions
- Tool factory functions following the `AgentTool` interface pattern, mirroring the coding-agent tools but adapted for Slack bot execution context

## Data Types
- Tool-specific input/output types matching `@sinclair/typebox` schemas

## Logging
Tool results include details for Slack message rendering.

## CRUD Entry Points
- **Create**: Add new tool files following AgentTool pattern, export from `index.ts`
- **Read**: Tools registered with agent session via `index.ts` exports
- **Update**: Modify tool implementations
- **Delete**: Remove tool file and export from `index.ts`

## Style Guide
- Same conventions as `packages/coding-agent/src/core/tools/`
- TypeBox schemas for parameter validation
- Factory pattern returning `AgentTool`
