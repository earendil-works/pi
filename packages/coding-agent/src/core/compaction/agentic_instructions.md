# packages/coding-agent/src/core/compaction

## Purpose
Context window management through conversation compaction. Detects when context exceeds limits and summarizes older messages to free space while preserving key information.

## Technology
TypeScript. Uses token estimation and LLM-generated summaries.

## Contents
- `index.ts` - Barrel export of all compaction and branch summarization functions
- `compaction.ts` - Core compaction logic: `shouldCompact()`, `findCutPoint()`, `compact()`, `generateSummary()`, token estimation, and conversation serialization
- `branch-summarization.ts` - Branch switching summaries: `generateBranchSummary()` with file operations tracking
- `utils.ts` - Shared utilities: `FileOperations` interface, `createFileOps()`, `extractFileOpsFromMessage()`

## Key Functions
- `shouldCompact(messages, model, settings)`: Returns boolean indicating if compaction needed
- `compact(messages, model, settings, streamFn)`: Perform compaction, returns `CompactionResult`
- `findCutPoint(messages, settings)`: Find optimal point to split conversation
- `generateSummary(conversation, model, streamFn)`: Generate LLM summary of conversation prefix
- `estimateTokens(messages)`: Estimate token count for messages
- `calculateContextTokens(messages, model)`: Calculate context usage percentage
- `generateBranchSummary(options)`: Generate summary for branch switching

## Data Types
- `CompactionResult`: `{ summary, cutIndex, removedCount, estimatedTokensSaved }`
- `CutPointResult`: `{ index, reason }`
- `BranchSummaryResult`: `{ summary, entries }`
- `DEFAULT_COMPACTION_SETTINGS`: default thresholds for compaction triggers
- `FileOperations`: `{ reads: Map<string, number>, writes: Map<string, number>, edits: Map<string, number> }` -- tracks file ops for branch summaries

## Logging
N/A

## CRUD Entry Points
- **Create**: Compaction entries created automatically when context exceeds limits
- **Read**: `getLastAssistantUsage()` to check current context state
- **Update**: Modify `CompactionSettings` to change thresholds
- **Delete**: N/A

## Style Guide
- Pure functions for compaction logic
- Token estimation uses heuristic (chars/4)
- LLM summaries generated via streaming for progress feedback
