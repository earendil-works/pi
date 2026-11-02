"""执行计划：截断上下文、按模型上限滚动，并汇总多次预测。"""

from __future__ import annotations

import math
from dataclasses import replace

from tsagent.backends.base import TSFMBackend, error_result
from tsagent.backends.registry import BackendRegistry
from tsagent.catalog import get_model
from tsagent.types import ForecastRequest, ForecastResult, ModelSpec, Plan, quantile_key


def execute_plan(
    plan: Plan,
    request: ForecastRequest,
    registry: BackendRegistry,
) -> tuple[ForecastResult, ...]:
    """按计划顺序执行。一个模型失败不会取消其他模型。"""
    results = []
    for item in plan.models:
        model = get_model(item.model_id)
        backend, _execution = registry.resolve(model)
        results.append(forecast_model(model, request, backend))
    return tuple(results)


def forecast_model(model: ModelSpec, request: ForecastRequest, backend: TSFMBackend) -> ForecastResult:
    """对一个模型完成预测。超过单次步长时，用点预测滚动拼接。"""
    problem = validate_request(model, request)
    if problem is not None:
        return error_result(model.id, request.horizon, "error", problem)

    context = list(request.values)
    points: list[float] = []
    collected: dict[str, list[float]] = {}
    messages: list[str] = []
    dropped_covariates = False
    offset = 0
    attempts = 0
    execution = "none"
    while offset < request.horizon:
        step = min(model.max_horizon, request.horizon - offset)
        window, window_error = _window(model, request, context, offset, step)
        if window_error is not None or window is None:
            return error_result(model.id, request.horizon, "error", window_error or "无法切出预测窗口")
        if request.past_covariates is not None and window.past_covariates is None:
            dropped_covariates = True
        part = backend.forecast(model, window)
        attempts += 1
        if part.status != "ok":
            return replace(part, chunks=attempts)
        if len(part.point) != step:
            return error_result(
                model.id,
                request.horizon,
                "error",
                f"单段点预测长度是 {len(part.point)}，应为 {step}",
            )
        execution = part.execution
        points.extend(part.point)
        for key, values in part.quantiles.items():
            if len(values) != step:
                return error_result(model.id, request.horizon, "error", f"分位数 {key} 的单段长度不对")
            collected.setdefault(key, []).extend(values)
        if part.message and part.message not in messages:
            messages.append(part.message)
        context.extend(part.point)
        offset += step

    if dropped_covariates:
        messages.append("滚动到预测段之后不再附带协变量")
    if attempts > 1:
        messages.append(f"{attempts} 段滚动拼接")
    quantiles: dict[str, tuple[float, ...]] = {}
    for level in request.quantiles:
        key = quantile_key(level)
        values = collected.get(key)
        if values is None or len(values) != request.horizon:
            return error_result(model.id, request.horizon, "error", f"分位数 {key} 没有覆盖完整预测步长")
        quantiles[key] = tuple(values)
    return ForecastResult(
        model_id=model.id,
        status="ok",
        execution=execution,
        horizon=request.horizon,
        point=tuple(points),
        quantiles=quantiles,
        chunks=attempts,
        message="；".join(message for message in messages if message),
    )


def ensemble_mean(results: tuple[ForecastResult, ...]) -> ForecastResult | None:
    """对成功的预测取平均。少于两个成功结果时不构造集成。"""
    ok = [result for result in results if result.status == "ok"]
    if len(ok) < 2:
        return None
    horizon = ok[0].horizon
    if any(len(result.point) != horizon for result in ok):
        return None
    point = tuple(sum(result.point[index] for result in ok) / len(ok) for index in range(horizon))
    shared = set(ok[0].quantiles)
    for result in ok[1:]:
        shared &= set(result.quantiles)
    quantiles = {
        key: tuple(sum(result.quantiles[key][index] for result in ok) / len(ok) for index in range(horizon))
        for key in sorted(shared, key=float)
    }
    executions = {result.execution for result in ok}
    execution = executions.pop() if len(executions) == 1 else "mixed"
    return ForecastResult(
        model_id="ensemble/mean",
        status="ok",
        execution=execution,
        horizon=horizon,
        point=point,
        quantiles=quantiles,
        chunks=1,
        message=f"对 {len(ok)} 个模型的点预测和共有分位数取平均",
    )


def validate_request(model: ModelSpec, request: ForecastRequest) -> str | None:
    """检查一次完整请求。滚动窗口由编排器自己保证对齐。"""
    if request.horizon < 1:
        return "horizon 必须是正整数"
    if len(request.values) < 2:
        return "历史至少需要 2 个点"
    if any(not math.isfinite(value) for value in request.values):
        return "历史含有非有限值"
    if not request.quantiles or tuple(sorted(set(request.quantiles))) != request.quantiles:
        return "分位数必须严格递增且不重复"
    if any(level <= 0 or level >= 1 for level in request.quantiles):
        return "分位数必须在 (0, 1) 内"
    if request.past_covariates is not None:
        if not model.supports_covariates:
            return "该模型不接受协变量"
        for name, values in request.past_covariates.items():
            if len(values) != len(request.values):
                return f"过去协变量 {name} 长度应为 {len(request.values)}"
            if any(not math.isfinite(value) for value in values):
                return f"过去协变量 {name} 含有非有限值"
    if request.future_covariates is not None:
        if not model.supports_covariates:
            return "该模型不接受协变量"
        if request.past_covariates is None:
            return "未来协变量缺少对应的历史协变量"
        extra = set(request.future_covariates) - set(request.past_covariates)
        if extra:
            return "未来协变量必须是历史协变量的子集"
        for name, values in request.future_covariates.items():
            if len(values) != request.horizon:
                return f"未来协变量 {name} 长度应为 {request.horizon}"
            if any(not math.isfinite(value) for value in values):
                return f"未来协变量 {name} 含有非有限值"
    return None


def _window(
    model: ModelSpec,
    request: ForecastRequest,
    context: list[float],
    offset: int,
    horizon: int,
) -> tuple[ForecastRequest | None, str | None]:
    budget = model.max_context
    if model.context_plus_horizon_limit is not None:
        budget = min(budget, model.context_plus_horizon_limit - horizon)
    if budget < 1:
        limit = model.context_plus_horizon_limit
        return None, f"{model.id} 无法容纳 {horizon} 步预测，上下文加步长上限是 {limit}"
    trimmed = context[-budget:]
    return (
        ForecastRequest(
            series_id=request.series_id,
            values=tuple(trimmed),
            horizon=horizon,
            quantiles=request.quantiles,
            freq=request.freq,
            target_name=request.target_name,
            past_covariates=_past_for_window(request, len(context), len(trimmed)),
            future_covariates=_future_for_window(request, offset, horizon),
        ),
        None,
    )


def _past_for_window(
    request: ForecastRequest,
    full_length: int,
    trimmed_length: int,
) -> dict[str, tuple[float, ...]] | None:
    if request.past_covariates is None:
        return None
    original_length = len(request.values)
    start = full_length - trimmed_length
    end = full_length
    if end > original_length:
        return None
    return {name: values[start:end] for name, values in request.past_covariates.items()}


def _future_for_window(
    request: ForecastRequest,
    offset: int,
    horizon: int,
) -> dict[str, tuple[float, ...]] | None:
    if request.future_covariates is None:
        return None
    return {name: values[offset : offset + horizon] for name, values in request.future_covariates.items()}
