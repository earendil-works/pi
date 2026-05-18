# v014 BF16 diagnostic

exit_code=0

## Log tail
[36m=== kiln-runpod image ===[0m
  GPU: NVIDIA RTX A6000, 570.195.03
  CUDA toolkit: release 12.4
  nsys: NVIDIA Nsight Systems version 2023.4.4.54-234433681190v0
  rustc: 1.95.0 | cargo: 1.95.0
  sccache: 0.9.1 | nextest: (1d5bf1ec9
  torch: 2.4.1+cu124 (cuda=12.4)

Quick start: [32mkiln-setup[0m (configures sccache+B2) then clone kiln & build.

{
  "mean_reward": 0.29981531135531136,
  "job": {
    "job_id": "418b42c5-4f6f-48ac-b8c4-576e51545178",
    "state": "completed",
    "progress": 1.0,
    "current_loss": 0.0009744465310956296,
    "adapter_name": "pi-compaction-grpo-v014-a6000-f349-bf16-r4",
    "started_at": "20s ago",
    "elapsed_secs": 20.007485237,
    "submitted_unix_ms": 1779107917124,
    "finished_unix_ms": 1779107933150,
    "job_type": "grpo"
  },
  "results_dir": "/workspace/pi-compaction-grpo/results/20260518T123837Z-pi-compaction-grpo-v014-a6000-f349-bf16-r4"
}
