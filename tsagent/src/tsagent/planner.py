"""按任务约束从目录里选模型。

自动模式在每个还能用的家族里留得分最高的一个，因此无协变量时会同时留下
TimesFM 和 Chronos。协变量是硬约束：目前只有 Chronos-2 能接。
`preference` 只用于家族内部排序，不是模型精度。
"""

from __future__ import annotations

import math

from tsagent.catalog import MODELS, get_model
from tsagent.types import ModelPlan, ModelSpec, Plan, Rejection, SeriesProfile

_FAMILY_ORDER = ("google", "amazon")


def plan_models(
    profile: SeriesProfile,
    *,
    horizon: int,
    has_covariates: bool,
    models: str | tuple[str, ...],
) -> Plan:
    """返回要执行的模型和被拒绝的模型。"""
    if models == "auto":
        mode = "auto"
        chosen, rejections = _auto(profile.length, horizon, has_covariates)
    elif models == "all":
        mode = "all"
        chosen, rejections = _explicit(
            tuple(model.id for model in MODELS),
            profile.length,
            horizon,
            has_covariates,
        )
    else:
        mode = "explicit"
        chosen, rejections = _explicit(models, profile.length, horizon, has_covariates)
    plans = tuple(_to_plan(model, profile.length, horizon) for model in chosen)
    return Plan(mode=mode, models=plans, rejections=tuple(rejections))


def _auto(length: int, horizon: int, has_covariates: bool) -> tuple[list[ModelSpec], list[Rejection]]:
    eligible, rejections = _partition(MODELS, length, horizon, has_covariates)
    chosen: list[ModelSpec] = []
    for family in _FAMILY_ORDER:
        group = [model for model in eligible if model.family == family]
        if group:
            chosen.append(max(group, key=lambda model: _score(model, length, horizon)[0]))
    chosen_ids = {model.id for model in chosen}
    for model in eligible:
        if model.id not in chosen_ids:
            rejections.append(Rejection(model.id, "同一家族里有得分更高的模型，自动计划未选它"))
    return chosen, rejections


def _explicit(
    model_ids: tuple[str, ...],
    length: int,
    horizon: int,
    has_covariates: bool,
) -> tuple[list[ModelSpec], list[Rejection]]:
    chosen: list[ModelSpec] = []
    rejections: list[Rejection] = []
    for model_id in model_ids:
        try:
            model = get_model(model_id)
        except KeyError:
            rejections.append(Rejection(model_id, "目录中没有这个模型"))
            continue
        reason = _reject_reason(model, length, horizon, has_covariates)
        if reason is None:
            chosen.append(model)
        else:
            rejections.append(Rejection(model.id, reason))
    return chosen, rejections


def _partition(
    models: tuple[ModelSpec, ...],
    length: int,
    horizon: int,
    has_covariates: bool,
) -> tuple[list[ModelSpec], list[Rejection]]:
    eligible: list[ModelSpec] = []
    rejections: list[Rejection] = []
    for model in models:
        reason = _reject_reason(model, length, horizon, has_covariates)
        if reason is None:
            eligible.append(model)
        else:
            rejections.append(Rejection(model.id, reason))
    return eligible, rejections


def _reject_reason(model: ModelSpec, length: int, horizon: int, has_covariates: bool) -> str | None:
    if length < 2:
        return "历史长度不足"
    if has_covariates and not model.supports_covariates:
        return "任务带协变量，该模型只接受单变量历史"
    if horizon > model.max_horizon and not model.supports_chunking:
        return f"预测步长 {horizon} 超过单次上限 {model.max_horizon}，且不能滚动"
    return None


def _to_plan(model: ModelSpec, length: int, horizon: int) -> ModelPlan:
    score, reasons = _score(model, length, horizon)
    return ModelPlan(
        model_id=model.id,
        family=model.family,
        score=score,
        chunks=max(1, math.ceil(horizon / model.max_horizon)),
        reasons=tuple(reasons),
    )


def _score(model: ModelSpec, length: int, horizon: int) -> tuple[float, list[str]]:
    reasons: list[str] = []
    score = model.preference
    if length <= model.max_context:
        score += 2
        reasons.append(f"上下文 {length} 不超过上限 {model.max_context}")
    else:
        score += model.max_context / length
        reasons.append(f"上下文将截断到最近 {model.max_context} 个点")
    if horizon <= model.max_horizon:
        score += 1
        reasons.append(f"预测步长 {horizon} 可以一次完成")
    else:
        chunks = math.ceil(horizon / model.max_horizon)
        score += 0.4
        reasons.append(f"预测步长分成 {chunks} 段滚动")
    if model.quantile_mode != "none":
        score += 0.5
        reasons.append("可以给出分位数")
    return score, reasons
