"""从 JSON 对象构造 ForecastTask。"""

from __future__ import annotations

from tsagent.types import ForecastTask


def parse_task(data: dict[str, object]) -> ForecastTask:
    """解析任务文件。路径是否存在留给读文件时检查。"""
    horizon = data.get("horizon")
    if isinstance(horizon, bool) or not isinstance(horizon, int):
        raise ValueError("horizon 必须是正整数")
    quantiles = _floats(data.get("quantiles", [0.1, 0.5, 0.9]), "quantiles")
    covariate_columns = _strings(data.get("covariate_columns", []), "covariate_columns")
    future_covariates = _future(data.get("future_covariates"))
    series_path = data.get("series_path")
    time_column = data.get("time_column")
    freq = data.get("freq")
    return ForecastTask(
        horizon=horizon,
        series_path=None if series_path is None else str(series_path),
        time_column=None if time_column is None else str(time_column),
        target=str(data.get("target", "target")),
        freq=None if freq is None else str(freq),
        quantiles=quantiles,
        holdout=bool(data.get("holdout", False)),
        models=_models(data.get("models", "auto")),
        ensemble=str(data.get("ensemble", "mean")),
        fallback=str(data.get("fallback", "stub")),
        covariate_columns=covariate_columns,
        task_id=str(data.get("task_id", "task")),
        future_covariates=future_covariates,
    )


def _models(value: object) -> str | tuple[str, ...]:
    if value == "auto" or value == "all":
        return str(value)
    if isinstance(value, str):
        parts = tuple(part.strip() for part in value.split(",") if part.strip())
        if len(parts) == 1 and parts[0] in {"auto", "all"}:
            return parts[0]
        return parts
    if isinstance(value, (list, tuple)):
        return tuple(str(item) for item in value)
    raise ValueError("models 必须是 auto、all，或模型 id 列表")


def _floats(value: object, name: str) -> tuple[float, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{name} 必须是数组")
    return tuple(float(item) for item in value)


def _strings(value: object, name: str) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{name} 必须是数组")
    return tuple(str(item) for item in value)


def _future(value: object) -> dict[str, tuple[float, ...]] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("future_covariates 必须是对象")
    parsed: dict[str, tuple[float, ...]] = {}
    for name, values in value.items():
        if not isinstance(values, (list, tuple)):
            raise ValueError(f"未来协变量 {name} 必须是数组")
        parsed[str(name)] = tuple(float(item) for item in values)
    return parsed
