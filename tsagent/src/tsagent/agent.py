"""时序 agent：读数、画像、选模、执行、回测、给出建议。"""

from __future__ import annotations

from tsagent.backends.registry import BackendRegistry
from tsagent.metrics import score_forecast
from tsagent.orchestrator import ensemble_mean, execute_plan
from tsagent.planner import plan_models
from tsagent.series import build_request, load_csv, profile_series
from tsagent.types import (
    AgentReport,
    ForecastRequest,
    ForecastResult,
    ForecastTask,
    ModelMetrics,
    Plan,
    PreparedTask,
    Recommendation,
    StepRecord,
    TimeSeries,
)


class TimeSeriesAgent:
    """编排 TimesFM 和 Chronos 的入口。

    未传入 registry 时，按任务的 fallback 创建。传入的 registry 优先于任务里的 fallback。
    """

    def __init__(self, registry: BackendRegistry | None = None) -> None:
        self.registry = registry

    def prepare(self, task: ForecastTask) -> PreparedTask:
        """完成执行前的读数、切分和选模。"""
        series = _load_series(task)
        request, actual = build_request(series, task)
        profile = profile_series(_history_view(series, request))
        has_covariates = request.past_covariates is not None or request.future_covariates is not None
        plan = plan_models(
            profile,
            horizon=task.horizon,
            has_covariates=has_covariates,
            models=task.models,
        )
        return PreparedTask(series=series, profile=profile, request=request, plan=plan, actual=actual)

    def run(self, task: ForecastTask) -> AgentReport:
        """跑完一条任务并返回可序列化的报告。"""
        if task.ensemble not in {"mean", "none"}:
            raise ValueError("ensemble 只能是 mean 或 none")
        prepared = self.prepare(task)
        registry = self.registry if self.registry is not None else BackendRegistry(fallback=task.fallback)
        steps = [
            StepRecord(
                "ingest",
                f"读入 {prepared.series.series_id}，目标 {prepared.series.target_name}，共 {len(prepared.series.target)} 个点",
            ),
            StepRecord(
                "profile",
                "历史 {length} 点，频率 {freq}，季节周期 {period}，协变量 {covariates}".format(
                    length=prepared.profile.length,
                    freq=prepared.profile.freq or "未知",
                    period=prepared.profile.seasonal_period,
                    covariates=", ".join(prepared.profile.covariate_names) or "无",
                ),
            ),
            StepRecord("plan", _plan_detail(prepared.plan)),
        ]
        runs = execute_plan(prepared.plan, prepared.request, registry)
        steps.append(StepRecord("execute", _execute_detail(runs, registry.fallback)))
        ensemble = ensemble_mean(runs) if task.ensemble == "mean" else None
        metrics = _score_all(prepared, runs, ensemble)
        if prepared.actual is None:
            steps.append(StepRecord("evaluate", "未要求回测"))
        elif metrics:
            steps.append(StepRecord("evaluate", _metric_detail(metrics)))
        else:
            steps.append(StepRecord("evaluate", "没有可以评分的成功预测"))
        recommendation = recommend(prepared.plan, runs, metrics)
        steps.append(StepRecord("recommend", recommendation.note))
        return AgentReport(
            task_id=task.task_id,
            profile=prepared.profile,
            plan=prepared.plan,
            runs=runs,
            ensemble=ensemble,
            metrics=metrics,
            recommendation=recommendation,
            steps=tuple(steps),
            holdout_actual=prepared.actual,
            fallback=registry.fallback,
        )


def recommend(
    plan: Plan,
    runs: tuple[ForecastResult, ...],
    metrics: tuple[ModelMetrics, ...],
) -> Recommendation:
    """有真实 API 的回测时按 MAE 选择。全是 stub 时不宣布优胜模型。"""
    ok = [run for run in runs if run.status == "ok"]
    if not ok:
        return Recommendation(None, "none", "没有成功的预测。")
    native_metrics = [
        item for item in metrics if item.execution == "native" and item.model_id != "ensemble/mean"
    ]
    if native_metrics:
        best = min(native_metrics, key=lambda item: (item.mae, item.model_id))
        return Recommendation(
            best.model_id,
            "holdout_mae",
            f"按回测 MAE 选择 {best.model_id}，MAE 为 {best.mae:.4f}。",
        )
    native_runs = [run for run in ok if run.execution == "native"]
    if native_runs and not native_metrics:
        scores = {item.model_id: item.score for item in plan.models}
        best_id = max(native_runs, key=lambda run: (scores.get(run.model_id, 0.0), run.model_id)).model_id
        return Recommendation(best_id, "planner_score", f"没有回测，按计划得分选择 {best_id}。")
    if all(run.execution == "stub" for run in ok):
        return Recommendation(
            None,
            "stub",
            "预测已经生成，但执行的是 stub backend，不能据此比较 TimesFM 和 Chronos 的真实精度。接入模型 API 后会走同一份计划。",
        )
    return Recommendation(None, "unranked", "结果里同时有 stub 和其他执行方式，未做排序。")


def _load_series(task: ForecastTask) -> TimeSeries:
    if task.series is not None:
        return task.series
    if not task.series_path:
        raise ValueError("需要 series 或 series_path")
    return load_csv(
        task.series_path,
        time_column=task.time_column,
        target=task.target,
        freq=task.freq,
        covariate_columns=task.covariate_columns,
        series_id=task.task_id,
    )


def _history_view(series: TimeSeries, request: ForecastRequest) -> TimeSeries:
    return TimeSeries(
        series_id=series.series_id,
        target=request.values,
        timestamps=request.timestamps,
        freq=series.freq,
        covariates=request.past_covariates or {},
        target_name=series.target_name,
        missing_filled=series.missing_filled,
    )


def _score_all(
    prepared: PreparedTask,
    runs: tuple[ForecastResult, ...],
    ensemble: ForecastResult | None,
) -> tuple[ModelMetrics, ...]:
    if prepared.actual is None:
        return ()
    scored: list[ModelMetrics] = []
    candidates = list(runs)
    if ensemble is not None:
        candidates.append(ensemble)
    for run in candidates:
        if run.status != "ok":
            continue
        scored.append(
            score_forecast(
                run.model_id,
                run.execution,
                prepared.actual,
                run.point,
                prepared.request.values,
                prepared.profile.seasonal_period,
            )
        )
    return tuple(scored)


def _plan_detail(plan: Plan) -> str:
    if not plan.models:
        return "没有模型通过约束"
    chosen = ", ".join(item.model_id for item in plan.models)
    return f"{plan.mode} 选中 {len(plan.models)} 个模型: {chosen}"


def _execute_detail(runs: tuple[ForecastResult, ...], fallback: str) -> str:
    if not runs:
        return f"fallback={fallback}，计划为空"
    parts = [f"{run.model_id} {run.execution} {run.status}" for run in runs]
    return f"fallback={fallback}；" + "；".join(parts)


def _metric_detail(metrics: tuple[ModelMetrics, ...]) -> str:
    parts = []
    for item in metrics:
        if item.model_id == "ensemble/mean":
            continue
        parts.append(f"{item.model_id} MAE {item.mae:.4f}")
    return "，".join(parts) if parts else "只有集成结果"
