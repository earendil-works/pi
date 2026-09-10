# Run Pi on Windows

Run Pi either as a native Windows process or inside Windows Subsystem for Linux (WSL). Native Windows uses Git Bash by default for Bash commands and can optionally expose PowerShell to the model. Pi inside WSL uses the Linux environment and its Bash installation.

Follow the main [Quickstart](quickstart.md) to install and authenticate Pi. Use this page to choose and configure its command environment.

## Choose native Windows or WSL

| Environment | Command environment | Use it when |
|---|---|---|
| Native Windows with Git Bash | Git Bash for the built-in `bash` tool and `!` commands | Your files and development tools primarily live on Windows |
| Native Windows with the `powershell` tool | PowerShell for model tool calls; Bash remains available for `!` commands | The task depends on PowerShell modules or Windows-native commands |
| WSL | Linux Bash and tools inside the selected WSL distribution | Your files and toolchain already live in Linux or WSL |

## Use Git Bash on native Windows

For most native Windows users, installing [Git for Windows](https://git-scm.com/download/win) is sufficient.

Pi resolves Bash in this order:

1. `shellPath` from `~/.pi/agent/settings.json`
2. Git Bash under `Program Files` or `Program Files (x86)`
3. `bash.exe` on `PATH`, including Cygwin, MSYS2, or legacy WSL Bash

Start Pi and enter this command to verify the shell:

```text
!printf 'Bash is working\n'
```

If Pi cannot find Bash, it reports the locations it checked. Install Git for Windows, put another Bash executable on `PATH`, or configure `shellPath`.

## Let the model use PowerShell

The optional `powershell` tool runs commands through `pwsh.exe` when available, then falls back to Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

To replace the model-facing `bash` tool with `powershell`, add this to `~/.pi/agent/settings.json`:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Restart Pi, then ask it to run a harmless PowerShell command. The `!` and `!!` editor commands continue to use Bash. The `powershell` tool is available only when Pi runs as a native Windows process.

See [Settings](settings-reference.md#tools) for other tool combinations.

## Use a custom Bash executable

Set `shellPath` when Bash is installed somewhere Pi does not discover automatically:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

JSON uses backslashes for escape sequences. When you write a Windows path with backslashes, write each backslash twice, as shown above.

See [Configure shell commands](shell-aliases.md) for command prefixes, aliases, and the complete shell-resolution behavior.

## Configure Windows Terminal

Windows Terminal reserves or rewrites some modified keys. See [Windows Terminal](terminal-setup.md#windows-terminal) to configure `Shift+Enter` and `Alt+Enter`, and [Keybindings](keybindings.md) for Pi's Windows and WSL shortcut defaults.
