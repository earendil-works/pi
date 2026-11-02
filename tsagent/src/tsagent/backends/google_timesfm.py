"""Google TimesFM。

接入时子类化 GoogleTimesFMBackend，实现 `_invoke(model, request) -> RawForecast`，
或者构造时传入 `invoke`。不要在这个文件里导入 `timesfm`。

TimesFM 2.5（`google/timesfm-2.5-200m-pytorch`）的调用形状：

    forecaster = timesfm.TimesFM_2p5_200M_torch.from_pretrained(model.id)
    forecaster.compile(timesfm.ForecastConfig(
        max_context=min(len(request.values), model.max_context),
        max_horizon=request.horizon,
        normalize_inputs=True,
        use_continuous_quantile_head=True,
        fix_quantile_crossing=True,
    ))
    point, quantiles = forecaster.forecast(request.horizon, [np.asarray(request.values)])

`point` 的形状是 (1, H)。`quantiles` 的形状是 (1, H, 10)，依次为 mean、0.1 到 0.9。
点预测对应 0.5 分位。返回 RawForecast 时丢掉 mean，只保留请求的分位数。

TimesFM 1.0 / 2.0 使用 `TimesFm` 和 `TimesFmCheckpoint`，`forecast` 需要
`freq=[timesfm_freq_token(request.freq)]`。这两个版本 `requires_freq_token` 为真。
"""

from __future__ import annotations

from tsagent.backends.base import DisconnectedBackend


class GoogleTimesFMBackend(DisconnectedBackend):
    family = "google"
    name = "google.timesfm"
    hint = (
        "Google TimesFM API 还没有接入。"
        "子类化 GoogleTimesFMBackend 并实现 _invoke，或在构造时传入 invoke。"
    )
