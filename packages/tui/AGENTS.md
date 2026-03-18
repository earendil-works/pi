# tui — Terminal UI Library

Differential rendering engine for text-based interfaces. No internal dependencies.

## Structure
```
src/
  tui.ts              # TUI class — differential rendering loop, damage tracking
  terminal.ts         # Raw terminal I/O (ANSI escape sequences, cursor, colors)
  terminal-image.ts   # Inline image rendering (iTerm2/Kitty protocols)
  editor-component.ts # Multi-line text editor with undo/redo
  autocomplete.ts     # Autocomplete popup overlay
  fuzzy.ts            # Fuzzy matching for autocomplete
  keys.ts             # Key event parsing (escape sequences → KeyData)
  keybindings.ts      # Keybinding matching and configuration
  kill-ring.ts        # Emacs-style kill ring (cut/paste buffer)
  undo-stack.ts       # Undo/redo stack implementation
  stdin-buffer.ts     # Buffered stdin reader
  components/         # UI primitives: Text, Container, Markdown, Spacer, etc.
```

## Where to Look
| Task | Location |
|------|----------|
| Fix rendering glitch | `src/tui.ts` (damage/diff logic) |
| Add component | `src/components/` |
| Key handling | `src/keys.ts` + `src/keybindings.ts` |
| Editor behavior | `src/editor-component.ts` |

## Conventions
- Components extend base `Component` — must implement `render()` returning styled text
- Rendering is differential: only changed regions re-paint
- All keybindings configurable — never hardcode key checks
