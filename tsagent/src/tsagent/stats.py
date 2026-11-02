"""分位数排序和标准正态分位函数。不依赖 SciPy。"""

from __future__ import annotations

import math

from tsagent.types import quantile_key

_ACKLAM_A = (
    -3.969683028665376e01,
    2.209460984245205e02,
    -2.759285104469687e02,
    1.383577518672690e02,
    -3.066479806614716e01,
    2.506628277459239e00,
)
_ACKLAM_B = (
    -5.447609879822406e01,
    1.615858368580409e02,
    -1.556989798598866e02,
    6.680131188771972e01,
    -1.328068155288572e01,
)
_ACKLAM_C = (
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e00,
    -2.549732539343734e00,
    4.374664141464968e00,
    2.938163982698783e00,
)
_ACKLAM_D = (
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e00,
    3.754408661907416e00,
)


def norm_ppf(probability: float) -> float:
    """标准正态分位函数的 Acklam 近似。"""
    if probability <= 0 or probability >= 1:
        raise ValueError("概率必须在 (0, 1) 内")
    plow = 0.02425
    phigh = 1 - plow
    if probability < plow:
        q = math.sqrt(-2 * math.log(probability))
        return _horner(_ACKLAM_C, q) / (_horner(_ACKLAM_D, q) * q + 1)
    if probability > phigh:
        q = math.sqrt(-2 * math.log(1 - probability))
        return -_horner(_ACKLAM_C, q) / (_horner(_ACKLAM_D, q) * q + 1)
    q = probability - 0.5
    r = q * q
    return _horner(_ACKLAM_A, r) * q / (_horner(_ACKLAM_B, r) * r + 1)


def enforce_quantile_order(
    levels: tuple[float, ...],
    quantiles: dict[str, tuple[float, ...]],
) -> dict[str, tuple[float, ...]]:
    """每个时间步上按分位数从小到大重排，避免交叉。"""
    keys = [quantile_key(level) for level in levels]
    if not keys:
        return {}
    rows = zip(*(quantiles[key] for key in keys), strict=True)
    ordered = [tuple(sorted(row)) for row in rows]
    if not ordered:
        return {key: () for key in keys}
    columns = list(zip(*ordered, strict=True))
    return {key: tuple(columns[index]) for index, key in enumerate(keys)}


def _horner(coefficients: tuple[float, ...], value: float) -> float:
    total = 0.0
    for coefficient in coefficients:
        total = total * value + coefficient
    return total
