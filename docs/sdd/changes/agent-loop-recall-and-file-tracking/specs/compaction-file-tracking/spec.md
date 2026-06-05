# compaction-file-tracking Specification

## MODIFIED Requirements

### Requirement: Compaction tracks bash file operations via regex

The `extractFileOpsFromMessage` function in `packages/agent/src/harness/compaction/utils.ts` SHALL recognize file paths in bash tool call arguments by applying 6 regex patterns to `args.command`, and SHALL add extracted paths to the appropriate `fileOps` sets.

#### Scenario: Bash redirect `>` extracts written path
- **GIVEN** an assistant message with a `toolCall` block `{ name: "bash", arguments: { command: "echo 'x' > src/config.ts" } }`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.written` contains `"src/config.ts"`

#### Scenario: Bash `mv` extracts destination as written
- **GIVEN** assistant message with `toolCall({ name: "bash", arguments: { command: "mv src/old.ts src/new.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.written` contains `"src/new.ts"`
- **AND** the source path tracking is deferred to v2 (not in scope)

#### Scenario: Bash `rm` extracts deleted path
- **GIVEN** assistant message with `toolCall({ name: "bash", arguments: { command: "rm -r build/" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.deleted` (when initialized) contains `"build/"`
- **AND** if `fileOps.deleted` is undefined, the function does not throw

#### Scenario: Bash command without recognized pattern is a no-op
- **GIVEN** assistant message with `toolCall({ name: "bash", arguments: { command: "ls -la" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** all `fileOps` sets remain unchanged
- **AND** no error is thrown

### Requirement: Compaction tracks grep/find/ls search directories as read

The `extractFileOpsFromMessage` function SHALL extract the `args.path` from `grep`, `find`, and `ls` tool calls and add it to `fileOps.read` to mark the search directory as having been read.

#### Scenario: Grep with explicit path
- **GIVEN** assistant message with `toolCall({ name: "grep", arguments: { pattern: "TODO", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

#### Scenario: Grep without path argument
- **GIVEN** assistant message with `toolCall({ name: "grep", arguments: { pattern: "TODO" } })` (no path)
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** no path is added to `fileOps.read`
- **AND** no error is thrown (path is optional)

### Requirement: read/write/edit tool tracking unchanged

The `extractFileOpsFromMessage` function SHALL continue to track `read`, `write`, and `edit` tool calls exactly as before, without behavioral change.

#### Scenario: read tool call tracks path
- **GIVEN** assistant message with `toolCall({ name: "read", arguments: { path: "src/foo.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src/foo.ts"`

### Requirement: FileOperations interface supports optional deleted set

The `FileOperations` interface in `packages/agent/src/harness/compaction/utils.ts` SHALL include an optional `deleted?: Set<string>` field to record files removed by bash `rm` commands. This field is optional for backward compatibility with existing callers.

#### Scenario: FileOperations initialization with deleted set
- **GIVEN** `createFileOps()` is called
- **WHEN** the returned object is inspected
- **THEN** `result.deleted` is a `Set<string>` instance
- **AND** `result.deleted.size === 0`
- **AND** `result.read`, `result.written`, `result.edited` are also Sets (unchanged behavior)
