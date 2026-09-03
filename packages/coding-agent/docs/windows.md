# Windows Setup

Pi uses Git Bash by default on Windows. Checked locations (in order):

1. Custom path from `~/.pi/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## PowerShell Tool

The optional `powershell` tool runs commands through `pwsh.exe` when available, otherwise Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

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

## Custom Bash Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
