"""读入序列、填补缺失，并整理成预测请求。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tsagent.types import ForecastRequest, ForecastTask, SeriesProfile, TimeSeries

_FREQ_ALIASES = {
    "H": "h",
    "h": "h",
    "1h": "h",
    "1H": "h",
    "T": "min",
    "min": "min",
    "1min": "min",
    "15min": "15min",
    "15T": "15min",
    "D": "D",
    "d": "D",
    "1D": "D",
    "B": "B",
    "W": "W",
    "W-SUN": "W",
    "M": "MS",
    "MS": "MS",
    "ME": "ME",
    "s": "s",
    "S": "s",
    "Q": "QS",
    "QS": "QS",
}

_SEASONAL_PERIODS = {
    "s": 60,
    "min": 60,
    "15min": 96,
    "h": 24,
    "D": 7,
    "B": 5,
    "W": 52,
    "MS": 12,
    "ME": 12,
    "QS": 4,
}


def normalize_freq(freq: str | None) -> str | None:
    """把常见频率别名收成一种写法。无法识别时保留原字符串。"""
    if freq is None:
        return None
    text = freq.strip()
    if not text:
        return None
    return _FREQ_ALIASES.get(text, text)


def seasonal_period(freq: str | None, length: int) -> int:
    """按频率给出季节周期。周期不短于序列本身时退回 1。"""
    period = _SEASONAL_PERIODS.get(normalize_freq(freq) or "", 1)
    if period < 2 or period >= length:
        return 1
    return period


def timesfm_freq_token(freq: str | None) -> int:
    """TimesFM 1.0 / 2.0 的频率编号：0 高频，1 中频，2 低频。"""
    norm = normalize_freq(freq)
    if norm in {None, "s", "min", "15min", "h"}:
        return 0
    if norm in {"D", "B"}:
        return 1
    return 2


def load_csv(
    path: str | Path,
    *,
    time_column: str | None,
    target: str,
    freq: str | None,
    covariate_columns: tuple[str, ...],
    series_id: str | None = None,
) -> TimeSeries:
    """从 CSV 读一条序列。内部缺失做线性填补，整列缺失则报错。"""
    frame = pd.read_csv(path)
    if target not in frame.columns:
        raise ValueError(f"CSV 缺少目标列 {target}")
    if time_column is not None and time_column not in frame.columns:
        raise ValueError(f"CSV 缺少时间列 {time_column}")
    for name in covariate_columns:
        if name not in frame.columns:
            raise ValueError(f"CSV 缺少协变量列 {name}")
        if name in {target, time_column}:
            raise ValueError(f"协变量列 {name} 不能同时是时间列或目标列")

    timestamps: tuple[str, ...] | None = None
    resolved_freq = normalize_freq(freq)
    if time_column is not None:
        stamps = pd.to_datetime(frame[time_column])
        timestamps = tuple(stamps.dt.strftime("%Y-%m-%dT%H:%M:%S").tolist())
        if resolved_freq is None:
            resolved_freq = normalize_freq(_infer_freq_text(stamps))

    values, missing = _clean_numeric(frame[target].to_numpy(), target)
    covariates: dict[str, tuple[float, ...]] = {}
    for name in covariate_columns:
        cleaned, _ = _clean_numeric(frame[name].to_numpy(), name)
        covariates[name] = tuple(cleaned)
    return TimeSeries(
        series_id=series_id or Path(path).stem,
        target=tuple(values),
        timestamps=timestamps,
        freq=resolved_freq,
        covariates=covariates,
        target_name=target,
        missing_filled=missing,
    )


def profile_series(series: TimeSeries) -> SeriesProfile:
    """汇总用于选模的序列特征。"""
    if len(series.target) < 2:
        raise ValueError("序列至少需要 2 个点")
    return SeriesProfile(
        series_id=series.series_id,
        target_name=series.target_name,
        length=len(series.target),
        freq=series.freq,
        seasonal_period=seasonal_period(series.freq, len(series.target)),
        missing_filled=series.missing_filled,
        start=None if series.timestamps is None else series.timestamps[0],
        end=None if series.timestamps is None else series.timestamps[-1],
        covariate_names=tuple(series.covariates),
        min_value=min(series.target),
        max_value=max(series.target),
    )


def build_request(series: TimeSeries, task: ForecastTask) -> tuple[ForecastRequest, tuple[float, ...] | None]:
    """按是否回测切出历史、真实未来值和协变量。"""
    _validate_quantiles(task.quantiles)
    if task.horizon < 1:
        raise ValueError("horizon 必须是正整数")
    if task.holdout and task.future_covariates is not None:
        raise ValueError("回测时未来协变量取自序列末尾，不要再传 future_covariates")
    if task.holdout and len(series.target) <= task.horizon:
        raise ValueError(f"序列长度 {len(series.target)} 不足以留出 {task.horizon} 步回测")
    if not task.holdout and len(series.target) < 2:
        raise ValueError("历史至少需要 2 个点")

    hist_end = len(series.target) - task.horizon if task.holdout else len(series.target)
    actual = series.target[hist_end:] if task.holdout else None
    past = _slice_covariates(series.covariates, 0, hist_end)
    if task.holdout:
        future = _slice_covariates(series.covariates, hist_end, len(series.target))
    else:
        future = _freeze_future(task.future_covariates)
    if future is not None and past is None:
        raise ValueError("提供了未来协变量，但序列里没有对应的历史协变量")
    if future is not None and past is not None:
        extra = set(future) - set(past)
        if extra:
            raise ValueError("未来协变量必须是历史协变量的子集: " + ", ".join(sorted(extra)))
        for name, values in future.items():
            if len(values) != task.horizon:
                raise ValueError(f"未来协变量 {name} 长度应为 {task.horizon}")
    timestamps = None if series.timestamps is None else series.timestamps[:hist_end]
    request = ForecastRequest(
        series_id=series.series_id,
        values=series.target[:hist_end],
        horizon=task.horizon,
        quantiles=task.quantiles,
        freq=series.freq,
        target_name=series.target_name,
        timestamps=timestamps,
        past_covariates=past,
        future_covariates=future,
    )
    return request, actual


def _infer_freq_text(stamps: pd.Series) -> str | None:
    """读取 pandas 推断出的频率字符串。新版本可能返回 offset，旧版本返回 str。"""
    index = pd.DatetimeIndex(stamps)
    try:
        with pd.option_context("future.infer_freq_returns_offset", True):
            inferred = pd.infer_freq(index)
    except (pd.errors.OptionError, AttributeError):
        inferred = pd.infer_freq(index)
    if inferred is None:
        return None
    if isinstance(inferred, str):
        return inferred
    freqstr = getattr(inferred, "freqstr", None)
    return freqstr if isinstance(freqstr, str) else None


def _clean_numeric(values: np.ndarray, name: str) -> tuple[list[float], int]:
    numeric = pd.to_numeric(pd.Series(values), errors="coerce")
    missing = int(numeric.isna().sum())
    if missing == len(numeric):
        raise ValueError(f"列 {name} 没有可用数值")
    filled = numeric.interpolate(method="linear", limit_direction="both")
    if bool(filled.isna().any()):
        raise ValueError(f"列 {name} 的缺失值无法填补")
    return [float(item) for item in filled.tolist()], missing


def _slice_covariates(
    covariates: dict[str, tuple[float, ...]],
    start: int,
    end: int,
) -> dict[str, tuple[float, ...]] | None:
    if not covariates:
        return None
    return {name: values[start:end] for name, values in covariates.items()}


def _freeze_future(
    covariates: dict[str, tuple[float, ...]] | None,
) -> dict[str, tuple[float, ...]] | None:
    if covariates is None:
        return None
    return {name: tuple(values) for name, values in covariates.items()}


def _validate_quantiles(quantiles: tuple[float, ...]) -> None:
    if not quantiles:
        raise ValueError("至少指定一个分位数")
    if any(level <= 0 or level >= 1 for level in quantiles):
        raise ValueError("分位数必须在 (0, 1) 内")
    if tuple(sorted(set(quantiles))) != quantiles:
        raise ValueError("分位数必须严格递增且不重复")
