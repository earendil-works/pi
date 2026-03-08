# Pi Coding Agent Themes

Themes allow you to customize the colors used throughout the coding agent TUI.

## Color Tokens

Every theme must define all color tokens. There are no optional colors.

### Core UI (10 colors)

| Token | Purpose | Examples |
|-------|---------|----------|
| `accent` | Primary accent color | Logo, selected items, cursor (›) |
| `border` | Normal borders | Selector borders, horizontal lines |
| `borderAccent` | Highlighted borders | Changelog borders, special panels |
| `borderMuted` | Subtle borders | Editor borders, secondary separators |
| `success` | Success states | Success messages, diff additions |
| `error` | Error states | Error messages, diff deletions |
| `warning` | Warning states | Warning messages |
| `muted` | Secondary/dimmed text | Metadata, descriptions, output |
| `dim` | Very dimmed text | Less important info, placeholders |
| `text` | Default text color | Main content (usually `""`) |

### Backgrounds & Content Text (7 colors)

| Token | Purpose |
|-------|---------|
| `userMessageBg` | User message background |
| `userMessageText` | User message text color |
| `toolPendingBg` | Tool execution box (pending state) |
| `toolSuccessBg` | Tool execution box (success state) |
| `toolErrorBg` | Tool execution box (error state) |
| `toolTitle` | Tool execution title/heading (e.g., `$ command`, `read file.txt`) |
| `toolOutput` | Tool execution output text |

### Markdown (10 colors)

| Token | Purpose |
|-------|---------|
| `mdHeading` | Heading text (`#`, `##`, etc) |
| `mdLink` | Link text |
| `mdLinkUrl` | Link URL (in parentheses) |
| `mdCode` | Inline code (backticks) |
| `mdCodeBlock` | Code block content |
| `mdCodeBlockBorder` | Code block fences (```) |
| `mdQuote` | Blockquote text |
| `mdQuoteBorder` | Blockquote border (`│`) |
| `mdHr` | Horizontal rule (`---`) |
| `mdListBullet` | List bullets/numbers |

### Tool Diffs (3 colors)

| Token | Purpose |
|-------|---------|
| `toolDiffAdded` | Added lines in tool diffs |
| `toolDiffRemoved` | Removed lines in tool diffs |
| `toolDiffContext` | Context lines in tool diffs |

Note: Diff colors are specific to tool execution boxes and must work with tool background colors.

### Syntax Highlighting (9 colors)

Future-proofing for syntax highlighting support:

| Token | Purpose |
|-------|---------|
| `syntaxComment` | Comments |
| `syntaxKeyword` | Keywords (`if`, `function`, etc) |
| `syntaxFunction` | Function names |
| `syntaxVariable` | Variable names |
| `syntaxString` | String literals |
| `syntaxNumber` | Number literals |
| `syntaxType` | Type names |
| `syntaxOperator` | Operators (`+`, `-`, etc) |
| `syntaxPunctuation` | Punctuation (`;`, `,`, etc) |

### Thinking Level Borders (5 colors)

Editor border colors that indicate the current thinking/reasoning level:

| Token | Purpose |
|-------|---------|
| `thinkingOff` | Border when thinking is off (most subtle) |
| `thinkingMinimal` | Border for minimal thinking |
| `thinkingLow` | Border for low thinking |
| `thinkingMedium` | Border for medium thinking |
| `thinkingHigh` | Border for high thinking (most prominent) |

These create a visual hierarchy: off → minimal → low → medium → high

**Total: 44 color tokens** (all required)

## Theme Format

Themes are defined in JSON files with the following structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/badlogic/mu-mono/main/packages/coding-agent/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242,
    "brightCyan": 51
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

### Color Values

Four formats are supported:

1. **Hex colors**: `"#ff0000"` (6-digit hex RGB)
2. **256-color palette**: `39` (number 0-255, xterm 256-color palette)
3. **Color references**: `"blue"` (must be defined in `vars`)
4. **Terminal default**: `""` (empty string, uses terminal's default color)

### The `vars` Section

The optional `vars` section allows you to define reusable colors:

```json
{
  "vars": {
    "nord0": "#2E3440",
    "nord1": "#3B4252",
    "nord8": "#88C0D0",
    "brightBlue": 39
  },
  "colors": {
    "accent": "nord8",
    "muted": "nord1",
    "mdLink": "brightBlue"
  }
}
```

Benefits:
- Reuse colors across multiple tokens
- Easier to maintain theme consistency
- Can reference standard color palettes

Variables can be hex colors (`"#ff0000"`), 256-color indices (`42`), or references to other variables.

### Terminal Default (empty string)

Use `""` (empty string) to inherit the terminal's default foreground/background color:

```json
{
  "colors": {
    "text": ""  // Uses terminal's default text color
  }
}
```

This is useful for:
- Main text color (adapts to user's terminal theme)
- Creating themes that blend with terminal appearance

## Built-in Themes

Pi comes with three built-in themes:

### `nerv` (default)

The default theme. Inspired by the NERV operations console aesthetic: true black backgrounds, orange labels, phosphor-green data, cyan structural accents, and red reserved for alerts.

### `dark`

Optimized for dark terminal backgrounds with bright, saturated colors.

### `light`

Optimized for light terminal backgrounds with darker, muted colors.

## Selecting a Theme

Themes are configured in the settings (accessible via `/settings`):

```json
{
  "theme": "nerv"
}
```

Or use the `/theme` command interactively.

On first run, Pi defaults to `nerv` unless you explicitly choose another theme.

## Custom Themes

### Theme Locations

Custom themes are loaded from `~/.mu/agent/themes/*.json`.

### Creating a Custom Theme

1. **Create theme directory:**
   ```bash
   mkdir -p ~/.mu/agent/themes
   ```

2. **Create theme file:**
   ```bash
   vim ~/.mu/agent/themes/my-theme.json
   ```

3. **Define all colors:**
   ```json
   {
     "$schema": "https://raw.githubusercontent.com/badlogic/mu-mono/main/packages/coding-agent/theme-schema.json",
     "name": "my-theme",
     "vars": {
       "primary": "#00aaff",
       "secondary": 242,
       "brightGreen": 46
     },
     "colors": {
       "accent": "primary",
       "border": "primary",
       "borderAccent": "#00ffff",
       "borderMuted": "secondary",
       "success": "brightGreen",
       "error": "#ff0000",
       "warning": "#ffff00",
       "muted": "secondary",
       "text": "",
       
       "userMessageBg": "#2d2d30",
       "userMessageText": "",
       "toolPendingBg": "#1e1e2e",
       "toolSuccessBg": "#1e2e1e",
       "toolErrorBg": "#2e1e1e",
       "toolText": "",
       
       "mdHeading": "#ffaa00",
       "mdLink": "primary",
       "mdCode": "#00ffff",
       "mdCodeBlock": "#00ff00",
       "mdCodeBlockBorder": "secondary",
       "mdQuote": "secondary",
       "mdQuoteBorder": "secondary",
       "mdHr": "secondary",
       "mdListBullet": "#00ffff",
       
       "toolDiffAdded": "#00ff00",
       "toolDiffRemoved": "#ff0000",
       "toolDiffContext": "secondary",
       
       "syntaxComment": "secondary",
       "syntaxKeyword": "primary",
       "syntaxFunction": "#00aaff",
       "syntaxVariable": "#ffaa00",
       "syntaxString": "#00ff00",
       "syntaxNumber": "#ff00ff",
       "syntaxType": "#00aaff",
       "syntaxOperator": "primary",
       "syntaxPunctuation": "secondary",
       
       "thinkingOff": "secondary",
       "thinkingMinimal": "primary",
       "thinkingLow": "#00aaff",
       "thinkingMedium": "#00ffff",
       "thinkingHigh": "#ff00ff"
     }
   }
   ```

4. **Select your theme:**
   - Use `/settings` command and set `"theme": "my-theme"`
   - Or use `/theme` command interactively

## Tips

### Light vs Dark Themes

**For dark terminals:**
- Use bright, saturated colors
- Higher contrast
- Example: `#00ffff` (bright cyan)

**For light terminals:**
- Use darker, muted colors
- Lower contrast to avoid eye strain
- Example: `#008888` (dark cyan)

### Color Harmony

- Start with a base palette (e.g., Nord, Gruvbox, Tokyo Night)
- Define your palette in `defs`
- Reference colors consistently

### Testing

Test your theme with:
- Different message types (user, assistant, errors)
- Tool executions (success and error states)
- Markdown content (headings, code, lists, etc)
- Long text that wraps

## Color Format Reference

### Hex Colors

Standard 6-digit hex format:
- `"#ff0000"` - Red
- `"#00ff00"` - Green
- `"#0000ff"` - Blue
- `"#808080"` - Gray
- `"#ffffff"` - White
- `"#000000"` - Black

RGB values: `#RRGGBB` where each component is `00-ff` (0-255)

### 256-Color Palette

Use numeric indices (0-255) to reference the xterm 256-color palette:

**Colors 0-15:** Basic ANSI colors (terminal-dependent, may be themed)
- `0` - Black
- `1` - Red
- `2` - Green
- `3` - Yellow
- `4` - Blue
- `5` - Magenta
- `6` - Cyan
- `7` - White
- `8-15` - Bright variants

**Colors 16-231:** 6×6×6 RGB cube (standardized)
- Formula: `16 + 36×R + 6×G + B` where R, G, B are 0-5
- Example: `39` = bright cyan, `196` = bright red

**Colors 232-255:** Grayscale ramp (standardized)
- `232` - Darkest gray
- `255` - Near white

Example usage:
```json
{
  "vars": {
    "gray": 242,
    "brightCyan": 51,
    "darkBlue": 18
  },
  "colors": {
    "muted": "gray",
    "accent": "brightCyan"
  }
}
```

**Benefits:**
- Works everywhere (`TERM=xterm-256color`)
- No truecolor detection needed
- Standardized RGB cube (16-231) looks the same on all terminals

### Terminal Compatibility

Pi uses 24-bit RGB colors (`\x1b[38;2;R;G;Bm`). Most modern terminals support this:

- ✅ iTerm2, Alacritty, Kitty, WezTerm
- ✅ Windows Terminal
- ✅ VS Code integrated terminal
- ✅ Modern GNOME Terminal, Konsole

For older terminals with only 256-color support, Pi automatically falls back to the nearest 256-color approximation.

To check if your terminal supports truecolor:
```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## Example Themes

See the built-in themes for complete examples:
- [Dark theme](../src/themes/dark.json)
- [Light theme](../src/themes/light.json)

## Schema Validation

Themes are validated on load using [TypeBox](https://github.com/sinclairzx81/typebox) + [Ajv](https://ajv.js.org/).

Invalid themes will show an error with details about what's wrong:
```
Error loading theme 'my-theme':
  - colors.accent: must be string or number
  - colors.mdHeading: required property missing
```

For editor support, the JSON schema is available at:
```
https://raw.githubusercontent.com/badlogic/mu-mono/main/packages/coding-agent/theme-schema.json
```

Add to your theme file for auto-completion and validation:
```json
{
  "$schema": "https://raw.githubusercontent.com/badlogic/mu-mono/main/packages/coding-agent/theme-schema.json",
  ...
}
```

## Implementation

### Theme Class

Themes are loaded and converted to a `Theme` class that provides type-safe color methods:

```typescript
class Theme {
  // Apply foreground color
  fg(color: ThemeColor, text: string): string
  
  // Apply background color
  bg(color: ThemeBg, text: string): string
  
  // Text attributes (preserve current colors)
  bold(text: string): string
  dim(text: string): string
  italic(text: string): string
}
```

### Global Theme Instance

The active theme is available as a global singleton in `coding-agent`:

```typescript
// theme.ts
export let theme: Theme;

export function setTheme(name: string) {
  theme = loadTheme(name);
}

// Usage throughout coding-agent
import { theme } from './theme.js';

theme.fg('accent', 'Selected')
theme.bg('userMessageBg', content)
```

### TUI Component Theming

TUI components (like `Markdown`, `SelectList`, `Editor`) are in the `@kennyfrc/mu-tui` package and don't have direct access to the theme. Instead, they define interfaces for the colors they need:

```typescript
// In @kennyfrc/mu-tui
export interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
}

export class Markdown {
  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    defaultTextStyle?: DefaultTextStyle,
    theme?: MarkdownTheme  // Optional theme functions
  )
  
  // Usage in component
  renderHeading(text: string) {
    return this.theme.heading(text);  // Applies color
  }
}
```

The `coding-agent` provides themed functions when creating components:

```typescript
// In coding-agent
import { theme } from './theme.js';
import { Markdown } from '@kennyfrc/mu-tui';

// Helper to create markdown theme functions
function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text) => theme.fg('mdHeading', text),
    link: (text) => theme.fg('mdLink', text),
    code: (text) => theme.fg('mdCode', text),
    codeBlock: (text) => theme.fg('mdCodeBlock', text),
    codeBlockBorder: (text) => theme.fg('mdCodeBlockBorder', text),
    quote: (text) => theme.fg('mdQuote', text),
    quoteBorder: (text) => theme.fg('mdQuoteBorder', text),
    hr: (text) => theme.fg('mdHr', text),
    listBullet: (text) => theme.fg('mdListBullet', text),
  };
}

// Create markdown with theme
const md = new Markdown(
  text,
  1, 1,
  { bgColor: theme.bg('userMessageBg') },
  getMarkdownTheme()
);
```

This approach:
- Keeps TUI components theme-agnostic (reusable in other projects)
- Maintains type safety via interfaces
- Allows components to have sensible defaults if no theme provided
- Centralizes theme access in `coding-agent`

**Example usage:**
```typescript
const theme = loadTheme('dark');

// Apply foreground colors
theme.fg('accent', 'Selected')
theme.fg('success', '✓ Done')
theme.fg('error', 'Failed')

// Apply background colors
theme.bg('userMessageBg', content)
theme.bg('toolSuccessBg', output)

// Combine styles
theme.bold(theme.fg('accent', 'Title'))
theme.dim(theme.fg('muted', 'metadata'))

// Nested foreground + background
const userMsg = theme.bg('userMessageBg',
  theme.fg('userMessageText', 'Hello')
)
```

**Color resolution:**

1. **Detect terminal capabilities:**
   - Check `$COLORTERM` env var (`truecolor` or `24bit` → truecolor support)
   - Check `$TERM` env var (`*-256color` → 256-color support)
   - Fallback to 256-color mode if detection fails

2. **Load JSON theme file**

3. **Resolve `vars` references recursively:**
   ```json
   {
     "vars": {
       "primary": "#0066cc",
       "accent": "primary"
     },
     "colors": {
       "accent": "accent"  // → "primary" → "#0066cc"
     }
   }
   ```

4. **Convert colors to ANSI codes based on terminal capability:**
   
   **Truecolor mode (24-bit):**
   - Hex (`"#ff0000"`) → `\x1b[38;2;255;0;0m`
   - 256-color (`42`) → `\x1b[38;5;42m` (keep as-is)
   - Empty string (`""`) → `\x1b[39m`
   
   **256-color mode:**
   - Hex (`"#ff0000"`) → convert to nearest RGB cube color → `\x1b[38;5;196m`
   - 256-color (`42`) → `\x1b[38;5;42m` (keep as-is)
   - Empty string (`""`) → `\x1b[39m`
   
   **Hex to 256-color conversion:**
   ```typescript
   // Convert RGB to 6x6x6 cube (colors 16-231)
   r_index = Math.round(r / 255 * 5)
   g_index = Math.round(g / 255 * 5)
   b_index = Math.round(b / 255 * 5)
   color_index = 16 + 36 * r_index + 6 * g_index + b_index
   ```

5. **Cache as `Theme` instance**

This ensures themes work correctly regardless of terminal capabilities, with graceful degradation from truecolor to 256-color.
