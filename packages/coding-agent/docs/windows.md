# Windows Setup

Pi uses Git Bash by default on Windows. Checked locations (in order):

1. Custom path from `~/.pi/agent/settings.json`
2. Git Bash at `%ProgramFiles%\Git\bin\bash.exe`
3. Git Bash at `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## PowerShell Tool

The optional `powershell` tool runs commands through `pwsh.exe` when available, otherwise Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

PowerShell discovery checks these locations in order:

1. `pwsh.exe` on PATH
2. `%ProgramFiles%\PowerShell\7\pwsh.exe`
3. `powershell.exe` on PATH
4. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

Use `defaultTools` to replace the model-facing `bash` tool:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Or enable both while comparing behavior:

```json
{
  "defaultTools": ["read", "bash", "powershell", "edit", "write"]
}
```

The `!` and `!!` editor commands still use Bash.

## WSL

WSL path conversion on Windows and extra Git branch polling in WSL recognize `/mnt/<drive>`, not custom mount roots.

When using the legacy WSL `bash.exe` launcher from Windows, Pi sends commands over stdin to avoid command-line quoting problems.

## Custom Bash Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
