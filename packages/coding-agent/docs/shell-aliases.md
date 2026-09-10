# Configure shell commands

Pi starts a separate non-interactive shell process for each Bash command. Non-interactive Bash does not expand aliases by default and usually does not load the same startup files as an interactive terminal.

Use `shellPath` to choose the Bash executable and `shellCommandPrefix` to run setup before each command.

## Understand which shell Pi uses

| Command source | Shell |
|---|---|
| Model calls the built-in `bash` tool | Pi's resolved Bash executable |
| You enter `!command` or `!!command` | The same resolved Bash executable |
| Model calls the optional `powershell` tool | PowerShell 7 (`pwsh.exe`) or Windows PowerShell |
| An extension provides or replaces a shell tool | The operations implemented by that extension |

Pi normally invokes Bash with `bash -c`. On Unix systems, it uses `/bin/bash`, then `bash` on `PATH`, and finally `sh` when Bash is unavailable. Native Windows first checks the configured path, then Git Bash, then `bash.exe` on `PATH`.

## Choose a Bash executable

Set `shellPath` in `~/.pi/agent/settings.json` when Pi should use a specific executable:

```json
{
  "shellPath": "~/.local/bin/bash"
}
```

On Windows, use forward slashes or escape backslashes:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

Run `/reload` after changing the setting. See [Run Pi on Windows](windows.md) for the native Windows defaults.

## Run setup before every Bash command

Set `shellCommandPrefix` to prepend shell setup to both the built-in `bash` tool and user-entered `!` or `!!` commands:

```json
{
  "shellCommandPrefix": "export CI=1"
}
```

Pi joins the prefix and requested command with a newline. The prefix runs again for every command, so keep it fast and free of interactive prompts.

## Enable Bash aliases

Store aliases needed by Pi in a Bash-compatible file instead of parsing an entire interactive shell configuration.

Create `~/.bash_aliases`:

```bash
alias ll='ls -la'
alias gs='git status --short'
```

Then configure Pi to enable alias expansion and load the file:

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\nsource ~/.bash_aliases"
}
```

Run `/reload`, then verify the alias through Pi:

```text
!ll
```

The command should produce the same listing as `ls -la`.

Aliases must use Bash-compatible syntax. Do not source an arbitrary `.zshrc` into Bash because zsh options, functions, and plugins may not parse or behave correctly there.

## Troubleshooting

### The prefix works for `!` but not for an extension tool

`shellCommandPrefix` configures Pi's built-in Bash execution. An extension that replaces the `bash` tool or provides its own shell operations controls its own setup. Check that extension's documentation.

### `shopt` is not found

Pi has fallen back to `sh` or `shellPath` points to a non-Bash shell. Install Bash or set `shellPath` to a Bash executable before using Bash-specific setup such as `shopt`.

### A setup command waits for input

Remove interactive commands from `shellCommandPrefix`. The prefix runs in a non-interactive process before every Bash command.

For the complete setting definitions, see [Shell settings](settings-reference.md#shell).
