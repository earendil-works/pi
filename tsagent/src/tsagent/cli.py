"""tsagent 命令行。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from tsagent.agent import TimeSeriesAgent
from tsagent.backends.registry import BackendRegistry
from tsagent.catalog import list_models
from tsagent.task import parse_task
from tsagent.types import AgentReport, ForecastTask, Plan, to_jsonable


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tsagent", description="编排 Google TimesFM 和 Amazon Chronos")
    sub = parser.add_subparsers(dest="command", required=True)

    catalog = sub.add_parser("catalog", help="列出可编排的模型")
    catalog.add_argument("--json", action="store_true")

    backends = sub.add_parser("backends", help="查看模型 API 是否已接入")
    backends.add_argument("--json", action="store_true")

    plan = sub.add_parser("plan", help="只做选模，不执行预测")
    run = sub.add_parser("run", help="选模并执行预测")
    for command in (plan, run):
        _add_task_args(command)

    args = parser.parse_args(argv)
    try:
        if args.command == "catalog":
            return _catalog(args.json)
        if args.command == "backends":
            return _backends(args.json)
        task = _task_from_args(args)
        agent = TimeSeriesAgent()
        if args.command == "plan":
            return _print_plan(agent, task, args.json, args.output)
        report = agent.run(task)
        return _print_report(report, args.json, args.output)
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


def _add_task_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--task", help="任务 JSON。其中的相对路径相对于该文件")
    parser.add_argument("--csv", help="序列 CSV")
    parser.add_argument("--time-column", dest="time_column")
    parser.add_argument("--target")
    parser.add_argument("--freq")
    parser.add_argument("--horizon", type=int)
    parser.add_argument("--quantiles", help="逗号分隔，例如 0.1,0.5,0.9")
    parser.add_argument("--models", help="auto、all，或逗号分隔的模型 id")
    parser.add_argument("--covariates", help="逗号分隔的协变量列")
    parser.add_argument("--fallback", choices=["stub", "strict"])
    parser.add_argument("--ensemble", choices=["mean", "none"])
    parser.add_argument("--holdout", action=argparse.BooleanOptionalAction)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--output", help="把 JSON 报告写到这个路径")


def _catalog(as_json: bool) -> int:
    models = list_models()
    if as_json:
        print(json.dumps([to_jsonable(model) for model in models], ensure_ascii=False, indent=2))
        return 0
    print(f"{'model':<42} {'family':<8} {'context':>8} {'horizon':>8} covariates")
    for model in models:
        flag = "yes" if model.supports_covariates else "no"
        print(f"{model.id:<42} {model.family:<8} {model.max_context:8d} {model.max_horizon:8d} {flag}")
    return 0


def _backends(as_json: bool) -> int:
    rows = BackendRegistry().describe()
    if as_json:
        payload = [{"name": name, "connected": connected, "detail": detail} for name, connected, detail in rows]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    for name, connected, detail in rows:
        state = "connected" if connected else "not connected"
        print(f"{name}: {state} — {detail}")
    return 0


def _print_plan(agent: TimeSeriesAgent, task: ForecastTask, as_json: bool, output: str | None) -> int:
    prepared = agent.prepare(task)
    payload = {
        "task_id": task.task_id,
        "profile": to_jsonable(prepared.profile),
        "plan": to_jsonable(prepared.plan),
    }
    _emit(payload, as_json, output, _format_plan(prepared.plan))
    return 0 if prepared.plan.models else 2


def _print_report(report: AgentReport, as_json: bool, output: str | None) -> int:
    payload = to_jsonable(report)
    _emit(payload, as_json, output, _format_report(report))
    if any(run.status == "ok" for run in report.runs):
        return 0
    return 2


def _emit(payload: object, as_json: bool, output: str | None, text: str) -> None:
    if output is not None:
        Path(output).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(text)


def _task_from_args(args: argparse.Namespace) -> ForecastTask:
    data: dict[str, object] = {}
    if args.task:
        task_path = Path(args.task)
        loaded = json.loads(task_path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("任务文件必须是 JSON 对象")
        data.update(loaded)
        series_path = data.get("series_path")
        if isinstance(series_path, str) and not Path(series_path).is_absolute():
            data["series_path"] = str((task_path.parent / series_path).resolve())
    if args.csv is not None:
        data["series_path"] = args.csv
    if args.time_column is not None:
        data["time_column"] = args.time_column
    if args.target is not None:
        data["target"] = args.target
    if args.freq is not None:
        data["freq"] = args.freq
    if args.horizon is not None:
        data["horizon"] = args.horizon
    if args.quantiles is not None:
        data["quantiles"] = [float(part) for part in args.quantiles.split(",") if part.strip()]
    if args.models is not None:
        data["models"] = args.models
    if args.covariates is not None:
        data["covariate_columns"] = [part.strip() for part in args.covariates.split(",") if part.strip()]
    if args.fallback is not None:
        data["fallback"] = args.fallback
    if args.ensemble is not None:
        data["ensemble"] = args.ensemble
    if args.holdout is not None:
        data["holdout"] = args.holdout
    if "task_id" not in data:
        data["task_id"] = Path(str(data.get("series_path", "task"))).stem
    return parse_task(data)


def _format_plan(plan: Plan) -> str:
    lines = [f"模式 {plan.mode}"]
    if not plan.models:
        lines.append("没有模型通过约束")
    for item in plan.models:
        lines.append(f"选中 {item.model_id}  得分 {item.score:.2f}  {item.chunks} 段")
        for reason in item.reasons:
            lines.append(f"  - {reason}")
    if plan.rejections:
        lines.append("未纳入本次计划")
        for item in plan.rejections:
            lines.append(f"  {item.model_id}: {item.reason}")
    return "\n".join(lines)


def _format_report(report: AgentReport) -> str:
    lines = [f"任务 {report.task_id}", "步骤"]
    for step in report.steps:
        lines.append(f"  {step.name}: {step.detail}")
    if report.metrics:
        lines.append("回测")
        for item in report.metrics:
            mape = "n/a" if item.mape is None else f"{item.mape:.4f}"
            mase = "n/a" if item.mase is None else f"{item.mase:.4f}"
            lines.append(
                f"  {item.model_id}  MAE {item.mae:.4f}  RMSE {item.rmse:.4f}  MAPE {mape}  MASE {mase}"
            )
    lines.append(f"建议: {report.recommendation.note}")
    return "\n".join(lines)
