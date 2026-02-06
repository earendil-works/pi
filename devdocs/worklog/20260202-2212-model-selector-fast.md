## Worklog: /model selector speed

### Context
- Slow path identified: `loadModelUsageStats()` scans workspace session JSONL files.
- Target: <=100ms open for `/model` selector.

### Planned changes
- Add `.model-usage-stats.json` per workspace session dir.
- Record usage on session start and model change.
- Load usage stats from snapshot, seed from legacy cache if present.

### 2026-02-02
- Added snapshot writer: `recordModelUsage(sessionDir, provider, modelId, timestampMs)`.
- Added unit test verifying snapshot file shape and counters.

Files:
- `packages/coding-agent/src/model-usage.ts`
- `packages/coding-agent/test/model-usage-snapshot.test.ts`

Verified:
- `npm test -w @kennyfrc/mu-coding-agent -- model-usage-snapshot.test.ts`

### 2026-02-02 (cont.)
- Wired `SessionManager.startSession()` and `SessionManager.saveModelChange()` to call `recordModelUsage(...)`.

Files:
- `packages/coding-agent/src/session-manager.ts`
- `packages/coding-agent/test/session-model-usage-snapshot.test.ts`

Verified:
- `npm test -w @kennyfrc/mu-coding-agent -- session-model-usage-snapshot.test.ts`

### 2026-02-02 (cont.)
- Reworked `loadModelUsageStats(sessionDir)` to prefer `.model-usage-stats.json` (snapshot) and avoid scanning session JSONL files.
- Added a test that fails if session scanning APIs are called when snapshot exists.

Files:
- `packages/coding-agent/src/model-usage.ts`
- `packages/coding-agent/test/model-usage-fastpath.test.ts`

Verified:
- `npm test -w @kennyfrc/mu-coding-agent -- model-usage-fastpath.test.ts`

### 2026-02-02 (cont.)
- Added local bench helper for the `/model` selector hot path.

Bench (local):
- `loadModelUsageStats#1`: ~3.4ms
- `loadModelUsageStats#2`: ~0.15ms
- `getAvailableModels`: ~29.7ms
- `sort(recency)`: ~10.8ms

Verified:
- `npx tsx packages/coding-agent/test/bench-model-selector.ts`
- `npm test -w @kennyfrc/mu-coding-agent`
- `npm run check`

### Commands to run
- `npm test -w @kennyfrc/mu-coding-agent`
- `npm run check`
