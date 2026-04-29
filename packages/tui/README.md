# @mariozechner/pi-tui

Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications.

## Features

- **Differential Rendering**: Three-strategy rendering system that only updates what changed
- **Synchronized Output**: Uses CSI 2026 for atomic screen updates (no flicker)
- **Bracketed Paste Mode**: Handles large pastes correctly with markers for >10 line pastes
- **Component-based**: Simple Component interface with render() method
- **Theme Support**: Components accept theme interfaces for customizable styling
- **Built-in Components**: Text, TruncatedText, Input, Editor, Markdown, Loader, SelectList, SettingsList, Spacer, Image, Box, Container
- **Inline Images**: Renders images in terminals that support Kitty or iTerm2 graphics protocols
- **Autocomplete Support**: File paths and slash commands

## Quick Start

```typescript
import { TUI, Text, Editor, ProcessTerminal, matchesKey } from "@mariozechner/pi-tui";

// Create terminal
const terminal = new ProcessTerminal();

// Create TUI
const tui = new TUI(terminal);

// Add components
tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Focus the editor so it receives keyboard input
tui.setFocus(editor);

// In raw mode Ctrl+C doesn't send SIGINT — intercept it here to allow exit
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

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

// Global debug key handler (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### Overlays

Overlays render components on top of existing content without replacing it. Useful for dialogs, menus, and modal UI.

```typescript
// Show overlay with default options (centered, max 80 cols)
const handle = tui.showOverlay(component);

// Show overlay with custom positioning and sizing
// Values can be numbers (absolute) or percentage strings (e.g., "50%")
const handle = tui.showOverlay(component, {
  // Sizing
  width: 60,              // Fixed width in columns
  width: "80%",           // Width as percentage of terminal
  minWidth: 40,           // Minimum width floor
  maxHeight: 20,          // Maximum height in rows
  maxHeight: "50%",       // Maximum height as percentage of terminal

  // Anchor-based positioning (default: 'center')
  anchor: 'bottom-right', // Position relative to anchor point
  offsetX: 2,             // Horizontal offset from anchor
  offsetY: -1,            // Vertical offset from anchor

  // Percentage-based positioning (alternative to anchor)
  row: "25%",             // Vertical position (0%=top, 100%=bottom)
  col: "50%",             // Horizontal position (0%=left, 100%=right)

  // Absolute positioning (overrides anchor/percent)
  row: 5,                 // Exact row position
  col: 10,                // Exact column position

  // Margin from terminal edges
  margin: 2,              // All sides
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // Responsive visibility
  visible: (termWidth, termHeight) => termWidth >= 100  // Hide on narrow terminals

  // Focus behavior
  nonCapturing: true       // Don't auto-focus when shown
});

// OverlayHandle methods
handle.hide();              // Permanently remove the overlay
handle.setHidden(true);     // Temporarily hide (can show again)
handle.setHidden(false);    // Show again after hiding
handle.isHidden();          // Check if temporarily hidden
handle.focus();             // Focus and bring to visual front
handle.unfocus();           // Release focus to previous target
handle.isFocused();         // Check if overlay has focus

// Hide topmost overlay
tui.hideOverlay();

// Check if any visible overlay is active
tui.hasOverlay();
```

**Anchor values**: `'center'`, `'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`, `'top-center'`, `'bottom-center'`, `'left-center'`, `'right-center'`

**Resolution order**:
1. `minWidth` is applied as a floor after width calculation
2. For position: absolute `row`/`col` > percentage `row`/`col` > `anchor`
3. `margin` clamps final position to stay within terminal bounds
4. `visible` callback controls whether overlay renders (called each frame)

### Component Interface

All components implement:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}
```

| Method | Description |
|--------|-------------|
| `render(width)` | Returns an array of strings, one per line. Each line **must not exceed `width`** or the TUI will error. Use `truncateToWidth()` or manual wrapping to ensure this. |
| `handleInput?(data)` | Called when the component has focus and receives keyboard input. The `data` string contains raw terminal input (may include ANSI escape sequences). |
| `invalidate?()` | Called to clear any cached render state. Components should re-render from scratch on the next `render()` call. |

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line. Styles do not carry across lines. If you emit multi-line text with styling, reapply styles per line or use `wrapTextWithAnsi()` so styles are preserved for each wrapped line.

### Focusable Interface (IME Support)

Components that display a text cursor and need IME (Input Method Editor) support should implement the `Focusable` interface:

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@mariozechner/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // Set by TUI when focus changes
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // Emit marker right before the fake cursor
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

When a `Focusable` component has focus, TUI:
1. Sets `focused = true` on the component
2. Scans rendered output for `CURSOR_MARKER` (a zero-width APC escape sequence)
3. Positions the hardware terminal cursor at that location
4. Shows the hardware cursor

This enables IME candidate windows to appear at the correct position for CJK input methods. The `Editor` and `Input` built-in components already implement this interface.

**Container components with embedded inputs:** When a container component (dialog, selector, etc.) contains an `Input` or `Editor` child, the container must implement `Focusable` and propagate the focus state to the child:

```typescript
import { Container, type Focusable, Input } from "@mariozechner/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Propagate focus to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

Without this propagation, typing with an IME (Chinese, Japanese, Korean, etc.) will show the candidate window in the wrong position.

## Built-in Components

### Container

Groups child components.

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

Container that applies padding and background color to all children.

```typescript
const box = new Box(
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // Change background dynamically
```

### Text

Displays multi-line text with word wrapping and padding.

```typescript
const text = new Text(
  "Hello World",                  // text content
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

Single-line text that truncates to fit viewport width. Useful for status lines and headers.

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX (default: 0)
  0   // paddingY (default: 0)
);
```

### Input

Single-line text input with horizontal scrolling.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

**Key Bindings:**
- `Enter` - Submit
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Ctrl+U` - Delete to start of line
- `Ctrl+K` - Delete to end of line
- `Ctrl+Left` / `Ctrl+Right` - Word navigation
- `Alt+Left` / `Alt+Right` - Word navigation
- Arrow keys, Backspace, Delete work as expected

### Editor

Multi-line text editor with autocomplete, file completion, paste handling, and vertical scrolling when content exceeds terminal height.

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;  // Horizontal padding (default: 0)
}

const editor = new Editor(tui, theme, options?);  // tui is required for height-aware scrolling
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // Change border dynamically
editor.setPaddingX(1); // Update horizontal padding dynamically
editor.getPaddingX();  // Get current padding
```

**Features:**
- Multi-line editing with word wrap
- Slash command autocomplete (type `/`)
- File path autocomplete (press `Tab`)
- Large paste handling (>10 lines creates `[paste #1 +50 lines]` marker)
- Horizontal lines above/below editor
- Fake cursor rendering (hidden real cursor)

**Key Bindings:**
- `Enter` - Submit
- `Shift+Enter`, `Ctrl+Enter`, or `Alt+Enter` - New line (terminal-dependent, Alt+Enter most reliable)
- `Tab` - Autocomplete
- `Ctrl+K` - Delete to end of line
- `Ctrl+U` - Delete to start of line
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Alt+D` or `Alt+Delete` - Delete word forwards
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+]` - Jump forward to character (awaits next keypress, then moves cursor to first occurrence)
- `Ctrl+Alt+]` - Jump backward to character
- Arrow keys, Backspace, Delete work as expected

### Markdown

Renders markdown with syntax highlighting and theming support.

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // optional DefaultTextStyle
);
md.setText("Updated markdown");
```

**Features:**
- Headings, bold, italic, code blocks, lists, links, blockquotes
- HTML tags rendered as plain text
- Optional syntax highlighting via `highlightCode`
- Padding support
- Render caching for performance

### Loader

Animated loading spinner.

```typescript
const loader = new Loader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Loading..."                      // message (default: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

Extends Loader with Escape key handling and an AbortSignal for cancelling async operations.

```typescript
const loader = new CancellableLoader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Working..."                      // message
);
loader.onAbort = () => done(null); // Called when user presses Escape
doAsyncWork(loader.signal).then(done);
```

**Properties:**
- `signal: AbortSignal` - Aborted when user presses Escape
- `aborted: boolean` - Whether the loader was aborted
- `onAbort?: () => void` - Callback when user presses Escape

### SelectList

Interactive selection list with keyboard navigation.

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // Filter items
```

**Controls:**
- Arrow keys: Navigate
- Enter: Select
- Escape: Cancel

### SettingsList

Settings panel with value cycling and submenus.

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // If provided, Enter/Space cycles through these
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

**Controls:**
- Arrow keys: Navigate
- Enter/Space: Activate (cycle value or open submenu)
- Escape: Cancel

### Spacer

Empty lines for vertical spacing.

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

### Image

Renders images inline for terminals that support the Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images. Falls back to a text placeholder on unsupported terminals.

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,       // base64-encoded image data
  "image/png",      // MIME type
  theme,            // ImageTheme
  options           // optional ImageOptions
);
tui.addChild(image);
```

Supported formats: PNG, JPEG, GIF, WebP. Dimensions are parsed from the image headers automatically.

## Autocomplete

### CombinedAutocompleteProvider

Supports both slash commands and file paths.

```typescript
import { CombinedAutocompleteProvider } from "@mariozechner/pi-tui";

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

## Key Detection

Use `matchesKey()` with the `Key` helper for detecting keyboard input (supports Kitty keyboard protocol):

```typescript
import { matchesKey, Key } from "@mariozechner/pi-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**Key identifiers** (use `Key.*` for autocomplete, or string literals):
- Basic keys: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- Arrow keys: `Key.up`, `Key.down`, `Key.left`, `Key.right`
- With modifiers: `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- String format also works: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`

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

## Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

// Get visible width of string (ignoring ANSI codes)
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// Truncate string to width (preserving ANSI codes, adds ellipsis)
const truncated = truncateToWidth("Hello World", 8); // "Hello..."

// Truncate without ellipsis
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// Wrap text to width (preserving ANSI codes across line breaks)
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## Creating Custom Components

When creating custom components, **each line returned by `render()` must not exceed the `width` parameter**. The TUI will error if any line is wider than the terminal.

### Handling Input

Use `matchesKey()` with the `Key` helper for keyboard input:

```typescript
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }
}
```

### Handling Line Width

Use the provided utilities to ensure lines fit:

```typescript
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    // Option 1: Truncate long lines
    return [truncateToWidth(this.text, width)];

    // Option 2: Check and pad to exact width
    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    // Pad to exact width (optional, for backgrounds)
    return [line + " ".repeat(width - visible)];
  }
}
```

### ANSI Code Considerations

Both `visibleWidth()` and `truncateToWidth()` correctly handle ANSI escape codes:

- `visibleWidth()` ignores ANSI codes when calculating width
- `truncateToWidth()` preserves ANSI codes and properly closes them when truncating

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (not counting ANSI codes)
const truncated = truncateToWidth(styled, 8); // Red "Hello" + " W..." with proper reset
```

### Caching

For performance, components should cache their rendered output and only re-render when necessary:

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

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

### Debug logging

Set `PI_TUI_WRITE_LOG` to capture the raw ANSI stream written to stdout.

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx test/chat-simple.ts
```
