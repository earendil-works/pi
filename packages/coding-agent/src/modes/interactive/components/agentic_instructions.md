# packages/coding-agent/src/modes/interactive/components

## Purpose
TUI components for the interactive mode of the pi coding agent. Renders messages, tool executions, dialogs, selectors, and the main application layout.

## Technology
TypeScript, `@mariozechner/pi-tui` component system (Container, Text, Box, Editor, SelectList, etc.).

## Contents
34 component files including:
- `index.ts` - Barrel export of all components
- Message display: `AssistantMessageComponent`, `UserMessageComponent`, `UserMessageSelectorComponent`, `BranchSummaryMessageComponent`, `CompactionSummaryMessageComponent`, `CustomMessageComponent`, `SkillInvocationMessageComponent`
- Tool display: `ToolExecutionComponent`, `BashExecutionComponent`
- Input/editor: `ExtensionEditorComponent`, `ExtensionInputComponent`, `CustomEditor`
- Selectors: `ModelSelectorComponent`, `ThinkingSelectorComponent`, `SessionSelectorComponent`, `SessionSelectorSearchComponent`, `TreeSelectorComponent`, `ThemeSelectorComponent`, `ShowImagesSelectorComponent`, `SettingsSelectorComponent`, `ScopedModelsSelectorComponent`, `OAuthSelectorComponent`, `ConfigSelectorComponent`, `LoginDialogComponent`, `UserMessageSelectorComponent`
- Layout: `FooterComponent`, `ArminComponent` (main app layout), `DaxnutsComponent` (startup animation), `DynamicBorder`, `BorderedLoader`, `CountdownTimer`
- Utilities: `renderDiff()`, `truncateToVisualLines()`, `keyHint()`, `rawKeyHint()`, `appKey()`, `editorKey()`
- Display: `SkillInvocationMessageComponent`, `KeybindingHintsComponent`

## Key Functions
- `ArminComponent`: Main application container managing message list, editor, footer, and overlays
- `AssistantMessageComponent`: Renders streaming assistant messages with thinking blocks, tool calls, and text
- `ToolExecutionComponent`: Renders tool execution with collapsible details
- `FooterComponent`: Status bar with model, thinking level, session info, and extension statuses
- `ModelSelectorComponent`: Interactive model picker with fuzzy search
- `renderDiff(oldText, newText, options?)`: Generate colored diff output

## Data Types
- Component props passed via constructor or setter methods
- Theme colors accessed via `Theme` object (fg, bg, bold, dim, etc.)

## Logging
N/A - UI components render to terminal.

## CRUD Entry Points
- **Create**: Instantiate components via constructors, add to Container
- **Read**: Components render lines via `render(width): string[]`
- **Update**: Components handle input via `handleInput(data)`, update internal state
- **Delete**: Remove from parent Container

## Style Guide
- Components implement `Component` interface from `@mariozechner/pi-tui`
- Theme-aware rendering via `Theme` object
- Keyboard handling via `matchesKey()` from `@mariozechner/pi-tui`
- Tab indentation
