# @kennyfrc/mu-tui

Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications.

## Features

- **Differential Rendering**: Three-strategy rendering system that only updates what changed
- **Synchronized Output**: Uses CSI 2026 for atomic screen updates (no flicker)
- **Bracketed Paste Mode**: Handles large pastes correctly with markers for >10 line pastes
- **Component-based**: Simple Component interface with render() method
- **Built-in Components**: Text, Input, Editor, Markdown, Loader, SelectList, Spacer
- **Autocomplete Support**: File paths and slash commands

## Quick Start

```typescript
import { TUI, Text, Editor, ProcessTerminal } from "@kennyfrc/mu-tui";

// Create terminal
const terminal = new ProcessTerminal();

// Create TUI
const tui = new TUI(terminal);

// Add components
tui.addChild(new Text("Welcome to my app!"));

const editor = new Editor();
editor.onSubmit = (text) => {
	console.log("Submitted:", text);
	tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Start
tui.start();
```

## Core API

### TUI

Main container that manages components and rendering.

```typescript
const tui = new TUI(terminal);
tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // Request a re-render
```

### Component Interface

All components implement:

```typescript
interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
}
```

## Built-in Components

### Container

Groups child components.

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Text

Displays multi-line text with word wrapping and padding.

```typescript
const text = new Text("Hello World", paddingX, paddingY); // defaults: 1, 1
text.setText("Updated text");
```

### Input

Single-line text input with horizontal scrolling.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
```

### Editor

Multi-line text editor with autocomplete, file completion, and paste handling.

```typescript
const editor = new Editor();
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.maxHeight = 10; // Optional: constrain editor height with scrolling
```

**Features:**
- Multi-line editing with word wrap
- Height-constrained mode with automatic scrolling
- Visual scrollbar when content exceeds height
- Slash command autocomplete (type `/`)
- File path autocomplete (press `Tab`)
- Large paste handling (>10 lines creates `[paste #1 +50 lines]` marker)
- Horizontal lines above/below editor
- Fake cursor rendering (hidden real cursor)

**Key Bindings:**
- `Enter` - Submit
- `Shift+Enter`, `Ctrl+Enter`, or `Alt+Enter` - New line (terminal-dependent, Alt+Enter most reliable)
- `Tab` - Autocomplete
- `PageUp` / `PageDown` - Scroll by page (with 2-line overlap for context)
- `Ctrl+K` - Delete line
- `Ctrl+A` / `Ctrl+E` - Line start/end
- Arrow keys, Backspace, Delete work as expected
- Mouse wheel scrolling (when terminal supports SGR mouse mode)

### Markdown

Renders markdown with syntax highlighting and optional background colors.

```typescript
const md = new Markdown(
	"# Hello\n\nSome **bold** text",
	bgColor,           // optional: "bgRed", "bgBlue", etc.
	fgColor,           // optional: "white", "cyan", etc.
	customBgRgb,       // optional: { r: 52, g: 53, b: 65 }
	paddingX,          // optional: default 1
	paddingY           // optional: default 1
);
md.setText("Updated markdown");
```

**Features:**
- Headings, bold, italic, code blocks, lists, links, blockquotes
- Syntax highlighting with chalk
- Optional background colors (including custom RGB)
- Padding support
- Render caching for performance

### Loader

Animated loading spinner.

```typescript
const loader = new Loader(tui, "Loading...");
loader.start();
loader.stop();
```

### SelectList

Interactive selection list with keyboard navigation.

```typescript
const list = new SelectList([
	{ value: "opt1", label: "Option 1", description: "First option" },
	{ value: "opt2", label: "Option 2", description: "Second option" },
], 5); // maxVisible

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.setFilter("opt"); // Filter items
```

**Controls:**
- Arrow keys: Navigate
- Enter or Tab: Select
- Escape: Cancel

### Spacer

Empty lines for vertical spacing.

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

## Autocomplete

### CombinedAutocompleteProvider

Supports both slash commands and file paths.

```typescript
import { CombinedAutocompleteProvider } from "@kennyfrc/mu-tui";

const provider = new CombinedAutocompleteProvider(
	[
		{ name: "help", description: "Show help" },
		{ name: "clear", description: "Clear screen" },
		{ name: "delete", description: "Delete last message" },
	],
	process.cwd() // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

**Features:**
- Type `/` to see slash commands
- Press `Tab` for file path completion
- Works with `~/`, `./`, `../`, and `@` prefix
- Filters to attachable files for `@` prefix

## Differential Rendering

The TUI uses three rendering strategies:

1. **First Render**: Output all lines without clearing scrollback
2. **Width Changed or Change Above Viewport**: Clear screen and full re-render
3. **Normal Update**: Move cursor to first changed line, clear to end, render changed lines

All updates are wrapped in **synchronized output** (`\x1b[?2026h` ... `\x1b[?2026l`) for atomic, flicker-free rendering.

## Terminal Interface

The TUI works with any object implementing the `Terminal` interface:

```typescript
interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	get columns(): number;
	get rows(): number;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
}
```

**Built-in implementations:**
- `ProcessTerminal` - Uses `process.stdin/stdout`
- `VirtualTerminal` - For testing (uses `@xterm/headless`)

## Example

See `test/chat-simple.ts` for a complete chat interface example with:
- Markdown messages with custom background colors
- Loading spinner during responses
- Editor with autocomplete and slash commands
- Spacers between messages

Run it:
```bash
npx tsx test/chat-simple.ts
```

## Development

```bash
# Install dependencies (from monorepo root)
npm install

# Run type checking
npm run check

# Run the demo
npx tsx test/chat-simple.ts
```
