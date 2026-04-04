# interactive/components — TUI Components

35 components for pi's interactive terminal mode. Each renders styled text via the `@mariozechner/pi-tui` Component system.

## Categories

### Message Display
| File | Role |
|------|------|
| `assistant-message.ts` | Renders assistant responses (markdown, thinking blocks) |
| `user-message.ts` | Renders user messages |
| `custom-message.ts` | Extension-registered custom message types |
| `skill-invocation-message.ts` | Skill invocation display |
| `branch-summary-message.ts` | Branch summary after compaction |
| `compaction-summary-message.ts` | Compaction summary display |

### Tool Execution
| File | Role |
|------|------|
| `tool-execution.ts` | Renders tool calls + results (collapsible) |
| `bash-execution.ts` | Bash tool output with streaming |
| `diff.ts` | File diff rendering (edit/write results) |

### Selectors (Overlays)
| File | Role |
|------|------|
| `model-selector.ts` | Model picker with fuzzy search |
| `scoped-models-selector.ts` | Scoped model configuration |
| `session-selector.ts` | Session browser/switcher |
| `session-selector-search.ts` | Session search within selector |
| `config-selector.ts` | General config picker |
| `settings-selector.ts` | Settings editor |
| `extension-selector.ts` | Extension picker |
| `theme-selector.ts` | Theme picker |
| `thinking-selector.ts` | Thinking level picker |
| `oauth-selector.ts` | OAuth provider login |
| `show-images-selector.ts` | Image display mode |
| `user-message-selector.ts` | User message history |
| `tree-selector.ts` | Session tree navigation |

### Editor & Input
| File | Role |
|------|------|
| `custom-editor.ts` | Extension-provided editor replacement |
| `extension-editor.ts` | Editor for extension input |
| `extension-input.ts` | Extension UI input handling |
| `login-dialog.ts` | API key / login dialog |

### Layout & Chrome
| File | Role |
|------|------|
| `footer.ts` | Bottom bar: pwd, tokens, context usage, status |
| `keybinding-hints.ts` | Keybinding overlay hints |
| `dynamic-border.ts` | Bordered container with dynamic title |
| `bordered-loader.ts` | Loading spinner with border |
| `visual-truncate.ts` | Text truncation with ellipsis |
| `countdown-timer.ts` | Countdown display |
| `armin.ts` | ASCII art branding |
| `daxnuts.ts` | Easter egg |

## Conventions
- All components use `theme` from `../theme/theme.js` for colors — never hardcode ANSI
- Selectors follow pattern: fuzzy-filterable list + DynamicBorder wrapper + keybinding hints
- Components receive `AgentSession` or specific managers — never import singletons
- `index.ts` re-exports all component classes
