# tsagent

时序 agent。它读取一条序列，按约束选择 Google TimesFM 和 Amazon Chronos，执行预测，并在有回测段时计算误差。

模型 API 还没有接入。默认 `fallback=stub`：计划里仍然是真实的模型 id，执行时走确定性 stub，用来把编排跑通。`fallback=strict` 会返回 `unavailable`，不会编造预测。

## 环境

仓库使用的 conda 环境是 `pi-time`：Python 3.11 给这里的编排器，Node.js 22.23 给原来的 Pi harness。

```bash
conda activate pi-time
pip install -e ./tsagent
```

已有环境时也可以直接：

```bash
conda run -n pi-time python -m tsagent --help
```

## 命令

在仓库根目录：

```bash
conda run -n pi-time python -m tsagent catalog
conda run -n pi-time python -m tsagent backends
conda run -n pi-time python -m tsagent plan --task tsagent/examples/task.json
conda run -n pi-time python -m tsagent run --task tsagent/examples/task.json
```

`examples/task.json` 是不带协变量的 24 步回测，自动计划会各留一个 Google 模型和一个 Amazon 模型。`examples/task_covariates.json` 使用 `temperature`，自动计划只留 `amazon/chronos-2`，因为目录里只有它接受协变量。

常用参数：

- `--models auto|all|id,id`：自动每族一个、全部可行模型，或指定 id
- `--fallback stub|strict`
- `--holdout` / `--no-holdout`
- `--json` 和 `--output report.json`

## 目录里的模型

| 模型 | 上下文 | 单次步长 | 协变量 |
|---|---:|---:|---|
| `google/timesfm-1.0-200m-pytorch` | 2048 | 128 | 否 |
| `google/timesfm-2.0-500m-pytorch` | 2048 | 128 | 否 |
| `google/timesfm-2.5-200m-pytorch` | 16384 | 1024 | 否 |
| `amazon/chronos-t5-small` / `base` / `large` | 512 | 64 | 否 |
| `amazon/chronos-bolt-small` / `base` | 2048 | 64 | 否 |
| `amazon/chronos-2` | 8192 | 1024 | 是 |

步长超过单次上限时，编排器用上一段点预测滚动拼接。TimesFM 2.5 还有「上下文 + 单次步长 ≤ 16384」的限制，窗口会先截到最近的上下文。

当前 runner 一次只预测一个目标。Chronos-2 的多变量能力记在目录里，还没有单独的任务格式。

## 接入模型 API

不要在 stub 里调用真实库。接入方式是子类化对应 backend，实现 `_invoke(model, request) -> RawForecast`：

- `tsagent.backends.google_timesfm.GoogleTimesFMBackend`
- `tsagent.backends.amazon_chronos.AmazonChronosBackend`

两个文件的模块文档写了 TimesFM 2.5、TimesFM 1.0/2.0、Chronos-2 和 Chronos-Bolt 的调用形状。`_invoke` 返回点预测，以及用 `quantile_key` 做键的分位数。子类一旦覆盖 `_invoke`，`status().connected` 变为真，编排器就会停用 stub。

构造时传入 `invoke=` 只用于测试或临时适配，效果与子类相同。

接入之后，回测 MAE 只在 `execution == "native"` 的结果里选模型。全是 stub 时报告的 `recommendation.basis` 是 `stub`，不会宣布哪个基础模型更好。

## 测试

```bash
conda run -n pi-time python -m pytest tsagent/tests
```
