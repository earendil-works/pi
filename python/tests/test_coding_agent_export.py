import json
from datetime import datetime, timezone

from pi_mono.coding_agent.core.export_html import export_from_file


def _write_sample_session(path) -> None:
    header = {
        "type": "session",
        "version": 3,
        "id": "test-session-id",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "cwd": "/tmp/project",
    }
    user_message = {
        "type": "message",
        "id": "entry-1",
        "parentId": None,
        "timestamp": header["timestamp"],
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "Hello from export test"}],
        },
    }
    assistant_message = {
        "type": "message",
        "id": "entry-2",
        "parentId": "entry-1",
        "timestamp": header["timestamp"],
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "Assistant reply for export"}],
            "provider": "faux",
            "model": "faux-1",
            "usage": {
                "input": 1,
                "output": 2,
                "cacheRead": 0,
                "cacheWrite": 0,
                "cost": {"total": 0},
            },
            "stopReason": "stop",
        },
    }
    with path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(header) + "\n")
        handle.write(json.dumps(user_message) + "\n")
        handle.write(json.dumps(assistant_message) + "\n")


def test_export_from_file_writes_html(tmp_path):
    session_file = tmp_path / "session.jsonl"
    output_file = tmp_path / "out.html"
    _write_sample_session(session_file)

    result_path = export_from_file(str(session_file), str(output_file))

    assert result_path == str(output_file)
    html = output_file.read_text(encoding="utf-8")
    assert "<!DOCTYPE html>" in html
    if "Hello from export test" in html:
        return
    import base64
    import re

    match = re.search(r'<script id="session-data"[^>]*>([^<]+)</script>', html)
    assert match is not None
    payload = json.loads(base64.b64decode(match.group(1)).decode("utf-8"))
    serialized = json.dumps(payload)
    assert "Hello from export test" in serialized
    assert "Assistant reply for export" in serialized


def test_export_from_file_missing_input(tmp_path):
    missing = tmp_path / "missing.jsonl"
    try:
        export_from_file(str(missing))
    except FileNotFoundError as error:
        assert "File not found" in str(error)
    else:
        raise AssertionError("expected FileNotFoundError")
