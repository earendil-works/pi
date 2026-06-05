# Satellite MCP Server

Remote file and shell operations over MCP (Model Context Protocol) using HTTP transport.

## Quick Start

```bash
cd extensions/satellite
./build.sh
./start.sh
```

Server runs on port 29001. Health check: `curl http://localhost:29001/health`

## MCP Configuration

In `~/.pi/agent/mcp.json`:

```json
{
  "satellite": {
    "url": "http://localhost:29001/mcp",
    "token": "<your-token>",
    "remotePathPattern": "/TJPROJ\\d+"
  }
}
```

### remotePathPattern

Optional. Regex pattern (POSIX extended). When set, the agent's system prompt is augmented with:

> Files matching pattern `<pattern>` are on the remote HPC server. Use `satellite_remote_exec` for all file operations on these paths.

This is a **soft guardrail** — it guides the model but does not block local tool use.

Example: `/TJPROJ\\d+` matches `/TJPROJ1/`, `/TJPROJ2/data/`, etc.

## Sub-Operations

The `remote_exec` tool is a discriminated union of 8 sub-operations:

| Sub-op | Purpose | Prefer over |
|--------|---------|-------------|
| `read_file` | Read file contents with offset/limit | `bash(cat ...)` |
| `write_file` | Create/overwrite file | `bash(echo > ...)` |
| `edit_file` | Apply text edits with fuzzy matching | `bash(sed -i ...)` |
| `list_dir` | List directory entries | `bash(ls ...)` |
| `bash` | Execute shell command (use sparingly) | n/a |
| `find_files` | Search files by glob (uses `fd`) | `bash(find ...)` |
| `grep_files` | Search file contents (uses `rg`) | `bash(grep ...)` |
| `transfer_file` | Move file between local/remote | n/a |

## Bash Guardrail

The server detects bash commands that should use a dedicated sub-op and returns guidance errors instead of executing them. Patterns intercepted:

- `cat <path>` → suggests `read_file`
- `sed -i ...` → suggests `edit_file`
- `echo/printf > ...` → suggests `write_file`
- `find ...` → suggests `find_files`
- `grep ...` → suggests `grep_files`

Each category has a retry budget of 2 per turn. On the 3rd violation, returns a hard error.

## Requirements

- `fd` for `find_files` (install: `apt install fd-find`)
- `rg` for `grep_files` (install: `apt install ripgrep`)
- Bun runtime (for build)
- Node.js compatible HTTP client (MCP transport)
