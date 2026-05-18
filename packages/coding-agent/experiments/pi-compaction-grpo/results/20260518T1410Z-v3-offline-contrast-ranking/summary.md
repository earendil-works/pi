# v3 Offline Contrast Ranking

## Status
- Ran a full local dry run over all 24 v3 prompts:
  - `python3 scripts/run_compaction_contrast_iteration.py --prompts data/trajectory-compaction-prompts-v3.jsonl --offset 0 --limit 24 --adapter pi-compaction-grpo-v034-offline-contrast-v3-c1200-rank-dryrun --source-char-budget 1200 --completion-char-budget 1200 --lora-rank 4 --learning-rate 1e-5 --offline-contrast --dry-run --no-auto-load`
- Result directory: `results/20260518T140931Z-pi-compaction-grpo-v034-offline-contrast-v3-c1200-rank-dryrun`.

## Best Rows By Reward Delta
| offset | delta | positive | negative | positive chars |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 0.5367 | 0.7414 | 0.2047 | 1178 |
| 15 | 0.5202 | 0.7249 | 0.2047 | 1106 |
| 9 | 0.5152 | 0.7278 | 0.2127 | 1189 |
| 6 | 0.4970 | 0.6977 | 0.2007 | 1092 |
| 0 | 0.4929 | 0.6936 | 0.2007 | 1050 |
| 11 | 0.4886 | 0.7533 | 0.2647 | 1068 |

## Next GPU Choice
- First submit offset `2` with `1200/1200` if memory allows.
- If A6000 BF16 OOMs, retry the same offset with `completion-char-budget 900` or wait for H100/A100.
