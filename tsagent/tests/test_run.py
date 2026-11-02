import math

from tsagent.agent import TimeSeriesAgent
from tsagent.backends.amazon_chronos import AmazonChronosBackend
from tsagent.backends.base import RawForecast
from tsagent.backends.google_timesfm import GoogleTimesFMBackend
from tsagent.backends.registry import BackendRegistry
from tsagent.catalog import get_model
from tsagent.orchestrator import forecast_model
from tsagent.series import load_csv
from tsagent.types import ForecastRequest, ForecastTask, TimeSeries, quantile_key


def _series(length: int = 240) -> TimeSeries:
    target = tuple(50 + 0.01 * step + 8 * math.sin(2 * math.pi * step / 24) for step in range(length))
    return TimeSeries("series", target, None, "h", {}, "load")


def _constant(length: int = 20) -> TimeSeries:
    return TimeSeries("flat", tuple(1.0 for _ in range(length)), None, "h", {}, "load")


def test_stub_forecast_shape_and_quantile_order():
    report = TimeSeriesAgent().run(ForecastTask(horizon=24, series=_series(), holdout=True, task_id="demo"))
    assert [step.name for step in report.steps] == [
        "ingest",
        "profile",
        "plan",
        "execute",
        "evaluate",
        "recommend",
    ]
    assert report.recommendation.basis == "stub"
    assert report.ensemble is not None
    assert len(report.metrics) == 3
    for run in report.runs:
        assert run.status == "ok"
        assert run.execution == "stub"
        assert len(run.point) == 24
        keys = ["0.1", "0.5", "0.9"]
        for index in range(24):
            values = [run.quantiles[key][index] for key in keys]
            assert values == sorted(values)
    first = (report.runs[0].point[0] + report.runs[1].point[0]) / 2
    assert report.ensemble.point[0] == first


def test_long_horizon_is_chunked_and_future_covariates_are_sliced():
    seen: list[tuple[int, int, int | None]] = []

    def invoke(model, request):
        future_length = None
        if request.future_covariates is not None:
            future_length = len(next(iter(request.future_covariates.values())))
        seen.append((request.horizon, len(request.values), future_length))
        point = tuple(float(len(request.values)) for _ in range(request.horizon))
        quantiles = {quantile_key(level): point for level in request.quantiles}
        return RawForecast(point=point, quantiles=quantiles)

    history = tuple(float(index) for index in range(80))
    future = {"temperature": tuple(float(index) for index in range(1500))}
    past = {"temperature": tuple(0.0 for _ in history)}
    request = ForecastRequest(
        series_id="long",
        values=history,
        horizon=1500,
        quantiles=(0.1, 0.5, 0.9),
        freq="h",
        target_name="load",
        past_covariates=past,
        future_covariates=future,
    )
    result = forecast_model(get_model("amazon/chronos-2"), request, AmazonChronosBackend(invoke=invoke))
    assert result.status == "ok"
    assert result.chunks == 2
    assert len(result.point) == 1500
    assert seen == [(1024, 80, 1024), (476, 1104, 476)]
    assert "2 段滚动拼接" in result.message
    assert "不再附带协变量" in result.message


def test_context_keeps_the_recent_tail():
    seen: list[tuple[float, ...]] = []

    def invoke(model, request):
        seen.append(request.values)
        point = tuple(0.0 for _ in range(request.horizon))
        return RawForecast(point=point)

    values = tuple(float(index) for index in range(3000))
    request = ForecastRequest("wide", values, 10, (0.5,), "h", "load")
    result = forecast_model(
        get_model("google/timesfm-1.0-200m-pytorch"),
        request,
        GoogleTimesFMBackend(invoke=invoke),
    )
    assert result.status == "ok"
    assert len(seen) == 1
    assert len(seen[0]) == 2048
    assert seen[0][-1] == 2999


def test_strict_mode_does_not_invent_a_forecast():
    report = TimeSeriesAgent(BackendRegistry(fallback="strict")).run(
        ForecastTask(horizon=8, series=_series(length=48), holdout=False)
    )
    assert report.runs
    assert {run.status for run in report.runs} == {"unavailable"}
    assert report.recommendation.basis == "none"
    assert report.ensemble is None


def test_native_holdout_picks_the_lower_mae():
    def constant(value: float):
        def invoke(model, request):
            point = tuple(value for _ in range(request.horizon))
            return RawForecast(point=point, quantiles={quantile_key(level): point for level in request.quantiles})

        return invoke

    registry = BackendRegistry(
        fallback="strict",
        google=GoogleTimesFMBackend(invoke=constant(1.0)),
        amazon=AmazonChronosBackend(invoke=constant(0.0)),
    )
    report = TimeSeriesAgent(registry).run(ForecastTask(horizon=4, series=_constant(), holdout=True))
    assert report.recommendation.model_id == "google/timesfm-2.5-200m-pytorch"
    assert report.recommendation.basis == "holdout_mae"
    by_id = {item.model_id: item.mae for item in report.metrics}
    assert by_id["google/timesfm-2.5-200m-pytorch"] == 0
    assert by_id["amazon/chronos-2"] > 0


def test_subclass_invoke_marks_backend_connected():
    class Connected(GoogleTimesFMBackend):
        def _invoke(self, model, request):
            point = tuple(2.0 for _ in range(request.horizon))
            return RawForecast(point=point)

    backend = Connected()
    assert backend.status().connected is True
    request = ForecastRequest("s", (1.0, 2.0, 3.0), 3, (0.5,), "h", "load")
    result = backend.forecast(get_model("google/timesfm-2.5-200m-pytorch"), request)
    assert result.status == "ok"
    assert result.execution == "native"
    assert result.point == (2.0, 2.0, 2.0)


def test_csv_fills_internal_gaps_and_infers_hourly_frequency(tmp_path):
    path = tmp_path / "gap.csv"
    path.write_text(
        "timestamp,load\n"
        "2024-01-01T00:00:00,1\n"
        "2024-01-01T01:00:00,\n"
        "2024-01-01T02:00:00,3\n"
        "2024-01-01T03:00:00,4\n",
        encoding="utf-8",
    )
    series = load_csv(path, time_column="timestamp", target="load", freq=None, covariate_columns=())
    assert series.missing_filled == 1
    assert series.target[1] == 2
    assert series.freq == "h"
