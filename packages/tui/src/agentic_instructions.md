# packages/tui/src

## Purpose
Terminal User Interface library with differential rendering for efficient text-based applications. Provides a component system (Container, Text, Box, Editor, SelectList, Markdown, Image), keyboard input handling (including Kitty protocol), and terminal abstraction.

## Technology
TypeScript, ESM modules. Uses `chalk` for ANSI coloring, `marked` for markdown parsing, `koffi` for native clipboard/terminal access, `get-east-asian-width` for CJK character width.

## Contents
- `index.ts` - Barrel export of all components, utilities, and types
- `tui.ts` - `TUI` class: main rendering engine with differential line updates, cursor management, overlay system, focus tracking, input listeners, and Kitty protocol support
- `terminal.ts` - `Terminal` interface and `ProcessTerminal`: abstraction over stdin/stdout with raw mode, alternate screen, mouse/Kitty protocol
- `keys.ts` - `Key` enum, `parseKey()`, `matchesKey()`: keyboard input parsing supporting standard and Kitty protocol sequences
- `keybindings.ts` - `EditorKeybindingsManager`: configurable keybinding system for editor actions
- `editor-component.ts` - `EditorComponent` interface: contract for pluggable text editors
- `autocomplete.ts` - `AutocompleteProvider`, `CombinedAutocompleteProvider`, `SlashCommand`: autocomplete infrastructure
- `fuzzy.ts` - `fuzzyMatch()`, `fuzzyFilter()`: fuzzy string matching for search/filter
- `kill-ring.ts` - Kill ring (clipboard history) for Emacs-style editing
- `undo-stack.ts` - Undo/redo stack for editor operations
- `stdin-buffer.ts` - `StdinBuffer`: input buffering with batch splitting for paste detection
- `terminal-image.ts` - `renderImage()`, `encodeKitty()`, `encodeITerm2()`, `detectCapabilities()`: terminal image rendering (Kitty, iTerm2 protocols)
- `utils.ts` - `visibleWidth()`, `truncateToWidth()`, `wrapTextWithAnsi()`: ANSI-aware string utilities

## Key Functions
- `TUI(terminal)`: Create TUI instance. Main methods: `setRoot()`, `requestRender()`, `showOverlay()`, `setFocus()`
- `Container`: Layout component that arranges children vertically
- `Component.render(width): string[]`: Render component to terminal lines
- `parseKey(data)`: Parse raw input to `Key` event
- `matchesKey(data, key)`: Check if input matches specific key
- `fuzzyMatch(pattern, text)`: Returns `FuzzyMatch | null` with score and highlights
- `visibleWidth(text)`: Calculate visible width accounting for ANSI escapes and CJK chars
- `renderImage(data, options)`: Render image in terminal using best available protocol
- `detectCapabilities()`: Detect terminal image protocol support (Kitty, iTerm2)

## Data Types
- `Component`: `{ render(width): string[], handleInput?(data), invalidate(), wantsKeyRelease? }`
- `Focusable`: `{ focused: boolean }` - mixin for components that receive focus
- `TUI`: Main TUI class with `setRoot()`, `requestRender()`, `showOverlay()`, `setFocus()`, `addInputListener()`
- `Container`: Component that manages child layout
- `Key`: Enum of all keyboard keys (a-z, ctrl+a-z, function keys, arrows, etc.)
- `Terminal`: `{ write(), onInput(), onResize(), getSize(), setRawMode(), showCursor(), ... }`
- `OverlayOptions`: `{ anchor, margin?, width?, height?, transparent? }`
- `SelectItem`: `{ value, label, description? }`
- `EditorAction`: String union of editor actions (moveUp, moveDown, deleteForward, selectAll, etc.)
- `AutocompleteItem`: `{ label, value, description?, icon? }`
- `StdinBuffer`: Buffers raw stdin with configurable batch timeout
- `ImageProtocol`: `"kitty" | "iterm2" | "none"`

## Logging
Debug logging to file (`tui-debug.log`) when enabled.

## CRUD Entry Points
- **Create**: `new TUI(terminal)`, `new Container()`, `new Text(content)`, etc.
- **Read**: `component.render(width)` to get rendered lines
- **Update**: `tui.requestRender()` triggers re-render, `component.handleInput(data)` processes input
- **Delete**: Remove components from Container, `tui.dispose()` to clean up

## Style Guide
- camelCase for functions/variables, PascalCase for classes/types/enums
- Tab indentation, 120-char line width
- Component interface pattern: `render()` + optional `handleInput()` + `invalidate()`
- ANSI escape sequences handled via `chalk` or direct escape codes
- Differential rendering: only changed lines rewritten to terminal

```typescript
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const container = new Container();
container.addChild(new Text("Hello, world!", 0, 0));
tui.setRoot(container);
tui.requestRender();
```
