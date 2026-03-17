# packages/coding-agent/src/modes/interactive/theme

## Purpose
Theme system for the pi coding agent's interactive TUI mode. Provides configurable color themes, syntax highlighting, and component styling.

## Technology
TypeScript, JSON theme definitions, `cli-highlight` for syntax highlighting.

## Contents
- `theme.ts` - `Theme` class, `initTheme()`, `getMarkdownTheme()`, `getSelectListTheme()`, `getSettingsListTheme()`, `highlightCode()`, `getLanguageFromPath()`
- `dark.json` - Dark theme color palette
- `light.json` - Light theme color palette
- `theme-schema.json` - JSON schema for theme definition files

## Key Functions
- `initTheme(themeName?, isInteractive?)`: Initialize theme system, start file watcher for hot reload
- `Theme.fg(color, text)`: Apply foreground color
- `Theme.bg(color, text)`: Apply background color
- `Theme.bold(text)`, `Theme.dim(text)`: Text styling
- `highlightCode(code, language)`: Syntax-highlight code string
- `getLanguageFromPath(filePath)`: Detect language from file extension
- `getMarkdownTheme()`: Get theme config for Markdown component
- `getSelectListTheme()`: Get theme config for SelectList component
- `stopThemeWatcher()`: Stop the file watcher

## Data Types
- `Theme`: Class with color application methods and theme-aware formatting
- `ThemeColor`: String union of available semantic colors (accent, muted, dim, error, warning, success, etc.)

## Logging
N/A

## CRUD Entry Points
- **Create**: Add new `.json` theme files to themes directory
- **Read**: `initTheme(name)` loads theme by name
- **Update**: Edit JSON theme files; hot-reloaded via file watcher
- **Delete**: Remove theme JSON files

## Style Guide
- JSON theme files define color mappings
- Semantic color names (accent, muted, error, warning, success)
- Hot reload via file system watcher
