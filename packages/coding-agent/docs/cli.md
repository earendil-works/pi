# CLI and Modes Reference

```text
pi [options] [--] [@files...] [messages...]
```

When stdin and stdout are terminals, Pi starts interactive mode unless you select print, JSON, or RPC mode. Piped input selects print mode. Positional messages become prompts. Prefix a path with `@` to attach that file. Use `--` to stop option parsing when a prompt begins with a hyphen.

## Modes

| Option | Behavior |
|---|---|
| No mode option | Use interactive mode on a terminal, or print mode with piped input or redirected output |
| `-p`, `--print` | Process the prompt and print the final response |
| `--mode text` | Select text output; remains interactive when stdin and stdout are terminals |
| `--mode json` | Write agent events as JSON Lines |
| `--mode rpc` | Accept JSON Lines commands on stdin and write responses and events to stdout |
| `--export <input> [output]` | Export a session file to HTML and exit |

Print mode also reads piped stdin and adds it to the initial prompt. See [JSON Event Stream Mode](json.md) and [RPC Mode](rpc.md) for their protocols.

## Model options

| Option | Description |
|---|---|
| `--provider <name>` | Select a provider |
| `--model <pattern>` | Select a model ID or pattern; accepts `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | Override configured credentials for this run |
| `--thinking <level>` | Set `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `--models <patterns>` | Set comma-separated patterns for model cycling |
| `--list-models [search]` | List available models, optionally filtered |

## Session options

| Option | Description |
|---|---|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Select a session to resume |
| `--session <path\|id>` | Open a session by path or partial UUID |
| `--session-id <id>` | Use an exact project session ID, creating it if missing |
| `--fork <path\|id>` | Fork an existing session into a new session |
| `--session-dir <dir>` | Override session storage and lookup location |
| `--no-session` | Do not persist the session |
| `-n`, `--name <name>` | Set the session display name |

## Tool options

| Option | Description |
|---|---|
| `-t`, `--tools <list>` | Enable only the named built-in, extension, or custom tools |
| `-xt`, `--exclude-tools <list>` | Disable the named tools |
| `-nbt`, `--no-builtin-tools` | Disable built-in tools while retaining extension and custom tools |
| `-nt`, `--no-tools` | Disable all tools |

Built-in tool names are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. `powershell` is available on Windows. The initial default set depends on the platform and configuration.

## Resource options

| Option | Description |
|---|---|
| `-e`, `--extension <path>` | Load an extension; repeatable |
| `-ne`, `--no-extensions` | Disable extension discovery; explicit `-e` paths still load |
| `--skill <path>` | Load a skill file or directory; repeatable |
| `-ns`, `--no-skills` | Disable skill discovery and loading |
| `--prompt-template <path>` | Load a prompt-template file or directory; repeatable |
| `-np`, `--no-prompt-templates` | Disable prompt-template discovery and loading |
| `--theme <path>` | Load a theme file or directory; repeatable |
| `--use-theme <name[/name]>` | Select the initial interactive theme for this run |
| `--no-themes` | Disable theme discovery and loading |
| `-nc`, `--no-context-files` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

## Prompt and display options

| Option | Description |
|---|---|
| `--system-prompt <text>` | Replace the default system prompt |
| `--append-system-prompt <text>` | Append text or file contents to the system prompt; repeatable |
| `--tui-mode <mode>` | Use `regular` or `fullscreen` terminal mode |
| `--verbose` | Show verbose startup information |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `--offline` | Disable startup network operations |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show the version |

Extensions can register additional long-form options.

## Package commands

| Command | Description |
|---|---|
| `pi install <source> [-l]` | Install a package and add it to global or project settings |
| `pi remove <source> [-l]` | Remove a package |
| `pi uninstall <source> [-l]` | Alias for `remove` |
| `pi update [source\|self\|pi]` | Update Pi or one package source |
| `pi update --extensions` | Update installed packages |
| `pi update --models` | Refresh model catalogs |
| `pi update --all` | Update Pi and installed packages |
| `pi update --extension <source>` | Update one package |
| `pi list` | List installed packages |
| `pi config [-l]` | Configure package resources interactively |

Package and configuration commands accept `--approve` and `--no-approve`. Install, remove, and config accept `-l` or `--local`. Update accepts `--force`. Run `pi <command> --help` for command-specific usage. See [Pi Packages](packages.md) for sources and installation behavior.

## Credential commands

| Command | Description |
|---|---|
| `pi auth check --provider <provider>` | Check whether provider credentials are ready |
| `pi auth print-api-key --provider <provider>` | Print the resolved API key for another client |
| `pi auth print-bearer-token --provider <provider>` | Print a resolved OAuth bearer token |

Auth commands accept a model instead of a provider. `auth check` also supports `--json`, `--credentials`, and `--no-refresh`. `print-bearer-token` supports `--min-expiry <duration>` with `ms`, `s`, `m`, or `h` units.

## Interactive slash commands

Type `/` to search these commands. Extensions, skills, and prompt templates can add more.

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure models used by cycling |
| `/login [provider]`, `/logout` | Add or remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |
| `/resume`, `/new` | Switch or start a session |
| `/name`, `/session` | Name or inspect the current session |
| `/tree`, `/fork`, `/clone` | Navigate or copy session history |
| `/compact` | Compact session context |
| `/export`, `/import`, `/share` | Export, import, or share a session |
| `/copy` | Copy the last assistant message |
| `/trust` | Save a project trust decision for a future process |
| `/reload` | Reload keybindings, resources, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit Pi |
