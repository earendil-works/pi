A6000 current-HEAD GRPO trainer failure.

Infra:
- Lease: `pod-4cb414ce8090ce33202e651a`
- RunPod: `uu9n7spsp3q46g`
- GPU: NVIDIA RTX A6000
- Kiln built from current `ericflo/kiln` HEAD on 2026-05-18 after B2-credential bootstrap.

What worked:
- B2 credential injection worked.
- `/workspace/pi-compaction-grpo` restored from `b2://clouderic/pi-compaction-grpo/`.
- Kiln CUDA release build completed.
- Kiln served Qwen3.5-4B and non-thinking `/v1/completions/batch` returned non-empty text.

Failed GRPO attempts:
- v010 used LoRA rank 2, source 1200 chars, completion 500 chars, max tokens 120.
- v011 used LoRA rank 4, source 1000 chars, completion 400 chars, max tokens 100.
- v012 restarted Kiln cleanly and retried rank 4 with the same tiny payload.

Failure:
- All GRPO submissions failed before progress with:
  `training failed: expected rank-2 q_proj_t for layer 3, got [1]`
- v010 could plausibly be invalid rank-2 config, but v011/v012 reproduced the same error with rank 4 after a clean server restart.

Verdict:
Current Kiln HEAD on this A6000 is not usable for this GRPO loop. Next action is to rebuild at an earlier GRPO commit that predates the latest GRPO default/EMA/agentic changes, then retry the same tiny rank-4 payload.
