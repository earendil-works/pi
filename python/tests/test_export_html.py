"""HTML export fidelity tests (Phase 3)."""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from pi_mono.coding_agent.core.export_html.ansi_to_html import ansi_lines_to_html, ansi_to_html
from pi_mono.coding_agent.core.export_html.export_html import (
    export_from_file,
    export_session_to_html,
    generate_html,
    pre_render_tools,
)
from pi_mono.coding_agent.core.export_html.tool_renderer import create_tool_html_renderer
from pi_mono.core.session_manager import SessionManager


def _write_session(path: Path, entries: list[dict]) -> None:
    header = {
        "type": "session",
        "version": 3,
        "id": "export-test-session",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "cwd": "/tmp/project",
    }
    with path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(header) + "\n")
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")


def _session_payload(html: str) -> dict:
    match = re.search(r'<script id="session-data"[^>]*>([^<]+)</script>', html)
    assert match is not None, "expected shared export template session-data block"
    return json.loads(base64.b64decode(match.group(1)).decode("utf-8"))


def test_ansi_to_html_converts_foreground_color() -> None:
    html = ansi_to_html("\x1b[91mred\x1b[0m plain")
    assert '<span style="color:#ff0000">' in html
    assert "red" in html
    assert "plain" in html


def test_ansi_lines_to_html_wraps_lines_without_inserting_whitespace() -> None:
    assert ansi_lines_to_html(["one", "two"]) == (
        '<div class="ansi-line">one</div><div class="ansi-line">two</div>'
    )


def test_tool_renderer_trims_blank_lines_from_result_html(monkeypatch) -> None:
    renderer = create_tool_html_renderer(cwd="/tmp")

    def fake_render(_tool_name, _args, result, _cwd, *, expanded, is_error, show_images=True):
        del expanded, is_error, show_images
        text = result["content"][0]["text"]
        return f"\n{text}\n"

    import pi_mono.coding_agent.core.export_html.tool_renderer as tool_renderer_module

    monkeypatch.setattr(tool_renderer_module, "render_tool_result", fake_render)
    rendered = renderer.render_result(
        "call-1",
        "grep",
        [{"type": "text", "text": "match line"}],
        None,
        False,
    )

    assert rendered is not None
    assert rendered["expanded"] == '<div class="ansi-line">match line</div>'


def test_pre_render_tools_includes_grep_but_not_read(tmp_path: Path) -> None:
    session_file = tmp_path / "session.jsonl"
    _write_session(
        session_file,
        [
            {
                "type": "message",
                "id": "u1",
                "parentId": None,
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "find it"}]},
            },
            {
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "grep-call",
                            "name": "grep",
                            "arguments": {"pattern": "foo", "path": "."},
                        }
                    ],
                    "provider": "faux",
                    "model": "faux-1",
                    "usage": {"input": 1, "output": 1, "cost": {"total": 0}},
                    "stopReason": "toolUse",
                },
            },
            {
                "type": "message",
                "id": "r1",
                "parentId": "a1",
                "timestamp": "2026-01-01T00:00:02Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "grep-call",
                    "toolName": "grep",
                    "content": [{"type": "text", "text": "./a.txt:foo"}],
                    "isError": False,
                },
            },
        ],
    )

    session_manager = SessionManager.open(str(session_file))
    renderer = create_tool_html_renderer(cwd=str(tmp_path))
    rendered = pre_render_tools(session_manager.get_entries(), renderer)

    assert "grep-call" in rendered
    assert rendered["grep-call"].call_html
    assert rendered["grep-call"].result_html_expanded
    assert "grep" in rendered["grep-call"].call_html


def test_export_from_file_uses_template_and_includes_edit_diff(tmp_path: Path) -> None:
    session_file = tmp_path / "session.jsonl"
    output_file = tmp_path / "out.html"
    _write_session(
        session_file,
        [
            {
                "type": "message",
                "id": "u1",
                "parentId": None,
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "edit file"}]},
            },
            {
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "edit-call",
                            "name": "edit",
                            "arguments": {"path": "sample.py"},
                        }
                    ],
                    "provider": "faux",
                    "model": "faux-1",
                    "usage": {"input": 1, "output": 1, "cost": {"total": 0}},
                    "stopReason": "toolUse",
                },
            },
            {
                "type": "message",
                "id": "r1",
                "parentId": "a1",
                "timestamp": "2026-01-01T00:00:02Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "edit-call",
                    "toolName": "edit",
                    "content": [{"type": "text", "text": "Successfully edited sample.py"}],
                    "details": {"diff": " context\n-old line\n+new line"},
                    "isError": False,
                },
            },
        ],
    )

    renderer = create_tool_html_renderer(cwd=str(tmp_path))
    result_path = export_from_file(
        str(session_file),
        str(output_file),
        tool_renderer=renderer,
    )

    html = Path(result_path).read_text(encoding="utf-8")
    assert "<!DOCTYPE html>" in html
    assert "diff-added" in html
    assert "diff-removed" in html
    payload = _session_payload(html)
    tool_result = payload["entries"][2]["message"]
    assert "+new line" in tool_result["details"]["diff"]
    assert payload["header"] is not None
    assert payload["header"]["id"] == "export-test-session"


def test_generate_html_uses_shared_template_not_minimal_pre_blocks() -> None:
    session_data = {
        "header": {
            "type": "session",
            "id": "x",
            "cwd": "/tmp",
            "timestamp": "2026-01-01T00:00:00Z",
        },
        "entries": [
            {
                "type": "message",
                "id": "u1",
                "parentId": None,
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            },
            {
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "bash-call",
                            "name": "bash",
                            "arguments": {"command": "echo hello"},
                        }
                    ],
                    "provider": "faux",
                    "model": "faux-1",
                    "usage": {"input": 1, "output": 1, "cost": {"total": 0}},
                    "stopReason": "toolUse",
                },
            },
            {
                "type": "message",
                "id": "r1",
                "parentId": "a1",
                "timestamp": "2026-01-01T00:00:02Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "bash-call",
                    "toolName": "bash",
                    "content": [{"type": "text", "text": "hello\n"}],
                    "isError": False,
                },
            },
        ],
        "leafId": "r1",
    }

    html = generate_html(session_data)
    assert 'id="session-data"' in html
    assert '<section class="tool-message">' not in html
    payload = _session_payload(html)
    assert payload["entries"][2]["message"]["toolName"] == "bash"


class _ExportSession:
    def __init__(self, session_manager: SessionManager) -> None:
        self.session_manager = session_manager
        self.system_prompt = "test prompt"
        self.session_id = "export-test-session"

        class _Agent:
            class _State:
                tools: list[object] = []

            state = _State()

        self.agent = _Agent()


@pytest.mark.anyio
async def test_export_session_to_html_passes_rendered_tools(tmp_path: Path) -> None:
    session_file = tmp_path / "session.jsonl"
    _write_session(
        session_file,
        [
            {
                "type": "message",
                "id": "u1",
                "parentId": None,
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "search"}]},
            },
            {
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "find-call",
                            "name": "find",
                            "arguments": {"pattern": "*.py", "path": "."},
                        }
                    ],
                    "provider": "faux",
                    "model": "faux-1",
                    "usage": {"input": 1, "output": 1, "cost": {"total": 0}},
                    "stopReason": "toolUse",
                },
            },
            {
                "type": "message",
                "id": "r1",
                "parentId": "a1",
                "timestamp": "2026-01-01T00:00:02Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "find-call",
                    "toolName": "find",
                    "content": [{"type": "text", "text": "./sample.py"}],
                    "isError": False,
                },
            },
        ],
    )

    session_manager = SessionManager.open(str(session_file))
    output_file = tmp_path / "session-export.html"
    renderer = create_tool_html_renderer(cwd=str(tmp_path))
    session = _ExportSession(session_manager)

    path = export_session_to_html(
        session,
        str(output_file),
        tool_renderer=renderer,
    )

    html = Path(path).read_text(encoding="utf-8")
    payload = _session_payload(html)
    assert payload.get("renderedTools")
    assert "find-call" in payload["renderedTools"]
    assert "ansi-rendered" in html or "find" in html
