# .pi/extensions

## Purpose
Project-local pi coding agent extensions that add custom slash commands and widgets to the interactive TUI.

## Technology
TypeScript extensions using the `@mariozechner/pi-coding-agent` ExtensionAPI and `@mariozechner/pi-tui` UI components.

## Contents
- `diff.ts` - `/diff` command: shows git status changes in a SelectList picker, opens selected file in VS Code diff view
- `files.ts` - `/files` command: lists all files read/written/edited in the current session branch, opens selected file in VS Code
- `prompt-url-widget.ts` - Widget that detects PR/issue URLs in prompts, fetches metadata via `gh`, displays title/author in a sidebar widget, auto-names sessions
- `redraws.ts` - `/tui` command: shows TUI full redraw count (debugging utility)
- `tps.ts` - Tokens-per-second display: calculates and shows output TPS, token counts, and timing after each agent run
- `modal-editor.ts` - Vim-like modal editing example: normal/insert mode toggle via Escape, hjkl navigation, extends `CustomEditor`

## Key Functions
- `diff.ts`: `default(pi: ExtensionAPI)` - registers `/diff` command with `pi.registerCommand()`
- `files.ts`: `default(pi: ExtensionAPI)` - registers `/files` command, scans session branch for tool calls
- `prompt-url-widget.ts`: `default(pi: ExtensionAPI)` - registers `before_agent_start`, `session_switch`, `session_start` event handlers; uses `pi.exec("gh", ...)` for metadata
- `redraws.ts`: `default(pi: ExtensionAPI)` - registers `/tui` command
- `tps.ts`: `default(pi: ExtensionAPI)` - registers `agent_start`/`agent_end` event handlers, computes output tokens / elapsed time
- `modal-editor.ts`: `default(pi: ExtensionAPI)` - registers custom `ModalEditor` extending `CustomEditor`, toggles normal/insert modes

## Data Types
- `FileInfo` (diff.ts): `{ status: string, statusLabel: string, file: string }`
- `FileEntry` (files.ts): `{ path: string, operations: Set<"read"|"write"|"edit">, lastTimestamp: number }`
- `PromptMatch` (prompt-url-widget.ts): `{ kind: "pr"|"issue", url: string }`
- `GhMetadata` (prompt-url-widget.ts): `{ title?: string, author?: { login?: string, name?: string | null } }`

## Logging
Uses `ctx.ui.notify(message, level)` for user-facing notifications (info, error).

## CRUD Entry Points
- **Create**: Add a new `.ts` file exporting `default(pi: ExtensionAPI)` to register new commands/handlers
- **Read**: Extensions are auto-discovered from this directory by the resource loader
- **Update**: Edit existing extension files; changes take effect on next pi startup
- **Delete**: Remove a `.ts` file to unregister its commands

## Style Guide
- Default export function pattern: `export default function (pi: ExtensionAPI) { ... }`
- camelCase for variables and functions, PascalCase for types
- UI built with `Container`, `Text`, `SelectList`, `DynamicBorder` from `@mariozechner/pi-tui`
- Async handlers with `await ctx.ui.custom<void>((tui, theme, kb, done) => { ... })` pattern

```typescript
export default function (pi: ExtensionAPI) {
	pi.registerCommand("example", {
		description: "Example command",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Hello", "info");
		},
	});
}
```
