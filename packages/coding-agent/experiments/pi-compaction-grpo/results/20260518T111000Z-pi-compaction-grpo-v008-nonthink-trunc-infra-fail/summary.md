v008 infrastructure failure.

Command:
python3 scripts/run_compaction_contrast_iteration.py --adapter pi-compaction-grpo-v008-nonthink-trunc --offset 7 --limit 1 --n 1 --max-tokens 220 --source-char-budget 2200 --completion-char-budget 900 --lora-rank 4 --no-auto-load --wait --job-timeout-s 1200

Outcome:
- First attempt failed before training because Kiln was not listening on 127.0.0.1:8420 after the v007 OOM.
- After restarting Kiln, the retry reached /v1/completions/batch but failed before any result directory or ledger row was created.
- Error: generation_error: batched decode CUDA graph row failed: eager decode forward pass failed: DriverError(CUDA_ERROR_ILLEGAL_INSTRUCTION, "an illegal instruction was encountered").
- No groups, job.json, or adapter weights were produced.

Verdict:
This is not a model-quality result. The pod was contaminated by the prior CUDA OOM/illegal-instruction state.
