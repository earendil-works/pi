"""Amazon Chronos。

接入时子类化 AmazonChronosBackend，实现 `_invoke(model, request) -> RawForecast`，
或者构造时传入 `invoke`。不要在这个文件里导入 `chronos`。

Chronos-2（`amazon/chronos-2`）的调用形状：

    pipeline = Chronos2Pipeline.from_pretrained(model.id, device_map="cpu")
    frame = pipeline.predict_df(
        context_df,
        future_df=future_df,
        prediction_length=request.horizon,
        quantile_levels=list(request.quantiles),
        id_column="id",
        timestamp_column="timestamp",
        target=request.target_name,
    )

`context_df` 含历史目标和过去协变量，`future_df` 只含已知未来协变量。
点预测取 0.5 分位；请求里没有 0.5 时取 `predictions` 列。

Chronos-T5 与 Chronos-Bolt 用 `BaseChronosPipeline.from_pretrained(model.id)`。
T5 的 `predict` 返回样本，Bolt 直接返回分位数。两者都不接受协变量，
编排器不会把带协变量的任务分给它们。
"""

from __future__ import annotations

from tsagent.backends.base import DisconnectedBackend


class AmazonChronosBackend(DisconnectedBackend):
    family = "amazon"
    name = "amazon.chronos"
    hint = (
        "Amazon Chronos API 还没有接入。"
        "子类化 AmazonChronosBackend 并实现 _invoke，或在构造时传入 invoke。"
    )
