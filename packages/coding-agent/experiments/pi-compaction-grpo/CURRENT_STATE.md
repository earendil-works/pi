# Pi Compaction GRPO Current State

Last updated: 2026-05-18T16:25Z

## Purpose

This directory preserves the current Pi compaction GRPO lab state in Git so the
work is reviewable and resumable even if an agent session dies. Full generated
artifacts and adapter tarballs are intentionally kept in B2:

`b2://clouderic/pi-compaction-grpo/`

## What Is In This PR

- `README.md`: source-contract understanding and experiment discipline.
- `rubric.md`: human-readable scorer rubric aligned with Pi compaction behavior.
- `scripts/score_compaction.py`: current reward/scorer implementation, v0.3.
- `scripts/test_compaction_quality.py`: regression tests for scorer/target quality.
- `scripts/build_compaction_prompts.py`: trajectory prompt construction.
- `scripts/run_compaction_contrast_iteration.py`: GRPO payload builder/submitter.
- `scripts/run_next_clean_grpo.sh`: staged next clean GRPO run.
- `scripts/evaluate_next_adapter.sh`: staged cache-busted held-out eval.
- `scripts/evaluate_adapter.py`: eval runner that appends ledger rows.
- `data/trajectory-compaction-prompts-v3.jsonl`: current 24-row prompt set.
- `experiments/ledger.jsonl`: append-only experiment ledger through the latest
  completed checkpoint before the active pod download issue.
- `results/**/summary.*`, `results/**/job.json`, and `results/**/exit-code*.txt`:
  compact result summaries. Large completion dumps and adapter tarballs remain
  in B2.

## Current Best Staged Run

The next model-quality submission is:

```bash
bash scripts/run_next_clean_grpo.sh
```

Default parameters:

- prompt set: `data/trajectory-compaction-prompts-v3.jsonl`
- training offset: `2`
- source budget: `1200`
- completion budget: `1200`
- LoRA rank: `4`
- learning rate: `1e-5`
- adapter: `pi-compaction-grpo-v035-f349-bf16-v03-v3-offset2-offline`
- mode: offline positive/negative contrast
- base adapter: none
- auto-load: disabled

If A6000 memory fails, retry with:

```bash
COMPLETION_BUDGET=900 bash scripts/run_next_clean_grpo.sh
```

Then evaluate with:

```bash
bash scripts/evaluate_next_adapter.sh
```

## Active Blocker At Checkpoint

A RunPod A6000 lease was acquired:

- lease: `pod-5dcc350f2235dc32c5b59cb6`
- RunPod pod id: `hyedflq8bdmtlk`
- task id: `pi-compaction-grpo-v042`

Kiln built successfully on the pod at commit `f3492bec`, but the first server
start ran in mock mode because real Qwen3.5 weights were not available. A
training attempt failed correctly with:

`Training requires real model weights (not available in mock mode)`

The first model download attempt used `huggingface-cli download
Qwen/Qwen3.5-4B`, which timed out and printed that `huggingface-cli` is
deprecated and no longer works. The active retry uses:

```bash
HF_HUB_DISABLE_XET=1 HF_HUB_ENABLE_HF_TRANSFER=0 \
  hf download Qwen/Qwen3.5-4B --local-dir /workspace/models/Qwen3.5-4B
```

with these sentinels:

- `/tmp/pi-compaction-v042-hf-download.done`
- `/tmp/pi-compaction-v042-hf-download.success`
- `/tmp/pi-compaction-v042-hf-download.fail`

Do not run GRPO until `/workspace/models/Qwen3.5-4B/config.json` and model
weights exist and Kiln is restarted with:

```bash
cd /workspace/kiln
KILN_MODEL_PATH=/workspace/models/Qwen3.5-4B \
KILN_W4A16=0 \
KILN_CUDA_ARCHS=86 \
./target/release/kiln serve
```

## Validation

Current local gates before PR creation:

```bash
python3 scripts/test_compaction_quality.py
python3 scripts/calibrate_scorer.py
bash -n scripts/run_next_clean_grpo.sh
bash -n scripts/evaluate_next_adapter.sh
python3 -m py_compile scripts/evaluate_adapter.py
```

The objective is not complete yet. The missing requirement is a proven better
cache-busted adapter. The current state is ready for the next real-weight GRPO
run once the model download/server setup is resolved.
