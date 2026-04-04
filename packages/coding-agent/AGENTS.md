# coding-agent — The `pi` CLI

Main binary. Tools, extensions, TUI interactive mode, session management, model resolution.

## Structure
```
src/
  cli/              # CLI arg parsing, entry point
  core/             # Engine (see core/AGENTS.md)
  modes/
    interactive/    # TUI mode — components, theme, input handling
    pipe/           # Non-interactive JSON mode (--mode json)
    rpc/            # Headless JSON stdin/stdout protocol (--mode rpc)
  utils/            # Diff rendering, file watchers, helpers
examples/
  extensions/       # Example extensions (subagent, plan-mode, auto-commit, etc.)
  sdk/              # SDK usage examples
docs/               # Internal docs (extension API, architecture)
```

## Where to Look
| Task | Location |
|------|----------|
| Add CLI flag | `src/cli/args.ts` |
| Add built-in tool | `src/core/tools/` |
| Extension system | `src/core/extensions/` (see core/AGENTS.md) |
| System prompt | `src/core/system-prompt.ts` |
| Model resolution | `src/core/model-resolver.ts` |
| Session branching | `src/core/session-manager.ts` |
| TUI components | `src/modes/interactive/components/` |
| Pipe/JSON mode | `src/modes/pipe/` |
| RPC/headless mode | `src/modes/rpc/` |

## Anti-Patterns
- NEVER use inline imports (see root AGENTS.md)
- NEVER hardcode keybindings — use DEFAULT_*_KEYBINDINGS objects
- Extensions compile on-the-fly via jiti — don't pre-build them

## Commands
```bash
npm run check          # Typecheck + lint (mandatory before commit)
# NEVER: npm run dev, npm run build, npm test
```
