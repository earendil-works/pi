import json
from pathlib import Path

from tsagent.cli import main

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


def test_catalog_lists_both_families(capsys):
    assert main(["catalog"]) == 0
    output = capsys.readouterr().out
    assert "google/timesfm-2.5-200m-pytorch" in output
    assert "amazon/chronos-2" in output


def test_backends_start_disconnected(capsys):
    assert main(["backends"]) == 0
    output = capsys.readouterr().out
    assert "google.timesfm: not connected" in output
    assert "amazon.chronos: not connected" in output
    assert "stub: connected" in output


def test_example_run_writes_a_stub_report(capsys, tmp_path):
    output = tmp_path / "report.json"
    code = main(["run", "--task", str(EXAMPLES / "task.json"), "--json", "--output", str(output)])
    assert code == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["recommendation"]["basis"] == "stub"
    assert [run["model_id"] for run in report["runs"]] == [
        "google/timesfm-2.5-200m-pytorch",
        "amazon/chronos-2",
    ]
    assert report["ensemble"]["model_id"] == "ensemble/mean"
    assert "stub backend" in capsys.readouterr().out


def test_covariate_task_plans_only_chronos(capsys):
    code = main(["plan", "--task", str(EXAMPLES / "task_covariates.json"), "--json"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert [item["model_id"] for item in payload["plan"]["models"]] == ["amazon/chronos-2"]


def test_strict_run_fails_without_inventing_values(capsys):
    code = main(
        [
            "run",
            "--task",
            str(EXAMPLES / "task.json"),
            "--fallback",
            "strict",
            "--json",
        ]
    )
    assert code == 2
    report = json.loads(capsys.readouterr().out)
    assert report["runs"]
    assert {run["status"] for run in report["runs"]} == {"unavailable"}
    assert report["runs"][0]["point"] == []
