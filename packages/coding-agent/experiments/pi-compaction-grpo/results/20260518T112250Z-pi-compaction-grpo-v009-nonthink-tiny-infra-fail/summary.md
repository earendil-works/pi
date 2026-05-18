v009 infrastructure failure.

Command:
python3 scripts/run_compaction_contrast_iteration.py --adapter pi-compaction-grpo-v009-nonthink-tiny --offset 7 --limit 1 --n 1 --max-tokens 160 --source-char-budget 1600 --completion-char-budget 600 --lora-rank 4 --no-auto-load --wait --job-timeout-s 1200

Server state:
- Kiln was restarted with KILN_CUDA_GRAPHS=false after v008 hit CUDA_ERROR_ILLEGAL_INSTRUCTION.
- Health became ready before the v009 request.

Outcome:
- /v1/completions/batch failed immediately with HTTP 500.
- Error: generation_error: Text generation failed: DriverError(CUDA_ERROR_ILLEGAL_INSTRUCTION, "an illegal instruction was encountered").
- No groups, job.json, or adapter weights were produced.

Verdict:
This confirms the active H100 pod remained unhealthy after the earlier OOM/illegal-instruction sequence. Next run should use a fresh or fully recycled pod before testing smaller GRPO payloads.
