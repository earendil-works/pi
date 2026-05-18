#!/usr/bin/env python3
"""Build a real-prompt GRPO batch with weak samples plus a heuristic positive."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCORER = ROOT / "scripts" / "score_compaction.py"
LEDGER = ROOT / "experiments" / "ledger.jsonl"
PATH_RE = re.compile(r"(?:/[\w.\-+@]+)+|(?:[\w.\-+@]+/)+[\w.\-+@]+")
MARKER_RE = re.compile(r"(?=\n?\[(?:System|User|Assistant response|tool_use|tool_result)\])")
PSEUDO_PATHS = {
    "/analysis",
    "/summary",
    "/system-reminder",
    "/task-notification",
    "/task-id",
    "/tool-use-id",
    "/output-file",
    "/status",
}


def post_json(url: str, payload: dict, timeout: int = 600) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e


def get_json(url: str, timeout: int = 30) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def load_jsonl(path: Path, limit: int) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
        if len(rows) >= limit:
            break
    return rows


def trim_source(source: str, char_budget: int) -> str:
    if char_budget <= 0 or len(source) <= char_budget:
        return source
    chunks = [c.strip() for c in source.split("\n\n") if c.strip()]
    first_user = ""
    for chunk in chunks:
        if chunk.startswith("[User]") and not is_pseudo_user_chunk(chunk):
            first_user = clean_snippet(chunk, min(360, max(160, char_budget // 3)))
            break
    recent = "\n\n".join(chunks[-10:]) if chunks else source
    prefix_parts = ["[System]: (system prompt omitted for training memory; preserve conversation state only)"]
    if first_user:
        prefix_parts.append(first_user)
    prefix = "\n\n".join(prefix_parts)
    marker = "\n\n[... middle of trajectory omitted for training memory ...]\n\n"
    tail_budget = max(200, char_budget - len(prefix) - len(marker))
    if tail_budget > 0:
        packed = prefix + marker + recent[-tail_budget:].lstrip()
        if len(packed) <= char_budget + 80:
            return packed
    head_budget = min(2200, char_budget // 3)
    tail_budget = char_budget - head_budget
    return (
        source[:head_budget].rstrip()
        + "\n\n[... middle of trajectory omitted for training memory ...]\n\n"
        + source[-tail_budget:].lstrip()
    )


def prepare_row(row: dict, source_char_budget: int) -> dict:
    out = dict(row)
    out["source"] = trim_source(row["source"], source_char_budget)
    entities = sorted(e for e in set(row.get("critical_entities", []) + PATH_RE.findall(out["source"])) if valid_entity(e))
    out["critical_entities"] = entities[:80]
    metadata = dict(out.get("metadata", {}))
    metadata["source_chars_original"] = len(row["source"])
    metadata["source_chars_used"] = len(out["source"])
    out["metadata"] = metadata
    return out


def prompt_for(row: dict) -> list[dict]:
    return [
        {
            "role": "user",
            "content": (
                "Create a structured Pi context checkpoint summary for the conversation "
                "in <conversation>. Use exactly these headings: Goal; Constraints & "
                "Preferences; Progress with Done, In Progress, and Blocked; Key "
                "Decisions; Next Steps; Critical Context. Preserve exact paths, "
                "commands, IDs, errors, current blockers, and concrete next actions. "
                "Do not fabricate completed work.\n\n"
                f"<conversation>\n{row['source']}\n</conversation>"
            ),
        }
    ]


def score(row: dict, text: str) -> float:
    payload = {
        "source": row["source"],
        "candidate": text,
        "read_files": row.get("read_files", []),
        "modified_files": row.get("modified_files", []),
        "critical_entities": row.get("critical_entities", []),
    }
    proc = subprocess.run(
        [sys.executable, str(SCORER)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)["score"]


def clean_snippet(text: str, limit: int = 220) -> str:
    text = text.replace("\\n", " ").replace("\\t", " ")
    text = re.sub(r"\s+", " ", text).strip()
    text = text.strip("`'\" ")
    if len(text) > limit:
        text = text[: limit - 3].rstrip() + "..."
    return text


def is_pseudo_user_chunk(text: str) -> bool:
    low = text.lower()
    return (
        "[tool_result]" in low
        or "shell cwd was reset" in low
        or "<system-reminder>" in low
        or "<task-notification>" in low
        or "<tool-use-id>" in low
    )


def valid_entity(entity: str) -> bool:
    if entity in PSEUDO_PATHS:
        return False
    if re.fullmatch(r"/[A-Za-z][A-Za-z0-9_-]{1,30}", entity) and "." not in entity:
        # These are usually XML/HTML tag names surfaced by PATH_RE, not files.
        return False
    return True


def marker_chunks(source: str, marker: str) -> list[str]:
    chunks = []
    for part in MARKER_RE.split(source):
        part = part.strip()
        if part.startswith(marker):
            chunks.append(clean_snippet(part, 360))
    return chunks


def last_real_user_goal(source: str) -> str:
    users = marker_chunks(source, "[User]")
    for item in reversed(users):
        if is_pseudo_user_chunk(item):
            continue
        cleaned = re.sub(r"^\[User\]:\s*", "", item).strip()
        if len(words_for_target(cleaned)) >= 4:
            return clean_snippet(cleaned, 260)
    return "Continue the current coding-agent task from the compacted conversation."


def words_for_target(text: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9_./:-]{2,}", text)


def recent_events(source: str, limit: int = 5) -> list[str]:
    events = []
    for marker in ("[Assistant response]", "[tool_use]", "[tool_result]", "[User]"):
        for item in marker_chunks(source, marker):
            low = item.lower()
            if marker == "[User]" and "[tool_result]" not in low:
                continue
            if marker == "[tool_result]" and len(item) < 24:
                continue
            events.append(item)
    # Recover chronological order by scanning the source once.
    ordered = []
    for part in MARKER_RE.split(source):
        part = part.strip()
        if any(part.startswith(m) for m in ("[Assistant response]", "[tool_use]", "[tool_result]", "[User]")):
            cleaned = clean_snippet(part, 300)
            if cleaned in events and len(words_for_target(cleaned)) >= 3:
                ordered.append(cleaned)
    return ordered[-limit:]


def blocker_lines(source: str, limit: int = 4) -> list[str]:
    blockers = []
    terms = ("failed", "error", "blocked", "oom", "out of memory", "permission denied", "not visible", "no error")
    for part in MARKER_RE.split(source):
        cleaned = clean_snippet(part, 280)
        low = cleaned.lower()
        if any(t in low for t in terms):
            # Avoid turning entire embedded scripts into blockers.
            cleaned = re.sub(r"\\?n\s*const browser.*", "", cleaned).strip()
            blockers.append(clean_snippet(cleaned, 220))
    return blockers[-limit:]


def ranked_entities(source: str, row_entities: list[str], limit: int = 22) -> list[str]:
    seen = {}
    for entity in row_entities + PATH_RE.findall(source):
        if len(entity) < 3 or not valid_entity(entity):
            continue
        seen[entity] = source.rfind(entity)
    return [entity for entity, _ in sorted(seen.items(), key=lambda kv: kv[1], reverse=True)[:limit]]


def heuristic_positive(row: dict, char_budget: int = 0) -> str:
    source = row["source"]
    entities = ranked_entities(source, row.get("critical_entities", []))
    events = recent_events(source, 5)
    assistants = marker_chunks(source, "[Assistant response]")
    blockers = blocker_lines(source)

    goal = last_real_user_goal(source)
    current = clean_snippet(assistants[-1].removeprefix("[Assistant response]:"), 260) if assistants else ""
    if len(words_for_target(current)) < 3:
        current = "Continue from the latest assistant state."
    all_done = events[-4:] or ["Inspected the recent conversation and preserved the current state for continuation."]
    all_blocked = blockers or ["(none known from the retained context)"]
    all_critical = entities or ["(none extracted)"]

    read_files = [p for p in row.get("read_files", []) if isinstance(p, str)]
    modified_files = [p for p in row.get("modified_files", []) if isinstance(p, str)]

    def render(done_limit: int, critical_limit: int, blocker_limit: int, file_limit: int) -> str:
        done = all_done[-done_limit:]
        blocked = all_blocked[-blocker_limit:]
        critical = all_critical[:critical_limit]
        compact = char_budget > 0
        lines = [
            "## Goal",
            f"- {goal}",
            "",
            "## Constraints & Preferences",
            "- Preserve exact paths, commands, IDs, errors, blockers, and unresolved state.",
            "- Do not fabricate completion; output only a checkpoint summary.",
            "",
            "## Progress",
            "### Done",
            *[f"- [x] {item}" for item in done],
            "",
            "### In Progress",
            f"- [ ] {current}",
            "",
            "### Blocked",
            *[f"- {item}" for item in blocked],
            "",
            "## Key Decisions",
            "- **Format**: Use Pi's exact checkpoint headings for direct continuation.",
            "",
            "## Next Steps",
            "1. Resume the in-progress item and verify the latest tool result.",
            "2. Re-check blockers before marking anything complete.",
            *([] if compact else ["3. Continue using the exact paths, commands, IDs, errors, and artifacts listed in Critical Context."]),
            "",
            "## Critical Context",
            *[f"- `{item}`" if "/" in item else f"- {item}" for item in critical],
        ]
        if read_files:
            lines.extend(["", "<read-files>", *read_files[:file_limit], "</read-files>"])
        if modified_files:
            lines.extend(["", "<modified-files>", *modified_files[:file_limit], "</modified-files>"])
        return "\n".join(lines)

    if char_budget <= 0:
        return render(4, 22, 4, 40)
    for config in ((4, 16, 3, 8), (3, 12, 2, 6), (2, 9, 2, 4), (1, 7, 1, 3), (1, 5, 1, 2)):
        text = render(*config)
        if len(text) <= char_budget:
            return text
    return render(1, 4, 1, 1)


def generic_negative(row: dict) -> str:
    """A controlled low-reward completion for offline contrast GRPO groups."""
    return "\n".join(
        [
            "Goal",
            "Continue the task.",
            "",
            "Constraints & Preferences",
            "Follow instructions.",
            "",
            "Progress",
            "Done: work was done.",
            "",
            "In Progress: continue.",
            "",
            "Blocked: none.",
            "",
            "Key Decisions",
            "Use a good approach.",
            "",
            "Next Steps",
            "1. Keep working.",
            "",
            "Critical Context",
            "Important context exists.",
        ]
    )


def trim_completion(text: str, char_budget: int) -> str:
    if char_budget <= 0 or len(text) <= char_budget:
        return text
    return text[:char_budget].rstrip()


def wait_job(kiln_url: str, job_id: str, timeout_s: int) -> dict:
    deadline = time.time() + timeout_s
    last = {}
    while time.time() < deadline:
        last = get_json(f"{kiln_url}/v1/train/status/{job_id}")
        state = last.get("state") or last.get("status")
        if state in {"completed", "failed", "cancelled"}:
            return last
        time.sleep(5)
    raise TimeoutError(f"job {job_id} did not finish within {timeout_s}s; last={last}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kiln-url", default="http://127.0.0.1:8420")
    ap.add_argument("--prompts", type=Path, default=ROOT / "data" / "trajectory-compaction-prompts.jsonl")
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=2)
    ap.add_argument("--n", type=int, default=2)
    ap.add_argument("--max-tokens", type=int, default=500)
    ap.add_argument("--temperature", type=float, default=0.9)
    ap.add_argument("--seed", type=int, default=18051803)
    ap.add_argument("--adapter", default="pi-compaction-grpo-v003")
    ap.add_argument("--base-adapter", default=None)
    ap.add_argument("--source-char-budget", type=int, default=7000)
    ap.add_argument("--completion-char-budget", type=int, default=0)
    ap.add_argument("--lora-rank", type=int, default=16)
    ap.add_argument("--learning-rate", type=float, default=1e-5)
    ap.add_argument("--kl-coeff", type=float, default=0.1)
    ap.add_argument("--clip-epsilon", type=float, default=0.2)
    ap.add_argument("--wait", action="store_true")
    ap.add_argument("--auto-load", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--job-timeout-s", type=int, default=900)
    ap.add_argument(
        "--offline-contrast",
        action="store_true",
        help="Skip base sampling and build generic-negative + heuristic-positive GRPO groups.",
    )
    ap.add_argument("--dry-run", action="store_true", help="Write groups/scored completions but do not POST to Kiln.")
    args = ap.parse_args()

    raw_rows = load_jsonl(args.prompts, args.offset + args.limit)[args.offset : args.offset + args.limit]
    rows = [prepare_row(r, args.source_char_budget) for r in raw_rows]
    if not args.dry_run:
        health = get_json(f"{args.kiln_url}/health")
        if health.get("training", {}).get("active_job") is not None:
            raise RuntimeError(f"Kiln already has active training job: {health['training']}")

    groups = [{"messages": prompt_for(row), "completions": []} for row in rows]
    scored_rows = []
    if args.offline_contrast:
        for pi, row in enumerate(rows):
            text = trim_completion(generic_negative(row), args.completion_char_budget)
            reward = score(row, text)
            groups[pi]["completions"].append({"text": text, "reward": reward})
            scored_rows.append({"prompt_index": pi, "kind": "generic_negative", "reward": reward, "text": text})
    else:
        prompts = [prompt_for(r) for r in rows]
        batch = post_json(
            f"{args.kiln_url}/v1/completions/batch",
            {
                "prompts": prompts,
                "n": args.n,
                "temperature": args.temperature,
                "max_tokens": args.max_tokens,
                "seed": args.seed,
                "sampling_preset": "qwen3-non-thinking-general",
                "chat_template_kwargs": {"enable_thinking": False},
            },
            timeout=900,
        )
        for item in batch["completions"]:
            pi = item["prompt_index"]
            text = trim_completion(item.get("text") or item.get("reasoning_content") or "", args.completion_char_budget)
            reward = score(rows[pi], text)
            groups[pi]["completions"].append({"text": text, "reward": reward})
            scored_rows.append({"prompt_index": pi, "kind": "sample", "reward": reward, "text": text})
    for pi, row in enumerate(rows):
        text = trim_completion(heuristic_positive(row, args.completion_char_budget), args.completion_char_budget)
        reward = score(row, text)
        groups[pi]["completions"].append({"text": text, "reward": reward})
        scored_rows.append({"prompt_index": pi, "kind": "heuristic_positive", "reward": reward, "text": text})

    groups = [g for g in groups if max(c["reward"] for c in g["completions"]) - min(c["reward"] for c in g["completions"]) >= 0.01]
    if not groups:
        raise RuntimeError("no groups had enough reward variance to submit")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results_dir = ROOT / "results" / f"{ts}-{args.adapter}"
    results_dir.mkdir(parents=True, exist_ok=True)
    grpo_path = results_dir / "groups.jsonl"
    grpo_path.write_text("\n".join(json.dumps(g, ensure_ascii=False) for g in groups) + "\n")
    (results_dir / "scored-completions.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in scored_rows) + "\n"
    )
    submitted_rewards = [c["reward"] for g in groups for c in g["completions"]]
    mean_reward = sum(submitted_rewards) / len(submitted_rewards)

    config = {
        "learning_rate": args.learning_rate,
        "kl_coeff": args.kl_coeff,
        "clip_epsilon": args.clip_epsilon,
        "lora_rank": args.lora_rank,
        "output_name": args.adapter,
        "auto_load": args.auto_load,
    }
    if args.base_adapter:
        config["base_adapter"] = args.base_adapter

    if args.dry_run:
        job = {"job_id": None}
        job_status = {
            "state": "dry_run",
            "offline_contrast": args.offline_contrast,
            "message": "groups built locally; no Kiln request was made",
        }
    else:
        job = post_json(
            f"{args.kiln_url}/v1/train/grpo",
            {
                "groups": groups,
                "config": config,
            },
            timeout=120,
        )
        job_status = wait_job(args.kiln_url, job["job_id"], args.job_timeout_s) if args.wait else job
    (results_dir / "job.json").write_text(json.dumps(job_status, indent=2, sort_keys=True))

    ledger = {
        "iter": None,
        "slug": args.adapter,
        "ts": datetime.now(timezone.utc).isoformat(),
        "status": "dry_run" if args.dry_run else ("submitted" if not args.wait else job_status.get("state", "unknown")),
        "score": mean_reward,
        "hypothesis": "Real-prompt GRPO needs explicit positive/negative contrast when base samples collapse to empty or generic summaries.",
        "prompt_set": str(args.prompts),
        "scorer": "scripts/score_compaction.py@v0.3",
        "adapter": args.adapter,
        "training": {
            "job_id": job["job_id"],
            "dry_run": args.dry_run,
            "offline_contrast": args.offline_contrast,
            "lora_rank": args.lora_rank,
            "learning_rate": args.learning_rate,
            "kl_coeff": args.kl_coeff,
            "clip_epsilon": args.clip_epsilon,
            "groups": len(groups),
            "completions": sum(len(g["completions"]) for g in groups),
            "max_tokens": args.max_tokens,
            "source_char_budget": args.source_char_budget,
            "completion_char_budget": args.completion_char_budget,
            "offset": args.offset,
            "base_adapter": args.base_adapter,
        },
        "artifacts": [str(grpo_path), str(results_dir / "scored-completions.jsonl"), str(results_dir / "job.json")],
        "verdict": "ready_to_submit" if args.dry_run else "pending_eval",
        "next_focus": (
            "Submit this offline contrast payload on a clean BF16 Kiln server, then cache-busted eval."
            if args.dry_run
            else "Archive adapter, evaluate held-out prompts, then replace heuristic positives with model-produced high-reward summaries."
        ),
    }
    with LEDGER.open("a") as f:
        f.write(json.dumps(ledger, ensure_ascii=False) + "\n")

    print(json.dumps({"mean_reward": mean_reward, "job": job_status, "results_dir": str(results_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
