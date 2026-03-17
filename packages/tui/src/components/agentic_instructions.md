# packages/tui/src/components

## Purpose
Reusable TUI components built on the `Component` interface: text display, editors, markdown rendering, select lists, settings lists, images, boxes, loaders, and spacers.

## Technology
TypeScript, `@mariozechner/pi-tui` Component interface, `marked` for markdown, `chalk` for ANSI.

## Contents
- `box.ts` - `Box`: bordered container with title, padding, and configurable border characters
- `cancellable-loader.ts` - `CancellableLoader`: animated spinner with cancel key hint
- `editor.ts` - `Editor`: full-featured text editor with line wrapping, selection, undo/redo, clipboard, kill ring, autocomplete, syntax highlighting, image support
- `image.ts` - `Image`: terminal image display using Kitty/iTerm2 protocols
- `input.ts` - `Input`: single-line text input with cursor
- `loader.ts` - `Loader`: animated loading spinner
- `markdown.ts` - `Markdown`: renders markdown with syntax-highlighted code blocks, lists, headings, links
- `select-list.ts` - `SelectList`: scrollable filterable list with keyboard navigation and fuzzy search
- `settings-list.ts` - `SettingsList`: key-value settings display with edit capability
- `spacer.ts` - `Spacer`: empty space component for layout
- `text.ts` - `Text`: simple text display with configurable padding
- `truncated-text.ts` - `TruncatedText`: text with line-count truncation and expand/collapse

## Key Functions
- `Editor(options?)`: Create text editor. Key methods: `setText()`, `getText()`, `handleInput()`, `render()`
- `SelectList(items, visibleRows, theme?)`: Create select list. Key: `onSelect`, `onCancel`, `setSelectedIndex()`
- `Markdown(text, theme?)`: Create markdown renderer
- `Box(content, options?)`: Create bordered box

## Data Types
- `EditorOptions`: `{ placeholder?, multiline?, maxLines?, autocompletionProvider?, ... }`
- `EditorTheme`: `{ cursor?, selection?, lineNumber?, ... }`
- `SelectItem`: `{ value, label, description? }`
- `SelectListTheme`: `{ selectedPrefix?, selectedText?, description?, scrollInfo?, noMatch? }`
- `MarkdownTheme`: `{ heading?, code?, link?, list?, blockquote?, ... }`
- `ImageOptions`: `{ width?, height?, fallback? }`
- `DefaultTextStyle`: Function type `(text: string) => string` for text styling

## Logging
N/A

## CRUD Entry Points
- **Create**: Instantiate components via constructors
- **Read**: `component.render(width)` for display output
- **Update**: `handleInput()` for user interaction, setter methods for content
- **Delete**: Remove from parent Container

## Style Guide
- One component per file
- Constructor accepts options object
- Theme callbacks for styling customization
- `invalidate()` for cache clearing on theme change
