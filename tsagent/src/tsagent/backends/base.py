"""模型 API 的公共契约。

默认 backend 不连接。测试或后续接入可以传入 `invoke`，也可以子类化并覆盖 `_invoke`。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from tsagent.stats import enforce_quantile_order
from tsagent.types import ForecastRequest, ForecastResult, ModelSpec, quantile_key


class ModelAPINotConnected(RuntimeError):
    """模型目录里有这个 TSFM，但预测 API 还没接上。"""


@dataclass
class RawForecast:
    """adapter 交回编排器的一次预测。分位数键用 quantile_key。"""

    point: tuple[float, ...]
    quantiles: dict[str, tuple[float, ...]] | None = None


@dataclass(frozen=True)
class BackendStatus:
    connected: bool
    detail: str


Invoke = Callable[[ModelSpec, ForecastRequest], RawForecast]


class TSFMBackend(Protocol):
    family: str
    name: str

    def status(self) -> BackendStatus: ...

    def forecast(self, model: ModelSpec, request: ForecastRequest) -> ForecastResult: ...


class DisconnectedBackend:
    """家族 backend 的基类。未覆盖 `_invoke` 时，预测结果是 unavailable。"""

    family = ""
    name = ""
    hint = "模型 API 还没有接入。"

    def __init__(self, invoke: Invoke | None = None) -> None:
        self._invoke_override = invoke

    def status(self) -> BackendStatus:
        if self._connected_invoke() is None:
            return BackendStatus(False, self.hint)
        return BackendStatus(True, "invoke 已接入")

    def forecast(self, model: ModelSpec, request: ForecastRequest) -> ForecastResult:
        if model.family != self.family:
            return error_result(model.id, request.horizon, "error", f"{self.name} 不接受 {model.family} 模型")
        invoke = self._connected_invoke()
        if invoke is None:
            return error_result(model.id, request.horizon, "unavailable", self.hint)
        try:
            raw = invoke(model, request)
        except ModelAPINotConnected as exc:
            return error_result(model.id, request.horizon, "unavailable", str(exc))
        except Exception as exc:
            return error_result(model.id, request.horizon, "error", f"{self.name} 调用失败: {exc}")
        return result_from_raw(model, request, raw)

    def _invoke(self, model: ModelSpec, request: ForecastRequest) -> RawForecast:
        raise ModelAPINotConnected(self.hint)

    def _connected_invoke(self) -> Invoke | None:
        if self._invoke_override is not None:
            return self._invoke_override
        if type(self)._invoke is not DisconnectedBackend._invoke:
            return self._invoke
        return None


def result_from_raw(model: ModelSpec, request: ForecastRequest, raw: RawForecast) -> ForecastResult:
    """检查 adapter 的输出长度，并保证分位数不交叉。"""
    if len(raw.point) != request.horizon:
        return error_result(
            model.id,
            request.horizon,
            "error",
            f"点预测长度是 {len(raw.point)}，应为 {request.horizon}",
        )
    if any(not _finite(value) for value in raw.point):
        return error_result(model.id, request.horizon, "error", "点预测含有非有限值")
    point = tuple(float(value) for value in raw.point)
    if raw.quantiles is None:
        quantiles = {quantile_key(level): point for level in request.quantiles}
        message = "API 未返回分位数，已用点预测填充"
    else:
        quantiles = {}
        for level in request.quantiles:
            key = quantile_key(level)
            values = raw.quantiles.get(key)
            if values is None:
                return error_result(model.id, request.horizon, "error", f"缺少分位数 {key}")
            if len(values) != request.horizon:
                return error_result(model.id, request.horizon, "error", f"分位数 {key} 长度不对")
            if any(not _finite(value) for value in values):
                return error_result(model.id, request.horizon, "error", f"分位数 {key} 含有非有限值")
            quantiles[key] = tuple(float(value) for value in values)
        quantiles = enforce_quantile_order(request.quantiles, quantiles)
        message = ""
    return ForecastResult(
        model_id=model.id,
        status="ok",
        execution="native",
        horizon=request.horizon,
        point=point,
        quantiles=quantiles,
        chunks=1,
        message=message,
    )


def error_result(model_id: str, horizon: int, status: str, message: str) -> ForecastResult:
    return ForecastResult(
        model_id=model_id,
        status=status,
        execution="none",
        horizon=horizon,
        point=(),
        quantiles={},
        chunks=0,
        message=message,
    )


def _finite(value: float) -> bool:
    return value == value and value not in {float("inf"), float("-inf")}
