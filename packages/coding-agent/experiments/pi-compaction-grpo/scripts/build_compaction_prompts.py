#!/usr/bin/env python3
"""Build Pi-compaction prompt records from trajectory turns.

The records are prompt-only sources for rollout/eval. They deliberately do not
include gold summaries; rewards are computed by `score_compaction.py` against
the serialized source plus extracted entities/file hints.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path


DEFAULT_DB = Path("/data/.clouderic-internal/repos/apps/trajectory-trainer/trajectories.db")
ROOT = Path(__file__).resolve().parents[1]
PATH_RE = re.compile(r"(?:/[\w.\-+@]+)+|(?:[\w.\-+@]+/)+[\w.\-+@]+")
READ_TOOL_RE = re.compile(r"\[tool_use\]\s+(?:Read|Grep|Glob)\((\{.*?\})\)")
WRITE_TOOL_RE = re.compile(r"\[tool_use\]\s+(?:Edit|MultiEdit|Write)\((\{.*?\})\)")


def normalize_system(system_raw: str | None) -> str:
    if not system_raw:
        return ""
    try:
        parsed = json.loads(system_raw)
        if isinstance(parsed, list):
            return "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in parsed)
        if isinstance(parsed, dict):
            return parsed.get("text", str(parsed))
    except Exception:
        pass
    return str(system_raw)


def text_from_content(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)
    out = []
    for block in content:
        if not isinstance(block, dict):
            out.append(str(block))
            continue
        btype = block.get("type")
        if btype == "text":
            out.append(block.get("text", ""))
        elif btype == "thinking":
            out.append(f"<thinking>\n{block.get('thinking', '')}\n</thinking>")
        elif btype == "tool_use":
            out.append(f"[tool_use] {block.get('name')}({json.dumps(block.get('input', {}), ensure_ascii=False)})")
        elif btype == "tool_result":
            out.append(f"[tool_result] {text_from_content(block.get('content', ''))[:2000]}")
    return "\n".join(x for x in out if x)


def serialize_turn(row: sqlite3.Row) -> dict:
    system = normalize_system(row["system_content"])
    messages = json.loads(row["messages_json"])
    response = json.loads(row["response_json"])
    parts = []
    if system:
        parts.append(f"[System]: {system[:2000]}")
    for msg in messages[-24:]:
        role = msg.get("role", "unknown")
        parts.append(f"[{role.title()}]: {text_from_content(msg.get('content', ''))[:3000]}")
    parts.append(f"[Assistant response]: {text_from_content(response)[:3000]}")
    source = "\n\n".join(parts)
    paths = sorted(set(PATH_RE.findall(source)))
    read_files, modified_files = extract_file_ops(source)
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "timestamp": row["timestamp"],
        "source": source,
        "critical_entities": paths[:80],
        "read_files": read_files,
        "modified_files": modified_files,
        "metadata": {
            "model": row["model"],
            "num_input_messages": row["num_input_messages"],
            "input_tokens": row["input_tokens"],
            "output_tokens": row["output_tokens"],
        },
    }


def _json_file_path(raw: str) -> str | None:
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    path = parsed.get("file_path") or parsed.get("path")
    return path if isinstance(path, str) and path.startswith("/") else None


def extract_file_ops(source: str) -> tuple[list[str], list[str]]:
    read_files = []
    modified_files = []
    for regex, out in ((READ_TOOL_RE, read_files), (WRITE_TOOL_RE, modified_files)):
        for match in regex.finditer(source):
            path = _json_file_path(match.group(1))
            if path and path not in out:
                out.append(path)
    return read_files[:40], modified_files[:40]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--limit", type=int, default=24)
    ap.add_argument("--min-input-tokens", type=int, default=12000)
    ap.add_argument("--one-per-session", action="store_true")
    ap.add_argument("--session-ids", default="", help="Comma-separated session IDs; fetch the top qualifying turn from each.")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "trajectory-compaction-prompts.jsonl")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    explicit_sessions = [s.strip() for s in args.session_ids.split(",") if s.strip()]
    if explicit_sessions or args.one_per_session:
        if explicit_sessions:
            sessions = [{"session_id": s} for s in explicit_sessions[: args.limit]]
        else:
            sessions = conn.execute(
                """
                SELECT session_id
                FROM turns
                WHERE input_tokens >= ?
                GROUP BY session_id
                ORDER BY MAX(input_tokens) DESC
                LIMIT ?
                """,
                (args.min_input_tokens, args.limit),
            ).fetchall()
        rows = []
        for session in sessions:
            rows.append(
                conn.execute(
                    """
                    SELECT t.id, t.session_id, t.timestamp, t.model, t.split, t.num_input_messages,
                           t.input_tokens, t.output_tokens, sp.content AS system_content,
                           t.messages_json, t.response_json, t.response_text
                    FROM turns t
                    LEFT JOIN system_prompts sp ON sp.id = t.system_prompt_id
                    WHERE t.session_id = ? AND t.input_tokens >= ?
                    ORDER BY t.input_tokens DESC
                    LIMIT 1
                    """,
                    (session["session_id"], args.min_input_tokens),
                ).fetchone()
            )
    else:
        query = """
        SELECT t.id, t.session_id, t.timestamp, t.model, t.split, t.num_input_messages,
               t.input_tokens, t.output_tokens, sp.content AS system_content,
               t.messages_json, t.response_json, t.response_text
        FROM turns t
        LEFT JOIN system_prompts sp ON sp.id = t.system_prompt_id
        WHERE t.input_tokens >= ?
        ORDER BY t.input_tokens DESC
        LIMIT ?
        """
        rows = conn.execute(query, (args.min_input_tokens, args.limit)).fetchall()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for row in rows:
            rec = serialize_turn(row)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} prompts to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
