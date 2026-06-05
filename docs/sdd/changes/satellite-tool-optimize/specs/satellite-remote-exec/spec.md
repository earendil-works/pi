# satellite-remote-exec Specification

## ADDED Requirements

### Requirement: Bash Guardrail Intent Detection

The satellite server SHALL detect bash command intent that indicates use of a dedicated file operation tool, and SHALL return an `isError: true` response with guidance to use the dedicated tool instead.

#### Scenario: bash cat guided to read_file
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat /path/to/file")`
- **WHEN** `detectIntent` returns `"read_file"`
- **THEN** The server returns `isError: true` with content: "Prefer read_file over bash cat. Use tool=read_file, path='/path/to/file'"

#### Scenario: bash sed -i guided to edit_file
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sed -i 's/x/y/' /path/to/file")`
- **WHEN** `detectIntent` returns `"edit_file"`
- **THEN** The server returns `isError: true` with content: "Prefer edit_file over bash sed -i. Use tool=edit_file, ..."

#### Scenario: bash echo/printf > guided to write_file
- **GIVEN** Agent calls `remote_exec(tool="bash", command="echo 'x' > /path/to/file")`
- **WHEN** `detectIntent` returns `"write_file"`
- **THEN** The server returns `isError: true` with content: "Prefer write_file over bash echo redirect. Use tool=write_file, ..."

#### Scenario: bash find guided to find_files
- **GIVEN** Agent calls `remote_exec(tool="bash", command="find /path -name '*.ts'")`
- **WHEN** `detectIntent` returns `"find_files"`
- **THEN** The server returns `isError: true` with content: "Prefer find_files over bash find. Use tool=find_files, pattern='*.ts', path='/path'"

#### Scenario: bash grep guided to grep_files
- **GIVEN** Agent calls `remote_exec(tool="bash", command="grep -r pattern /path")`
- **WHEN** `detectIntent` returns `"grep_files"`
- **THEN** The server returns `isError: true` with content: "Prefer grep_files over bash grep. Use tool=grep_files, pattern='pattern', path='/path'"

#### Scenario: legitimate bash command passes through
- **GIVEN** Agent calls `remote_exec(tool="bash", command="ls -la /path")`
- **WHEN** `detectIntent` returns `null`
- **THEN** The server spawns the command normally without interception

#### Scenario: bash pipeline usage not falsely intercepted
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat file1 file2 | grep x")`
- **WHEN** `detectIntent` evaluates the command
- **THEN** It returns `null` (pipe detected, command is a pipeline, not a simple cat)

#### Scenario: bash stdin redirect not falsely intercepted
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat < input.txt")`
- **WHEN** `detectIntent` evaluates the command
- **THEN** It returns `null` (stdin redirect, not a file read)

### Requirement: Guardrail Retry Budget

The satellite server SHALL allow at most 2 consecutive intercepts per guardrail intent category per turn, and SHALL return a hard error on the 3rd violation.

#### Scenario: third violation hard-blocks
- **GIVEN** Agent has been intercepted twice in the same turn for `cat` → `read_file` guidance
- **WHEN** Agent calls `remote_exec(tool="bash", command="cat /path")` a third time
- **THEN** The server returns `isError: true` with content: "Blocked: you have tried bash cat 3 times. Use tool=read_file instead."

#### Scenario: different intent category resets counter
- **GIVEN** Agent has been intercepted once for `cat` → `read_file`
- **WHEN** Agent calls `remote_exec(tool="bash", command="sed -i 's/a/b/' /path")`
- **THEN** The server returns guidance error for `sed` and the `cat` counter is not affected

### Requirement: Bash Default Timeout

The satellite server SHALL apply a default timeout of 30 seconds to bash commands when the agent does not specify a `timeout` parameter.

#### Scenario: command exceeding default 30s timeout is killed
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sleep 60")` without `timeout`
- **WHEN** 30 seconds elapse without the process completing
- **THEN** The server kills the process group and returns `isError: true` with content: "Command exceeded 30s timeout (no timeout set). Use timeout=<seconds> for long tasks."

#### Scenario: explicit timeout is respected
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sleep 60", timeout=5)`
- **WHEN** 5 seconds elapse
- **THEN** The server kills the process and returns `isError: true` with content: "Command exceeded 5s timeout."

### Requirement: Sub-Operation Schema Alignment with Native Tools

The satellite server's sub-operation schemas SHALL match native pi tool schemas in parameter name, type, optionality, and description.

#### Scenario: list_dir path is optional with default "."
- **GIVEN** Agent calls `remote_exec(tool="list_dir")` without `path`
- **WHEN** The schema validator parses the input
- **THEN** Validation succeeds and the handler uses `"."` as the default path

### Requirement: File Transfer Sub-Operation

The satellite server SHALL provide a `transfer_file` sub-operation that moves file content between local and remote locations using HTTP body transport (no LLM context tokens for file content).

#### Scenario: transfer_file upload direction
- **GIVEN** Agent needs to read a remote file and write it locally
- **WHEN** Agent calls `remote_exec(tool="transfer_file", direction="upload", local_path="/local/path", remote_path="/remote/path")`
- **THEN** The server reads `/remote/path` and returns its content in the response (agent writes to `/local/path`)

#### Scenario: transfer_file download direction
- **GIVEN** Agent needs to write a local file to remote
- **WHEN** Agent calls `remote_exec(tool="transfer_file", direction="download", local_path="/local/path", remote_path="/remote/path", content=<bytes>)`
- **THEN** The server writes the content to `/remote/path` and returns a success message

#### Scenario: transfer_file invalid direction rejected
- **GIVEN** Agent calls `remote_exec(tool="transfer_file", direction="push", ...)`
- **WHEN** The schema validator parses the input
- **THEN** Validation fails with `isError: true` and message: "direction must be 'upload' or 'download'"

### Requirement: HTTP Transfer Endpoints

The satellite server SHALL expose `POST /transfer?path=` and `GET /transfer?path=` HTTP endpoints for raw byte transport of file content, gated by `checkAuth`.

#### Scenario: POST /transfer writes body to remote path
- **GIVEN** A POST request to `/transfer?path=/remote/x.txt` with a body of bytes
- **WHEN** The server processes the request
- **THEN** It writes the bytes to `/remote/x.txt` (creating parent directories) and returns 200 with bytes written

#### Scenario: GET /transfer returns file bytes
- **GIVEN** A GET request to `/transfer?path=/remote/x.txt` with valid auth
- **WHEN** The server processes the request
- **THEN** It returns 200 with `Content-Type: application/octet-stream` and the file contents as body

#### Scenario: /transfer without auth returns 401
- **GIVEN** A request to `/transfer` without `Authorization: Bearer <token>`
- **WHEN** The server processes the request
- **THEN** It returns 401 Unauthorized

#### Scenario: /transfer missing path query returns 400
- **GIVEN** A request to `/transfer` without `?path=` query parameter
- **WHEN** The server processes the request
- **THEN** It returns 400 Bad Request

### Requirement: Remote File Search Sub-Operations

The satellite server SHALL provide `find_files` and `grep_files` sub-operations that delegate to `fd` and `rg` respectively, with explicit error messages when these tools are not installed.

#### Scenario: find_files with fd installed
- **GIVEN** `fd` is installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="find_files", pattern="*.ts", path="/remote/src/")`
- **THEN** The server executes `fd --glob --hidden --no-require-git --max-depth 10 '*.ts' /remote/src/` and returns the file list (truncated to `limit`, default 500)

#### Scenario: find_files with fd missing
- **GIVEN** `fd` is NOT installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="find_files", pattern="*.ts", path="/remote/src/")`
- **THEN** The server returns `isError: true` with content: "fd not found on remote server. Install with: apt install fd-find"

#### Scenario: grep_files with rg installed
- **GIVEN** `rg` is installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="grep_files", pattern="function", path="/remote/src/")`
- **THEN** The server executes `rg` and returns matching lines (truncated to `limit`, default 500)

#### Scenario: grep_files with rg missing
- **GIVEN** `rg` is NOT installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="grep_files", pattern="function", path="/remote/src/")`
- **THEN** The server returns `isError: true` with content: "ripgrep not found. Install with: apt install ripgrep"

### Requirement: Layer A System Prompt Soft Guardrail

The pi agent SHALL inject a system prompt section declaring remote path ownership when the satellite MCP server is configured with a `remotePathPattern` field.

#### Scenario: system prompt includes remote path declaration
- **GIVEN** `~/.pi/agent/mcp.json` contains satellite config with `remotePathPattern: "/TJPROJ\\d+"`
- **WHEN** The agent starts a session
- **THEN** The system prompt contains a "Remote Paths" section declaring that paths matching `/TJPROJ\d+/` are on the remote HPC and must be accessed via `satellite_remote_exec`

## MODIFIED Requirements

(none)

## REMOVED Requirements

### Requirement: v2 stdio MCP transport
- **Reason**: The v2 stdio transport (`extensions/satellite/satellite-mcp.ts`) is superseded by v3 StreamableHTTP transport. v2 has been unmaintained and creates confusion.
- **Migration**: All clients connect to v3 HTTP endpoint at `http://<host>:29001/mcp`. Update any deployment scripts referencing `satellite-mcp` to use `satellite-server`.

## RENAMED Requirements

(none)
