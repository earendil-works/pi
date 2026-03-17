# packages/coding-agent/src/core/extensions

## Purpose
Extension system for the pi coding agent. Extensions can register tools, commands, event handlers, widgets, keyboard shortcuts, flags, and message renderers. Supports hot-loading from npm packages, git repos, and local paths.

## Technology
TypeScript, ESM modules. Uses `@mariozechner/jiti` for dynamic TypeScript loading without compilation.

## Contents
- `index.ts` - Barrel export and re-exports from `types.ts`, `runner.ts`, `loader.ts`, and slash-commands
- `types.ts` - Core type definitions: `Extension`, `ExtensionAPI`, `ExtensionFactory`, `ExtensionContext`, `RegisteredTool`, tool/event types, `ToolCallEvent`, `ToolResultEvent`, etc.
- `loader.ts` - `discoverAndLoadExtensions(paths)`: discovers, loads, and initializes extensions from filesystem; creates `ExtensionAPI` instances with registration methods
- `runner.ts` - `ExtensionRunner`: manages extension lifecycle within an `AgentSession`, handles event dispatch, tool wrapping, and flag management
- `wrapper.ts` - `wrapRegisteredTool(registeredTool, runner)`: wraps a registered tool with extension input/result transforms and event hooks

## Key Functions
- `discoverAndLoadExtensions(paths)`: Discover and load extensions from filesystem paths
- `createExtensionRuntime()`: Create extension runtime with registration methods
- `wrapToolsWithExtensions(tools, runtime)`: Wrap agent tools with extension intercept hooks
- `wrapRegisteredTool(tool, registeredTool)`: Wrap a single tool with extension modifications
- `ExtensionRunner`: Manages extension lifecycle within an `AgentSession`

## Data Types
- `Extension`: `{ name, flags, commands, tools, shortcuts, handlers }`
- `ExtensionAPI`: API object passed to extension factory functions (registerCommand, registerTool, on, exec, etc.)
- `ExtensionContext`: `{ cwd, hasUI, sessionManager, ui }` -- context passed to event handlers
- `ExtensionRuntime`: Manages registered extensions, pending registrations, flag values
- `RegisteredTool`: `{ tool, inputTransform?, resultTransform? }` -- tool with optional transforms
- `ToolCallEvent`: discriminated union per tool type (BashToolCallEvent, ReadToolCallEvent, EditToolCallEvent, WriteToolCallEvent, etc.)
- `ToolResultEvent`: `{ toolCallId, toolName, result, isError }`
- `ExtensionFlag`: `{ name, type: "boolean" | "string", description }`
- `ExtensionShortcut`: `{ key, description, handler }`

## Logging
Errors logged to console via `chalk`.

## CRUD Entry Points
- **Create**: Create extension file exporting `default(pi: ExtensionAPI)`, place in extensions directory or install via package manager
- **Read**: `discoverAndLoadExtensions()` to list/load extensions
- **Update**: Modify extension files; restart agent to reload
- **Delete**: Remove extension file or `pi remove <source>`

## Style Guide
- Extension factory: `export default function(pi: ExtensionAPI) { ... }`
- Event handler pattern: `pi.on("event_name", async (event, ctx) => { ... })`
- Tool registration: `pi.registerTool("name", { description, parameters, execute })`
- Command registration: `pi.registerCommand("name", { description, handler })`
