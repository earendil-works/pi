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

Every Windows terminal runs Pi through the Windows console host (conhost), the layer that translates between console programs and the terminal window. A terminal either uses the conhost built into Windows (`C:\Windows\System32\conhost.exe`) or bundles its own copy. Pi has known problems with the built-in conhost and with old bundled copies.

Use [Windows Terminal](https://aka.ms/terminal). It bundles an up-to-date conhost.

### Terminals that bundle an up-to-date conhost

These terminals should work:

- [Windows Terminal](https://aka.ms/terminal)
- [WezTerm](https://wezterm.org) nightly builds
- [Alacritty](https://alacritty.org), but only after you copy `conpty.dll` and `OpenConsole.exe` from a Windows Terminal release next to `alacritty.exe` or onto `PATH`. Without these files, Alacritty uses the built-in conhost.

### Terminals that use the built-in conhost

- Classic console window (`cmd.exe` or PowerShell opened without Windows Terminal)
- mintty (Git Bash)
- Windows OpenSSH server sessions
- Alacritty without `conpty.dll` and `OpenConsole.exe`

Known problems:

- Switching from fullscreen to regular mode in `/settings`, or opening the external editor (`Ctrl+G`) from fullscreen mode, crashes the terminal session ([#9186](https://github.com/earendil-works/pi/issues/9186), [microsoft/terminal#17515](https://github.com/microsoft/terminal/issues/17515)). This is a conhost bug, so it affects every terminal in this group. To avoid it, stay in the TUI mode Pi started with: keep the default fullscreen mode without using `Ctrl+G`, or start with `--tui-mode regular`.
- In mintty and over Windows OpenSSH, terminal replies leak into the prompt as text such as `;0;rgb:0000/0000/0000`, and a trailing BEL opens the external editor ([#10256](https://github.com/earendil-works/pi/issues/10256), [#10362](https://github.com/earendil-works/pi/issues/10362), [#10742](https://github.com/earendil-works/pi/issues/10742)).
- In the classic console window, some users report that regular mode redraws the input line on a new row after each keystroke ([#6300](https://github.com/earendil-works/pi/issues/6300)).

Microsoft has fixed these conhost bugs in its source. The built-in `conhost.exe` gets the fixes with a future Windows update, but Microsoft has not said which update or when.

### Terminals that bundle an old conhost

- WezTerm 20240203 and older bundle a conhost from early 2024. Fragments such as `79` or `55` appear in the prompt at startup or on session resume ([#10717](https://github.com/earendil-works/pi/issues/10717), [#10970](https://github.com/earendil-works/pi/issues/10970)). Use a WezTerm nightly build instead.

## Configure Windows Terminal

Windows Terminal reserves or rewrites some modified keys. See [Windows Terminal](terminal-setup.md#windows-terminal) to configure `Shift+Enter` and `Alt+Enter`, and [Keybindings](keybindings.md) for Pi's Windows and WSL shortcut defaults.
