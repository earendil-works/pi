"""Score transported deliverables with structured calls and JobBench's official aggregation."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import yaml
from beaker import CaseScore, Check, scoring_inference_target

from .data import Expected, PROTOCOL
from .execution import MAX_DELIVERABLE_BYTES
from .judging import judge_implementation, judge_rubric, official_judge


MAX_JUDGE_WORKERS = 10


def configured_scorer_model() -> str:
    """Read the local judge model from this integration's YAML, independently of cwd."""
    config_path = Path(__file__).resolve().parents[1] / "beaker.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    model = config["integrations"]["pi-jobbench"].get("scorer_model")
    if not isinstance(model, str):
        raise ValueError("Set integrations.pi-jobbench.scorer_model in .beaker/beaker.yaml")
    provider, _, model_id = model.strip().partition(":")
    if not provider or not model_id.strip():
        raise ValueError("Set integrations.pi-jobbench.scorer_model to a provider:model ID in .beaker/beaker.yaml")
    return model.strip()


def restore_submission(files: list[dict[str, Any]], directory: Path) -> None:
    """Validate the candidate's binary transport before writing scorer-owned files."""
    total = 0
    seen = set()
    for item in files:
        name = item["name"]
        if not isinstance(name, str) or "\\" in name or any(part in ("", ".", "..") for part in name.split("/")):
            raise ValueError("Unsafe submission path")
        if name in seen:
            raise ValueError("Duplicate submission path")
        seen.add(name)
        if len(item["content_base64"]) > 4 * ((MAX_DELIVERABLE_BYTES + 2) // 3):
            raise ValueError("Submission payload exceeds the transport limit")
        content = base64.b64decode(item["content_base64"], validate=True)
        total += len(content)
        if total > MAX_DELIVERABLE_BYTES or len(content) != item["size"]:
            raise ValueError("Submission size is invalid")
        if hashlib.sha256(content).hexdigest() != item["sha256"]:
            raise ValueError("Submission hash is invalid")
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def score_submission(
    expected: Expected, files: list[dict[str, Any]], *, report_dir: Path | None = None,
    protocol: dict[str, Any] | None = None,
) -> CaseScore:
    """Blend official rubric weighting with the criteria pass rate; judge failures raise, never score zero."""
    with tempfile.TemporaryDirectory(prefix="pi-jobbench-score-") as temporary:
        directory = Path(temporary)
        restore_submission(files, directory)
        selected_model = None
        rubric_results = []
        extraction: dict[str, Any] = {}
        if files:
            full_contents: dict[str, str] = {}
            text = official_judge.extract_all_file_contents(directory, extraction, full_contents=full_contents)
            images = official_judge.collect_image_attachments(directory)
            target = scoring_inference_target()
            selected_model = target.model if target is not None else configured_scorer_model()
            if target is None:
                provider, _, model = selected_model.partition(":")
                api_base = os.environ.get("JUDGE_API_BASE")
                if not api_base:
                    if provider != "google":
                        raise RuntimeError(f"JUDGE_API_BASE is required for local scoring with provider {provider!r}")
                    api_base = "https://generativelanguage.googleapis.com/v1beta/openai"
                api_key = os.environ.get("JUDGE_API_KEY") or (
                    os.environ.get("GEMINI_API_KEY", "") if provider == "google" else ""
                )
                if not api_key.strip():
                    raise RuntimeError("JUDGE_API_KEY is required for local scoring; Google also accepts GEMINI_API_KEY")
            else:
                api_base, api_key, model = target.base_url, target.api_key, target.model
            executor = ThreadPoolExecutor(max_workers=MAX_JUDGE_WORKERS)
            try:
                futures = [
                    executor.submit(
                        judge_rubric,
                        index, rubric, text, model, api_base, api_key,
                        image_attachments=images,
                        full_contents=full_contents,
                    )
                    for index, rubric in enumerate(expected.rubrics)
                ]
                # Consume in rubric order so outputs and the first reported failure stay stable.
                rubric_results = [future.result() for future in futures]
            finally:
                # In-flight calls cannot be interrupted; cancel queued work and ignore later results on failure.
                executor.shutdown(wait=False, cancel_futures=True)
        else:
            rubric_results = [
                official_judge.build_failed_rubric_result(index, rubric.model_dump(), "No output files produced.")
                for index, rubric in enumerate(expected.rubrics)
            ]
        scorecard = official_judge.build_scorecard(rubric_results)
        if report_dir is not None:
            report_dir.mkdir(parents=True, exist_ok=True)
            (report_dir / "score.json").write_text(json.dumps({
                "protocol": {**(PROTOCOL if protocol is None else protocol), "scorer_model": selected_model},
                "scorecard": scorecard, "rubrics": rubric_results, "extraction": extraction,
                "judge_implementation": judge_implementation(),
            }, indent=2), encoding="utf-8")
        checks = tuple(
            Check(
                name=f"Rubric {rubric['index'] + 1}, criterion {criterion['index'] + 1}",
                description=criterion["criterion"],
                verdict="pass" if criterion["passed"] else "fail",
                message=criterion.get("reasoning") or rubric["result"]["overall_reasoning"],
                group=rubric["rubric"],
                informational=rubric["weight"] == 0,
            )
            for rubric in rubric_results for criterion in rubric["result"]["criteria_results"]
        )
        checks += judge_input_checks(extraction)
        checks += tuple(
            Check(
                name=f"Judge evidence read: rubric-{rubric['index'] + 1}, read-{index + 1}",
                verdict="pass", message=json.dumps(read, ensure_ascii=False),
                group="Judge input", informational=True,
            )
            for rubric in rubric_results for index, read in enumerate(rubric.get("evidence_reads", []))
        )
        checks += (Check(
            name="Judge evidence implementation", verdict="pass",
            message=json.dumps(judge_implementation()), group="Judge input", informational=True,
        ),)
        graded = [check for check in checks if not check.informational]
        criteria_pass_rate = round(sum(check.verdict == "pass" for check in graded) / len(graded), 4) if graded else 0.0
        weighted_score = float(scorecard["normalized_score"])
        # The official score is all-or-nothing per rubric; blending in the per-criterion rate densifies the signal.
        return CaseScore(
            objective=round(0.5 * weighted_score + 0.5 * criteria_pass_rate, 4),
            field_scores={
                "jobbench_weighted_score": weighted_score,
                "criteria_pass_rate": criteria_pass_rate,
                "rubric_pass_rate": float(scorecard["pass_rate"]),
            },
            checks=checks,
        )


def judge_input_checks(extraction: dict[str, Any]) -> tuple[Check, ...]:
    """Flag abbreviated initial views; diagnostics never change the score."""
    limit = official_judge.MAX_CHARS_PER_FILE
    return tuple(
        Check(
            name=f"Judge input truncated: {record['path']}",
            verdict="fail",
            message=(
                f"The initial view contains the first {limit:,} of {record['characters']:,} extracted characters."
                if record["characters"] > limit and not record["path"].lower().endswith(tuple(official_judge.SQLITE_EXTS))
                else "The initial spreadsheet view omits part of this file's text."
            ) + (" Complete extracted evidence is available through read_output_evidence."
                 if record.get("full_evidence_available") else ""),
            group="Judge input",
            informational=True,
        )
        for record in extraction.get("files", []) if record.get("truncated")
    )


async def score_async(expected: Expected, files: list[dict[str, Any]]) -> CaseScore:
    return await asyncio.to_thread(score_submission, expected, files)
