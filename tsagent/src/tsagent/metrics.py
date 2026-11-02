"""回测误差。MAPE 在真值为 0 时返回 None，MASE 在尺度为 0 时返回 None。"""

from __future__ import annotations

import math

from tsagent.types import ModelMetrics


def score_forecast(
    model_id: str,
    execution: str,
    actual: tuple[float, ...],
    point: tuple[float, ...],
    history: tuple[float, ...],
    period: int,
) -> ModelMetrics:
    if len(actual) != len(point) or not actual:
        raise ValueError("实际值与点预测长度必须相同且非空")
    errors = [point[index] - actual[index] for index in range(len(actual))]
    mae = sum(abs(error) for error in errors) / len(errors)
    rmse = math.sqrt(sum(error * error for error in errors) / len(errors))
    return ModelMetrics(
        model_id=model_id,
        execution=execution,
        mae=mae,
        rmse=rmse,
        mape=_mape(actual, errors),
        smape=_smape(actual, point),
        mase=_mase(errors, history, period),
    )


def _mape(actual: tuple[float, ...], errors: list[float]) -> float | None:
    if any(value == 0 for value in actual):
        return None
    return sum(abs(errors[index]) / abs(actual[index]) for index in range(len(actual))) / len(actual)


def _smape(actual: tuple[float, ...], point: tuple[float, ...]) -> float:
    total = 0.0
    for actual_value, forecast_value in zip(actual, point, strict=True):
        denominator = abs(actual_value) + abs(forecast_value)
        if denominator == 0:
            continue
        total += 2 * abs(forecast_value - actual_value) / denominator
    return total / len(actual)


def _mase(errors: list[float], history: tuple[float, ...], period: int) -> float | None:
    step = period if period >= 2 and period < len(history) else 1
    if len(history) <= step:
        return None
    scale = sum(abs(history[index] - history[index - step]) for index in range(step, len(history)))
    scale /= len(history) - step
    if scale == 0:
        return None
    return (sum(abs(error) for error in errors) / len(errors)) / scale
