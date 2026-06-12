# satellite-remote-exec Specification

## MODIFIED Requirements

### Requirement: Bash Guardrail Intent Detection

The satellite server SHALL detect bash command intent that indicates use of a dedicated read/write/edit tool, and SHALL return an `isError: true` response with guidance to use the dedicated tool instead. The guardrail SHALL apply only to satellite `satellite_remote_exec` + `tool: "bash"`; local pi's bash tool is no longer guarded by this layer. The guardrail SHALL use a per-turn budget keyed by `${turnId}:satellite:${intent}`. The guardrail SHALL NOT match `ls`/`find`/`grep` commands — those bash invocations pass through to the server unchanged.

#### Scenario: bash cat guided to read
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat /path/to/file")`
- **WHEN** `detectBashIntent` returns `"read"`
- **THEN** The hook returns `{ block: true, reason: "Prefer read over bash cat. Use { tool:\"read\", path:'/path/to/file' }" }`

#### Scenario: bash sed -i guided to edit
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sed -i 's/x/y/' /path/to/file")`
- **WHEN** `detectBashIntent` returns `"edit"`
- **THEN** The hook returns `{ block: true, reason: "Prefer edit over bash sed -i. Use { tool:\"edit\", path:'/path/to/file', edits:[{oldText,newText}] }" }`

#### Scenario: bash echo/printf > guided to write
- **GIVEN** Agent calls `remote_exec(tool="bash", command="echo 'x' > /path/to/file")`
- **WHEN** `detectBashIntent` returns `"write"`
- **THEN** The hook returns `{ block: true, reason: "Prefer write over bash echo redirect. Use { tool:\"write\", path:'/path/to/file', content:'...' }" }`

#### Scenario: bash ls NOT guided (sub-tool removed)
- **GIVEN** Agent calls `remote_exec(tool="bash", command="ls -la /path")`
- **WHEN** `detectBashIntent` evaluates the command
- **THEN** It returns `null` (the `list` sub-tool is removed; bash `ls` is the only path)

#### Scenario: bash find NOT guided (sub-tool removed)
- **GIVEN** Agent calls `remote_exec(tool="bash", command="find /path -name '*.ts'")`
- **WHEN** `detectBashIntent` evaluates the command
- **THEN** It returns `null` (the `find` sub-tool is removed; bash `find` is the only path)

#### Scenario: bash grep NOT guided (sub-tool removed)
- **GIVEN** Agent calls `remote_exec(tool="bash", command="grep -r pattern /path")`
- **WHEN** `detectBashIntent` evaluates the command
- **THEN** It returns `null` (the `grep` sub-tool is removed; bash `grep` is the only path)

#### Scenario: legitimate bash command passes through
- **GIVEN** Agent calls `remote_exec(tool="bash", command="module load python/3.10")`
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

### Requirement: Sub-Operation Schema Alignment with Native Tools

The satellite server's sub-operation schemas SHALL match native pi tool schemas in parameter name, type, optionality, and description. Sub-tool names SHALL match the local tool names: `read`/`write`/`edit`. The satellite SHALL expose only 5 sub-operations: `bash`, `read`, `write`, `edit`, `transfer_file`. The `list`, `find`, `grep` sub-operations are removed.

#### Scenario: remote_exec schema enum contains only 5 sub-tools
- **GIVEN** the satellite MCP server is started
- **WHEN** a client calls `tools/list` against the server
- **THEN** the `inputSchema.shape.tool` enum contains exactly `["bash", "read", "write", "edit", "transfer_file"]`
- **AND** does not contain `"list"`, `"find"`, or `"grep"`

#### Scenario: removed sub-tool rejected by schema validation
- **GIVEN** Agent calls `remote_exec(tool="list", path="/remote")`
- **WHEN** the server's zod schema validator parses the input
- **THEN** validation fails with `isError: true` and a message indicating the `tool` value is invalid

## REMOVED Requirements

### Requirement: list_sub_tool
- **Reason**: The `list` sub-tool is a thin wrapper around `fs.readdir`; equivalent to `bash(ls ...)`. The sub-tool provides no value beyond what bash already offers (with OutputAccumulator truncation). Removed to reduce surface area.
- **Migration**: Replace `remote_exec(tool="list", path="...")` with `remote_exec(tool="bash", command="ls ...")` or `remote_exec(tool="bash", command="ls -la ...")`. The `bash` sub-tool output is already truncated to 50KB / 2000 lines.

### Requirement: find_sub_tool
- **Reason**: The `find` sub-tool delegates to `fd` subprocess, equivalent to `bash(find ...)`. The `fd` dependency was a deployment burden with no value-add over bash.
- **Migration**: Replace `remote_exec(tool="find", pattern="*.ts", path="src")` with `remote_exec(tool="bash", command="find src -name '*.ts'")` or `remote_exec(tool="bash", command="fd --glob '*.ts' src")` if `fd` is installed.

### Requirement: grep_sub_tool
- **Reason**: The `grep` sub-tool delegates to `rg` subprocess, equivalent to `bash(grep ...)` or `bash(rg ...)`. The `rg` dependency was a deployment burden with no value-add over bash.
- **Migration**: Replace `remote_exec(tool="grep", pattern="TODO", path="src")` with `remote_exec(tool="bash", command="grep -r TODO src")` or `remote_exec(tool="bash", command="rg TODO src")` if `rg` is installed.

### Requirement: Sub-Operation Schema Alignment (list/find/grep mention)
- **Reason**: The original requirement text named 6 sub-tools: `read`/`write`/`edit`/`list`/`find`/`grep`. The list/find/grep sub-tools are removed; the requirement is MODIFIED above to list only the 5 remaining sub-tools.
- **Migration**: Use the modified requirement text. No code migration needed (only schema/description updates).
