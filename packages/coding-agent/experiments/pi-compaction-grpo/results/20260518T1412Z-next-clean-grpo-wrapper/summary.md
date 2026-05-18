# Next Clean GRPO Wrapper

## Status
- Added `scripts/run_next_clean_grpo.sh`.
- The wrapper submits the ranked best v3 row:
  - offset `2`
  - source budget `1200`
  - completion budget `1200` by default
  - rank `4`
  - learning rate `1e-5`
  - offline contrast
  - `--no-auto-load`
  - `--wait`
- `COMPLETION_BUDGET=900` can be set for the fallback run if A6000 BF16 OOMs at 1200.

## Verification
- `bash -n scripts/run_next_clean_grpo.sh`
- `python3 scripts/test_compaction_quality.py`: 5 tests passed.

## Infra
- `ce kiln-runpod-session --gpu-type 'NVIDIA RTX A6000' --task-id pi-compaction-grpo-v035-offset2` still failed with RunPod's retryable no-capacity error.
