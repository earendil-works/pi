import math

from tsagent.agent import TimeSeriesAgent
from tsagent.types import ForecastTask, TimeSeries


def _series(length: int = 240, covariates: bool = False) -> TimeSeries:
    target = tuple(50 + 0.01 * step + 8 * math.sin(2 * math.pi * step / 24) for step in range(length))
    columns: dict[str, tuple[float, ...]] = {}
    if covariates:
        columns["temperature"] = tuple(15 + 10 * math.sin(2 * math.pi * (step - 8) / 24) for step in range(length))
    return TimeSeries("series", target, None, "h", columns, "load")


def test_auto_plan_keeps_one_model_from_each_family():
    task = ForecastTask(horizon=24, series=_series(), holdout=True)
    prepared = TimeSeriesAgent().prepare(task)
    assert [item.model_id for item in prepared.plan.models] == [
        "google/timesfm-2.5-200m-pytorch",
        "amazon/chronos-2",
    ]
    assert prepared.profile.length == 216
    assert all(item.chunks == 1 for item in prepared.plan.models)


def test_covariates_leave_only_chronos_2():
    task = ForecastTask(horizon=12, series=_series(covariates=True), holdout=True, covariate_columns=("temperature",))
    prepared = TimeSeriesAgent().prepare(task)
    assert [item.model_id for item in prepared.plan.models] == ["amazon/chronos-2"]
    assert any("协变量" in item.reason for item in prepared.plan.rejections)
    assert prepared.request.past_covariates is not None
    assert len(prepared.request.future_covariates["temperature"]) == 12


def test_explicit_model_with_covariates_is_rejected():
    task = ForecastTask(
        horizon=12,
        series=_series(covariates=True),
        models=("google/timesfm-2.5-200m-pytorch",),
    )
    prepared = TimeSeriesAgent().prepare(task)
    assert prepared.plan.models == ()
    assert prepared.plan.rejections[0].model_id == "google/timesfm-2.5-200m-pytorch"


def test_unknown_model_is_reported():
    task = ForecastTask(horizon=4, series=_series(length=16), models=("missing/model",))
    prepared = TimeSeriesAgent().prepare(task)
    assert prepared.plan.rejections[0].reason == "目录中没有这个模型"
