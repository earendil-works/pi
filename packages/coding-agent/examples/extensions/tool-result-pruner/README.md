# pi-tool-result-pruner

Keeps model context lean by bounding oversized tool results, with zero
information loss. Calibrated on DeepSeek Harness defaults, with a key
improvement: **pruned middles are recoverable** via spill-copy-on-prune.

## Behavior

For every tool result (any tool), each **text** content block passes through:

1. **Spill** (> `spillThresholdChars`, default 50,000 code points): the full text is
   written to `<spillDir>/<tool>-<callId>.txt` and replaced inline by a head+tail
   preview whose marker carries the file path and original size.
2. **Prune** (> `pruneThresholdChars`, default 8,192 code points): replaced inline by
   head (4,096) + marker + tail (1,024). **v2: the full output is also written to a
   spill file** (when `pruneSpillCopy` is true, the default), so the pruned middle is
   recoverable — zero-loss pruning. The marker includes the exact elided span
   `[start, end)` and the spill file path, so the model can grep or slice to recover.
3. At or under thresholds: untouched. Image/other content blocks are never modified.

If the disk write fails, the handler falls back to pruning without spill copy —
context stays bounded regardless. Spill files are cleaned up after `retentionDays`
(default 7) on a best-effort basis.

## Hardening (v2.1)

- **Compaction-safe prefix marker**: a short `[pruned — full at <path>]` prefix
  at position 0 survives pi's compaction serialization (which truncates tool
  results to 2000 chars). Without it, the recovery path would be silently lost
  after compaction.
- **Spill-file read exclusion**: `read` results targeting a file inside `spillDir`
  pass through untouched, preventing a recovery loop (reading a spill file to
  recover the middle would otherwise re-prune it).
- **Threshold hint**: the no-path marker includes `under 8192 chars` so the model
  knows how narrow to go when re-running commands.

## Telemetry

The `/pruner-stats` command shows in-session counters:
- `pruned` / `spilled` — how many text blocks were pruned / spilled
- `pruneBytesSaved` / `spillBytesSaved` — code points kept out of context

## Config

Optional `config.json` next to `index.ts`. All keys optional; defaults shown:

```json
{
  "pruneThresholdChars": 8192,
  "pruneHeadChars": 4096,
  "pruneTailChars": 1024,
  "spillThresholdChars": 50000,
  "spillPreviewHeadChars": 4096,
  "spillPreviewTailChars": 1024,
  "spillDir": "~/.pi/agent/cache/tool-spill",
  "retentionDays": 7,
  "excludeTools": [],
  "enabled": true,
  "pruneSpillCopy": true
}
```

Unknown keys and nonsensical budgets throw at load, falling back to defaults
only when the file is missing/unreadable. `pruneSpillCopy: false` reverts to
v1 behavior (pruned middles are permanently dropped, no spill file).

## Tests

```
node --experimental-strip-types --test
```

31 tests: prune boundaries + surrogate-pair safety + offset markers + spill-path
recovery markers, config validation (incl. pruneSpillCopy), spill write/locator/
sanitization/retention, handler pipeline (zero-loss prune/spill/exclusions/mixed
content/disk-failure fallback/telemetry counters), and a real-fs repeated-spill
integration test.