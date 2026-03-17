# Keybindings

All keyboard shortcuts can be customized via `~/.pi/agent/keybindings.json`. Each action can be bound to one or more keys.

After editing `keybindings.json`, run `/reload` in pi to apply the changes without restarting the session.

## Key Format

`modifier+key` where modifiers are `ctrl`, `shift`, `alt` (combinable) and keys are:

- **Letters:** `a-z`
- **Digits:** `0-9`
- **Special:** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function:** `f1`-`f12`
- **Symbols:** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Modifier combinations: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `ctrl+1`, etc.

## All Actions

### Cursor Movement

| Action | Default | Description |
|--------|---------|-------------|
| `cursorUp` | `up` | Move cursor up |
| `cursorDown` | `down` | Move cursor down |
| `cursorLeft` | `left`, `ctrl+b` | Move cursor left |
| `cursorRight` | `right`, `ctrl+f` | Move cursor right |
| `cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | Move cursor word left |
| `cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Move cursor word right |
| `cursorLineStart` | `home`, `ctrl+a` | Move to line start |
| `cursorLineEnd` | `end`, `ctrl+e` | Move to line end |
| `jumpForward` | `ctrl+]` | Jump forward to character |
| `jumpBackward` | `ctrl+alt+]` | Jump backward to character |
| `pageUp` | `pageUp` | Scroll up by page |
| `pageDown` | `pageDown` | Scroll down by page |

### Deletion

| Action | Default | Description |
|--------|---------|-------------|
| `deleteCharBackward` | `backspace` | Delete character backward |
| `deleteCharForward` | `delete`, `ctrl+d` | Delete character forward |
| `deleteWordBackward` | `ctrl+w`, `alt+backspace` | Delete word backward |
| `deleteWordForward` | `alt+d`, `alt+delete` | Delete word forward |
| `deleteToLineStart` | `ctrl+u` | Delete to line start |
| `deleteToLineEnd` | `ctrl+k` | Delete to line end |

### Text Input

| Action | Default | Description |
|--------|---------|-------------|
| `newLine` | `shift+enter` | Insert new line |
| `submit` | `enter` | Submit input |
| `tab` | `tab` | Tab / autocomplete |

### Kill Ring

| Action | Default | Description |
|--------|---------|-------------|
| `yank` | `ctrl+y` | Paste most recently deleted text |
| `yankPop` | `alt+y` | Cycle through deleted text after yank |
| `undo` | `ctrl+-` | Undo last edit |

### Clipboard

| Action | Default | Description |
|--------|---------|-------------|
| `copy` | `ctrl+c` | Copy selection |
| `pasteImage` | `ctrl+v` | Paste image from clipboard |

### Application

| Action | Default | Description |
|--------|---------|-------------|
| `interrupt` | `escape` | Cancel / abort |
| `clear` | `ctrl+c` | Clear editor |
| `exit` | `ctrl+d` | Exit (when editor empty) |
| `suspend` | `ctrl+z` | Suspend to background |
| `externalEditor` | `ctrl+g` | Open in external editor (`$VISUAL` or `$EDITOR`) |

### Session

| Action | Default | Description |
|--------|---------|-------------|
| `newSession` | *(none)* | Start a new session (`/new`) |
| `tree` | *(none)* | Open session tree navigator (`/tree`) |
| `fork` | *(none)* | Fork current session (`/fork`) |
| `resume` | *(none)* | Open session resume picker (`/resume`) |

### Models & Thinking

| Action | Default | Description |
|--------|---------|-------------|
| `selectModel` | `ctrl+l` | Open model selector |
| `cycleModelForward` | `ctrl+p` | Cycle to next model |
| `cycleModelBackward` | `shift+ctrl+p` | Cycle to previous model |
| `cycleThinkingLevel` | `shift+tab` | Cycle thinking level |

### Display

| Action | Default | Description |
|--------|---------|-------------|
| `expandTools` | `ctrl+o` | Collapse/expand tool output |
| `toggleThinking` | `ctrl+t` | Collapse/expand thinking blocks |

### Message Queue

| Action | Default | Description |
|--------|---------|-------------|
| `followUp` | `alt+enter` | Queue follow-up message |
| `dequeue` | `alt+up` | Restore queued messages to editor |

### Selection (Lists, Pickers)

| Action | Default | Description |
|--------|---------|-------------|
| `selectUp` | `up` | Move selection up |
| `selectDown` | `down` | Move selection down |
| `selectPageUp` | `pageUp` | Page up in list |
| `selectPageDown` | `pageDown` | Page down in list |
| `selectConfirm` | `enter` | Confirm selection |
| `selectCancel` | `escape`, `ctrl+c` | Cancel selection |

### Tree Navigation

| Action | Default | Description |
|--------|---------|-------------|
| `treeFoldOrUp` | `ctrl+left`, `alt+left` | Fold current branch segment, or jump to the previous segment start |
| `treeUnfoldOrDown` | `ctrl+right`, `alt+right` | Unfold current branch segment, or jump to the next segment start or branch end |

### Session Picker

| Action | Default | Description |
|--------|---------|-------------|
| `toggleSessionPath` | `ctrl+p` | Toggle path display |
| `toggleSessionSort` | `ctrl+s` | Toggle sort mode |
| `toggleSessionNamedFilter` | `ctrl+n` | Toggle named-only filter |
| `renameSession` | `ctrl+r` | Rename session |
| `deleteSession` | `ctrl+d` | Delete session |
| `deleteSessionNoninvasive` | `ctrl+backspace` | Delete session (when query empty) |

## Custom Configuration

Create `~/.pi/agent/keybindings.json`:

```json
{
  "cursorUp": ["up", "ctrl+p"],
  "cursorDown": ["down", "ctrl+n"],
  "deleteWordBackward": ["ctrl+w", "alt+backspace"]
}
```

Each action can have a single key or an array of keys. User config overrides defaults.

### Emacs Example

```json
{
  "cursorUp": ["up", "ctrl+p"],
  "cursorDown": ["down", "ctrl+n"],
  "cursorLeft": ["left", "ctrl+b"],
  "cursorRight": ["right", "ctrl+f"],
  "cursorWordLeft": ["alt+left", "alt+b"],
  "cursorWordRight": ["alt+right", "alt+f"],
  "deleteCharForward": ["delete", "ctrl+d"],
  "deleteCharBackward": ["backspace", "ctrl+h"],
  "newLine": ["shift+enter", "ctrl+j"]
}
```

### Vim Example

```json
{
  "cursorUp": ["up", "alt+k"],
  "cursorDown": ["down", "alt+j"],
  "cursorLeft": ["left", "alt+h"],
  "cursorRight": ["right", "alt+l"],
  "cursorWordLeft": ["alt+left", "alt+b"],
  "cursorWordRight": ["alt+right", "alt+w"]
}
```
