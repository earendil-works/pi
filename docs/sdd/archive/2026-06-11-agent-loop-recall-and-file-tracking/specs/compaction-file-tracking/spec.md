# compaction-file-tracking Specification

## MODIFIED Requirements

### Requirement: Compaction tracks grep/find/ls as read (本地)

The `extractFileOpsFromMessage` function in both
`packages/agent/src/harness/compaction/utils.ts` and
`packages/coding-agent/src/core/compaction/utils.ts` SHALL recognize
`grep`, `find`, and `ls` tool calls and add `args.path` to
`fileOps.read`. If `args.path` is undefined, no path is added and no
error is thrown.

#### Scenario: Grep with explicit path
- **GIVEN** assistant message with `toolCall({ name: "grep", arguments: { pattern: "TODO", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

#### Scenario: Find with explicit path
- **GIVEN** assistant message with `toolCall({ name: "find", arguments: { pattern: "*.ts", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

#### Scenario: Ls with explicit path
- **GIVEN** assistant message with `toolCall({ name: "ls", arguments: { path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

#### Scenario: Grep without path argument
- **GIVEN** assistant message with `toolCall({ name: "grep", arguments: { pattern: "TODO" } })` (no path)
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** no path is added to `fileOps.read`
- **AND** no error is thrown (path is optional)

### Requirement: Compaction tracks satellite_remote_exec sub-tool as read

The `extractFileOpsFromMessage` function SHALL recognize
`satellite_remote_exec` MCP tool calls and, when `args.tool` is
`"grep"`, `"find"`, or `"ls"`, add `args.path` to `fileOps.read`.
Other sub-tools (`read`, `write`, `edit`, `bash`, `transfer_file`)
are not tracked by this capability.

#### Scenario: Satellite grep
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "grep", pattern: "TODO", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

#### Scenario: Satellite find
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "find", pattern: "*.ts", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

#### Scenario: Satellite ls
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "ls", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

#### Scenario: Satellite read sub-tool not tracked
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "read", path: "src/foo.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` does not contain `"src/foo.ts"`
- **AND** no error is thrown (out of scope for this capability)

#### Scenario: Satellite bash sub-tool not tracked
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "bash", command: "cat src/foo.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** no file paths are added to any `fileOps` set
- **AND** no error is thrown

### Requirement: read/write/edit tool tracking unchanged

The `extractFileOpsFromMessage` function SHALL continue to track
`read`, `write`, and `edit` tool calls exactly as before, without
behavioral change.

#### Scenario: read tool call tracks path
- **GIVEN** assistant message with `toolCall({ name: "read", arguments: { path: "src/foo.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src/foo.ts"`

#### Scenario: write tool call tracks path
- **GIVEN** assistant message with `toolCall({ name: "write", arguments: { path: "src/foo.ts", content: "..." } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.written` contains `"src/foo.ts"`

#### Scenario: edit tool call tracks path
- **GIVEN** assistant message with `toolCall({ name: "edit", arguments: { path: "src/foo.ts", edits: [...] } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.edited` contains `"src/foo.ts"`

### Requirement: Satellite sub-tool names align with local tools

The `REMOTE_EXEC_INPUT_SCHEMA.tool` enum in
`extensions/satellite/schema.ts` and the `TOOL_HANDLERS` keys in
`extensions/satellite/satellite-server.ts` SHALL use names matching
the local read/write/edit tools: `read`, `write`, `edit`, `bash`,
`list`, `find`, `grep`. The `transfer_file` sub-tool retains its
long form because its parameters (`direction`, `local_path`,
`remote_path`) are non-standard and would not benefit from a
shorter name.

#### Scenario: Satellite schema enum uses short names
- **GIVEN** `REMOTE_EXEC_INPUT_SCHEMA` in `extensions/satellite/schema.ts`
- **WHEN** the schema is read
- **THEN** the `tool` z.enum includes `"read"`, `"write"`, `"edit"`, `"bash"`, `"list"`, `"find"`, `"grep"`, `"transfer_file"`
- **AND** it does NOT include `"read_file"`, `"write_file"`, `"edit_file"`, `"list_dir"`, `"find_files"`, or `"grep_files"`

#### Scenario: TOOL_HANDLERS keys match new names
- **GIVEN** `TOOL_HANDLERS` in `extensions/satellite/satellite-server.ts`
- **WHEN** the constant is read
- **THEN** keys are `read`, `write`, `edit`, `bash`, `list`, `find`, `grep`, `transfer_file`
- **AND** they exactly match `REMOTE_EXEC_INPUT_SCHEMA.tool` enum values

#### Scenario: createMcpServer description uses new names
- **GIVEN** the description string in `createMcpServer` at `extensions/satellite/satellite-server.ts:1118-1155`
- **WHEN** the string is read
- **THEN** sub-tool examples use `read` / `write` / `edit` / `list` / `find` / `grep` (not `_file` / `_dir` / `_files` variants)
