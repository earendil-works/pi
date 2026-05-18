# v023 Capacity Blocked; v3 Targets Prepared

## Status
- Bounded RunPod capacity probes failed for:
  - `NVIDIA RTX A6000`
  - `NVIDIA H100 80GB HBM3`
  - `NVIDIA A100 80GB PCIe`
- All failures returned retryable RunPod GraphQL capacity errors: `There are no longer any instances available with the requested specifications.`
- No raw SSH polling or unbounded remote loop was used.

## Local Work Completed
- Built `data/trajectory-compaction-prompts-v3.jsonl` from 24 explicit high-context sessions in `/data/.clouderic-internal/repos/apps/trajectory-trainer/trajectories.db`.
- Tightened `scripts/run_compaction_contrast_iteration.py` target generation:
  - skips pseudo-user chunks containing `<task-notification>` / `<tool-use-id>`
  - filters XML tag pseudo-paths such as `/task-id`, `/summary`, `/analysis`, `/status`
  - applies filtering during row preparation and critical-entity ranking
- Removed a zero-byte `trajectories.db` placeholder created by the failed materializer default-path probe and deleted it from B2.
- Added `trajectories.db` to `scripts/sync_b2.sh` exclusions to prevent accidental DB uploads.

## Calibration Under `scripts/score_compaction.py@v0.3`
- original prompts: n=12, mean=0.7894, min=0.7642, max=0.8095
- v2 prompts: n=8, mean=0.7645, min=0.7301, max=0.8256
- v3 prompts: n=24, mean=0.7754, min=0.7301, max=0.8343

## File Operation Coverage
- v2: 8 rows, read-file rows=2, modified-file rows=2, entity min/mean/max=12/46.0/80
- v3: 24 rows, read-file rows=10, modified-file rows=8, entity min/mean/max=10/38.5/80

## Next GPU Run
Use a clean BF16 Kiln server at commit `f3492bec`, no base adapter, scorer v0.3, cache-busted eval, and train from `data/trajectory-compaction-prompts-v3.jsonl` before falling back to v2.
