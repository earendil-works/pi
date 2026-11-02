"""不访问网络的确定性预测。

用季节性朴素预测加一点随模型 id 变化的漂移，让不同模型的结果可以区分。
这只用于把编排跑通，不代表 TimesFM 或 Chronos 的精度。
"""

from __future__ import annotations

import math

from tsagent.backends.base import BackendStatus
from tsagent.series import seasonal_period
from tsagent.stats import enforce_quantile_order, norm_ppf
from tsagent.types import ForecastRequest, ForecastResult, ModelSpec, quantile_key


class StubBackend:
    family = "stub"
    name = "stub"

    def status(self) -> BackendStatus:
        return BackendStatus(True, "确定性 stub，不访问模型 API")

    def forecast(self, model: ModelSpec, request: ForecastRequest) -> ForecastResult:
        point = _point_forecast(request.values, request.horizon, request.freq, model.id)
        scale = _residual_scale(request.values, seasonal_period(request.freq, len(request.values)))
        scale *= _band_scale(model)
        quantiles: dict[str, tuple[float, ...]] = {}
        for level in request.quantiles:
            z = norm_ppf(level)
            quantiles[quantile_key(level)] = tuple(
                value + z * scale * math.sqrt(step)
                for step, value in enumerate(point, start=1)
            )
        quantiles = enforce_quantile_order(request.quantiles, quantiles)
        return ForecastResult(
            model_id=model.id,
            status="ok",
            execution="stub",
            horizon=request.horizon,
            point=point,
            quantiles=quantiles,
            chunks=1,
            message="stub backend：未调用模型 API",
        )


def _point_forecast(
    values: tuple[float, ...],
    horizon: int,
    freq: str | None,
    model_id: str,
) -> tuple[float, ...]:
    period = seasonal_period(freq, len(values))
    if period > 1 and len(values) > period:
        drift = (values[-1] - values[-1 - period]) / period
    elif len(values) > 1:
        drift = values[-1] - values[-2]
    else:
        drift = 0.0
    drift *= _drift_scale(model_id)
    point: list[float] = []
    for step in range(1, horizon + 1):
        if period > 1:
            base = values[-period + ((step - 1) % period)]
        else:
            base = values[-1]
        point.append(base + drift * step)
    return tuple(point)


def _residual_scale(values: tuple[float, ...], period: int) -> float:
    if len(values) <= period:
        gaps = [abs(values[index] - values[index - 1]) for index in range(1, len(values))]
    else:
        gaps = [abs(values[index] - values[index - period]) for index in range(period, len(values))]
    if not gaps:
        return 1.0
    return max(sum(gaps) / len(gaps), 1e-6)


def _drift_scale(model_id: str) -> float:
    acc = 0
    for char in model_id:
        acc = (acc * 33 + ord(char)) % 997
    return 0.8 + (acc % 400) / 1000


def _band_scale(model: ModelSpec) -> float:
    if model.family == "google":
        return 0.85
    if "bolt" in model.id:
        return 1.0
    if model.id == "amazon/chronos-2":
        return 1.05
    return 1.2
