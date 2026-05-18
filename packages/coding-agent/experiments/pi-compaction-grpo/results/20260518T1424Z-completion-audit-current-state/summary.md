# Current Completion Audit

## Objective Restatement
Build increasingly strong Kiln LoRA/GRPO adapters for Pi context compaction by fully understanding Pi's compaction contract, building an excellent scorer/rubric, running continuous experiments, tracking every row append-only, and continuously syncing artifacts/adapters/results to B2.

## Requirement Checklist
| Requirement | Evidence | Current Status |
| --- | --- | --- |
| Read Pi compaction source fully | `/workspace/pi/packages/coding-agent/src/core/compaction/{compaction.ts,branch-summarization.ts,utils.ts,index.ts}` at commit `0f066367bf0ccae1f0762856be351829e03760b3`; live GitHub directory checked. | Done, but keep rechecking if Pi `main` moves. |
| Encode Pi source contract in scorer/rubric | `rubric.md`, `scripts/score_compaction.py`, `results/20260518T1400Z-rubric-source-contract-refresh/summary.md`. | Done for v0.3; scorer remains the highest-leverage artifact. |
| Read Kiln capability-creator examples | Ledger earlier records reads of OPD/SFT/agentic GRPO skill examples and experiment tracking style adoption. | Done. |
| Run GRPO experiments continuously | Ledger rows through `v040`; several successful/failed GRPO/SFT runs, plus staged v035 offset-2 offline contrast. | In progress; currently blocked by RunPod capacity. |
| Improve adapters over time | v014/v017 completed but flat under old eval; v018/v019 regressed under cache-busted eval; v035 not yet submitted. | Not achieved; no proven better adapter yet. |
| Excellent scorer/rubric | `scripts/score_compaction.py@v0.3`, `rubric.md`, `scripts/test_compaction_quality.py`, calibration gates. | Strong current version; must keep improving with every failure mode. |
| Materialize trajectory data as needed | `data/trajectory-compaction-prompts.jsonl`, `-v2.jsonl`, `-v3.jsonl`; v3 has 24 high-context sessions. | Done; v3 currently best pool. |
| Track every experiment row append-only | `experiments/ledger.jsonl` valid JSONL, 55 rows before this audit. | Done; continue appending only. |
| Continuously upload to B2 | `scripts/sync_b2.sh`; repeated successful syncs to `b2://clouderic/pi-compaction-grpo/`. | Done; continue after each change. |
| Avoid unsafe RunPod polling | Used `ce kiln-runpod-session` capacity probes; no raw SSH polling loops. | Done. |
| Next training is command-stable | `scripts/run_next_clean_grpo.sh` for v3 offset 2. | Done, pending GPU. |
| Next eval is command-stable and cache-busted | `scripts/evaluate_next_adapter.sh`; `evaluate_adapter.py` appends eval ledger rows. | Done, pending adapter. |

## Current Blockers
- RunPod capacity: repeated bounded probes for A6000/H100/A100 returned retryable `no instances available`.
- No completed, cache-busted, improved adapter exists yet.
- The staged `1200/1200` offline contrast run may OOM on A6000; fallback is `COMPLETION_BUDGET=900`.

## Next Concrete Action
When bounded GPU capacity returns:
1. Acquire clean GPU.
2. Start Kiln at `f3492bec`, BF16 path, `KILN_W4A16=0`.
3. Sync lab to pod.
4. Run `scripts/run_next_clean_grpo.sh`.
5. Archive adapter and sync.
6. Run `scripts/evaluate_next_adapter.sh`.
7. Append/evaluate verdict and sync B2.
