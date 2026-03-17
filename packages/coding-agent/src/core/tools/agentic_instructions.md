# packages/coding-agent/src/core/tools

## Purpose
Built-in coding tools for the pi agent: bash execution, file reading, writing, editing, grep, find, and ls. Each tool implements the `AgentTool` interface with TypeBox-validated parameters.

## Technology
TypeScript. `@sinclair/typebox` for parameter schemas, `@mariozechner/pi-agent-core` for `AgentTool` type.

## Contents
- `index.ts` - Barrel export of all tools and factory functions
- `bash.ts` - `bashTool` / `createBashTool()`: Execute shell commands with timeout, output truncation, and spawn hooks
- `read.ts` - `readTool` / `createReadTool()`: Read files with line offset/limit, binary detection, image handling
- `write.ts` - `writeTool` / `createWriteTool()`: Write file contents (create or overwrite)
- `edit.ts` - `editTool` / `createEditTool()`: String replacement editing with `old_string`/`new_string` and `replace_all`
- `grep.ts` - `grepTool` / `createGrepTool()`: Ripgrep-based search with glob filtering, context lines, output modes
- `find.ts` - `findTool` / `createFindTool()`: fd-based file finding with glob patterns
- `ls.ts` - `lsTool` / `createLsTool()`: Directory listing with metadata
- `truncate.ts` - Shared truncation utilities: `truncateHead()`, `truncateTail()`, `formatSize()` with line and byte limits
- `edit-diff.ts` - Diff computation for edit tool: `detectLineEnding()`, `normalizeToLF()`, `restoreLineEndings()`
- `path-utils.ts` - Path resolution utilities: `resolveToCwd()` with Unicode space normalization, macOS screenshot path fixes, NFD/curly quote variants

## Key Functions
- `bashTool(options?)`: Create bash tool. Returns `AgentTool`
- `readTool(options?)`: Create read tool. Returns `AgentTool`
- `writeTool(options?)`: Create write tool. Returns `AgentTool`
- `editTool(options?)`: Create edit tool. Returns `AgentTool`
- `grepTool(options?)`: Create grep tool. Returns `AgentTool`
- `findTool(options?)`: Create find tool. Returns `AgentTool`
- `lsTool(options?)`: Create ls tool. Returns `AgentTool`
- `codingTools(options?)`: Create all coding tools as an array
- `createBashTool(cwd)`, `createReadTool(cwd)`, etc.: Factory variants with custom working directory

## Data Types
- `BashToolInput`: `{ command: string, timeout?: number }`
- `BashToolDetails`: `{ command, stdout, stderr, exitCode, timedOut, duration }`
- `ReadToolInput`: `{ path: string, offset?: number, limit?: number }`
- `ReadToolDetails`: `{ path, content, lineCount, totalLines, encoding }`
- `WriteToolInput`: `{ path: string, content: string }`
- `EditToolInput`: `{ path: string, old_string: string, new_string: string, replace_all?: boolean }`
- `EditToolDetails`: `{ path, replacements, diff }`
- `GrepToolInput`: `{ pattern, path?, glob?, type?, output_mode?, context?, ... }`
- `FindToolInput`: `{ pattern, path?, type?, maxDepth? }`
- `LsToolInput`: `{ path: string }`
- `TruncationResult`: `{ content, truncated, limitHit: "lines" | "bytes" | null }`
- `LsOperations`: `{ readdir, stat }`
- `ReadOperations`: `{ readFile, stat }`
- `WriteOperations`: `{ writeFile, mkdir }`
- `EditOperations`: `{ readFile, writeFile }`

## Logging
Tool results include `details` object for UI rendering. Errors returned as `isError: true` tool results.

## CRUD Entry Points
- **Create**: `codingTools()` or individual tool factories
- **Read**: Tools are registered with the agent via `agent.setTools()`
- **Update**: Pass `options` to tool factories to customize behavior (cwd, truncation, spawn hooks)
- **Delete**: Exclude tools from the tools array passed to agent

## Style Guide
- Factory pattern: `toolName(options?)` returns `AgentTool`
- TypeBox schemas for parameter validation
- Output truncation with configurable limits (`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`)
- Spawn hooks for bash tool customization (sandboxing, Docker, etc.)

```typescript
const tools = codingTools({ cwd: "/workspace" });
agent.setTools(tools);
```
