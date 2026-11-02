---
name: tsfm-orchestrate
description: Plan and run a time-series forecast by orchestrating Google TimesFM and Amazon Chronos through the tsagent CLI. Use when the task is forecasting, backtesting, model selection, or comparing TSFM models.
---

# TSFM orchestration

Use the `tsagent` package in this repo. Do not import `timesfm` or `chronos`, and do not add a forecast implementation to the stub.

Run commands from the repository root with the `pi-time` conda environment:

```bash
conda run -n pi-time python -m tsagent catalog
conda run -n pi-time python -m tsagent backends
conda run -n pi-time python -m tsagent plan --task tsagent/examples/task.json
conda run -n pi-time python -m tsagent run --task tsagent/examples/task.json --json
```

Model APIs are not connected. `backends` reports `google.timesfm` and `amazon.chronos` as not connected. The default fallback is `stub`: the plan names real model ids, and execution is deterministic and labeled `execution: stub`. A recommendation with `basis: stub` means the pipeline ran. It is not a comparison of TimesFM and Chronos.

Use `--fallback strict` when a real forecast is required. Unconnected models then return `status: unavailable` and an empty `point`. Do not fill that gap with another model's numbers.

Choose models by editing the task or passing `--models`:

- `auto`: the highest-scoring eligible model from each family. Covariates leave only `amazon/chronos-2`.
- `all`: every model that passes the task constraints.
- an explicit comma-separated list of Hugging Face repo ids from `catalog`.

To connect an API later, subclass `GoogleTimesFMBackend` or `AmazonChronosBackend` and implement `_invoke`. The call shapes are in those modules. After `_invoke` exists, the registry uses the native backend without a change to the planner.
