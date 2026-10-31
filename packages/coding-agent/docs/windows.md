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
2. Git Bash at `%ProgramFiles%\Git\bin\bash.exe`
3. Git Bash at `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `bash.exe` on `PATH`, including Cygwin, MSYS2, or legacy WSL Bash

Start Pi and enter this command to verify the shell:

```text
!printf 'Bash is working\n'
```

If Pi cannot find Bash, it reports the locations it checked. Install Git for Windows, put another Bash executable on `PATH`, or configure `shellPath`.

## Let the model use PowerShell

The optional `powershell` tool runs commands through `pwsh.exe` when available, then falls back to Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

PowerShell discovery checks these locations in order:

1. `pwsh.exe` on `PATH`
2. `%ProgramFiles%\PowerShell\7\pwsh.exe`
3. `powershell.exe` on `PATH`
4. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

To replace the model-facing `bash` tool with `powershell`, add this to `~/.pi/agent/settings.json`:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

`["-bash", "+powershell"]` does the same while keeping any other default tools you configured.

Restart Pi, then ask it to run a harmless PowerShell command. The `!` and `!!` editor commands continue to use Bash. The `powershell` tool is available only when Pi runs as a native Windows process.

See [Settings](settings.md#tools) for other tool combinations.

## WSL

WSL path conversion on Windows and extra Git branch polling in WSL recognize `/mnt/<drive>`, not custom mount roots.

When using the legacy WSL `bash.exe` launcher from Windows, Pi sends commands over stdin to avoid command-line quoting problems.

## Use a custom Bash executable

Set `shellPath` when Bash is installed somewhere Pi does not discover automatically:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

JSON uses backslashes for escape sequences. When you write a Windows path with backslashes, write each backslash twice, as shown above.

See [Configure shell commands](shell-aliases.md) for command prefixes, aliases, and the complete shell-resolution behavior.

## Choose a terminal

Every Windows terminal runs Pi through the Windows console host (conhost), which translates between console programs and the terminal window. A terminal either uses the conhost built into Windows or bundles its own copy. Pi has known problems with the built-in conhost and with old bundled copies.

We recommend [Windows Terminal](https://aka.ms/terminal). It always ships an up-to-date conhost, and Pi is best tested with it.

Last updated: October 2026.

| Terminal | Conhost | Status |
|---|---|---|
| [Windows Terminal](https://aka.ms/terminal) | Bundled, up to date | Recommended |
| [VS Code](https://code.visualstudio.com) integrated terminal | Bundled, up to date (default `terminal.integrated.windowsUseConptyDll: true`) | Works |
| [WezTerm](https://wezterm.org) nightly | Bundled, up to date | Works |
| [Tabby](https://tabby.sh) | Bundled, up to date (default "Use ConPTY" setting, Windows 10 2004 or newer) | Works |
| WezTerm 20240203 and older | Bundled, old | Known problems |
| [Alacritty](https://alacritty.org) | Built-in, unless `conpty.dll` and `OpenConsole.exe` from a Windows Terminal release are next to `alacritty.exe` or on `PATH` | Works only with those files |
| Classic console window (`cmd.exe` or PowerShell opened without Windows Terminal) | Built-in | Known problems |
| mintty (Git Bash) | Built-in | Known problems |
| ConEmu, Cmder | Built-in | Known problems |
| [Hyper](https://hyper.is) | Built-in | Known problems |
| Windows OpenSSH server sessions | Built-in | Known problems |

Known problems:

| Problem | Where | What happens | Why |
|---|---|---|---|
| Crash when leaving the alternate screen ([#9186](https://github.com/earendil-works/pi/issues/9186), [microsoft/terminal#17515](https://github.com/microsoft/terminal/issues/17515)) | Built-in conhost | Switching from fullscreen to regular mode in `/settings`, or opening the external editor (`Ctrl+G`) from fullscreen mode, crashes the terminal session. Avoid both, or start with `--tui-mode regular`. | Conhost crashes when a program leaves the alternate screen while console input is in line mode. Pi does this when it stops fullscreen mode. |
| Terminal replies leak into the prompt ([#10256](https://github.com/earendil-works/pi/issues/10256), [#10362](https://github.com/earendil-works/pi/issues/10362), [#10742](https://github.com/earendil-works/pi/issues/10742)) | Built-in conhost behind another terminal (mintty, OpenSSH) | Text such as `;0;rgb:0000/0000/0000` appears in the prompt, and a trailing BEL opens the external editor. | Conhost answers some of Pi's terminal queries itself and forwards others to the outer terminal. When a forwarded reply arrives in pieces, conhost drops its first piece, so the rest arrives as typed text. |
| Reply fragments in the prompt ([#10717](https://github.com/earendil-works/pi/issues/10717), [#10970](https://github.com/earendil-works/pi/issues/10970)) | Old bundled conhost (WezTerm 20240203) | Fragments such as `79` or `55` appear at startup or on session resume. | The bundled conhost cuts forwarded terminal replies short. |
| Input line redrawn on new rows ([#6300](https://github.com/earendil-works/pi/issues/6300)) | Built-in conhost, classic console window | Reported: in regular mode, each keystroke redraws the input line on a new row. | Suspected: conhost moves the cursor to the next row after a full-width line, so Pi's cursor tracking is one row off. |

Microsoft has fixed these conhost bugs in its source. The built-in conhost gets the fixes with a future Windows update, but Microsoft has not said which update or when.

## Configure Windows Terminal

Windows Terminal reserves or rewrites some modified keys. See [Windows Terminal](terminal-setup.md#windows-terminal) to configure `Shift+Enter` and `Alt+Enter`, and [Keybindings](keybindings.md) for Pi's Windows and WSL shortcut defaults.
