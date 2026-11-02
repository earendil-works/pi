"""时序任务、模型目录和预测结果的数据结构。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, is_dataclass
from typing import Any


def quantile_key(level: float) -> str:
    """把分位数格式化成稳定的字典键，例如 0.10 与 0.1 都是 '0.1'。"""
    return format(float(level), ".6g")


@dataclass(frozen=True)
class ModelSpec:
    """一个可编排的 TSFM。`id` 与 Hugging Face repo id 相同。"""

    id: str
    family: str
    display_name: str
    max_context: int
    max_horizon: int
    quantile_mode: str
    supports_covariates: bool
    supports_multivariate: bool
    requires_freq_token: bool
    supports_chunking: bool
    preference: float
    context_plus_horizon_limit: int | None = None
    notes: str = ""


@dataclass(frozen=True)
class TimeSeries:
    series_id: str
    target: tuple[float, ...]
    timestamps: tuple[str, ...] | None
    freq: str | None
    covariates: dict[str, tuple[float, ...]]
    target_name: str
    missing_filled: int = 0


@dataclass(frozen=True)
class SeriesProfile:
    series_id: str
    target_name: str
    length: int
    freq: str | None
    seasonal_period: int
    missing_filled: int
    start: str | None
    end: str | None
    covariate_names: tuple[str, ...]
    min_value: float
    max_value: float


@dataclass(frozen=True)
class ForecastRequest:
    """一次预测请求。

    `past_covariates` 与原始历史等长。编排器滚动拼接时，如果窗口超出原始历史，
    该次调用不再附带过去协变量。`future_covariates` 与完整 `horizon` 等长，
    滚动时按窗口切片。
    """

    series_id: str
    values: tuple[float, ...]
    horizon: int
    quantiles: tuple[float, ...]
    freq: str | None
    target_name: str
    timestamps: tuple[str, ...] | None = None
    past_covariates: dict[str, tuple[float, ...]] | None = None
    future_covariates: dict[str, tuple[float, ...]] | None = None


@dataclass(frozen=True)
class ForecastResult:
    model_id: str
    status: str
    execution: str
    horizon: int
    point: tuple[float, ...]
    quantiles: dict[str, tuple[float, ...]]
    chunks: int
    message: str


@dataclass(frozen=True)
class ModelPlan:
    model_id: str
    family: str
    score: float
    chunks: int
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class Rejection:
    model_id: str
    reason: str


@dataclass(frozen=True)
class Plan:
    mode: str
    models: tuple[ModelPlan, ...]
    rejections: tuple[Rejection, ...]


@dataclass(frozen=True)
class ModelMetrics:
    model_id: str
    execution: str
    mae: float
    rmse: float
    mape: float | None
    smape: float
    mase: float | None


@dataclass(frozen=True)
class ForecastTask:
    horizon: int
    series: TimeSeries | None = None
    series_path: str | None = None
    time_column: str | None = None
    target: str = "target"
    freq: str | None = None
    quantiles: tuple[float, ...] = (0.1, 0.5, 0.9)
    holdout: bool = False
    models: str | tuple[str, ...] = "auto"
    ensemble: str = "mean"
    fallback: str = "stub"
    covariate_columns: tuple[str, ...] = ()
    task_id: str = "task"
    future_covariates: dict[str, tuple[float, ...]] | None = None


@dataclass(frozen=True)
class StepRecord:
    name: str
    detail: str


@dataclass(frozen=True)
class Recommendation:
    model_id: str | None
    basis: str
    note: str


@dataclass(frozen=True)
class PreparedTask:
    series: TimeSeries
    profile: SeriesProfile
    request: ForecastRequest
    plan: Plan
    actual: tuple[float, ...] | None


@dataclass(frozen=True)
class AgentReport:
    task_id: str
    profile: SeriesProfile
    plan: Plan
    runs: tuple[ForecastResult, ...]
    ensemble: ForecastResult | None
    metrics: tuple[ModelMetrics, ...]
    recommendation: Recommendation
    steps: tuple[StepRecord, ...]
    holdout_actual: tuple[float, ...] | None
    fallback: str


def to_jsonable(value: Any) -> Any:
    """把 dataclass 转成 json.dumps 可接受的对象。"""
    if is_dataclass(value) and not isinstance(value, type):
        return {key: to_jsonable(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [to_jsonable(item) for item in value]
    return value
