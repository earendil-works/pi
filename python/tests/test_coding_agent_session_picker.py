from datetime import datetime, timezone

from pi_mono.coding_agent.cli.session_picker import format_session_date, sessions_to_select_items


def test_format_session_date_recent():
    now = datetime.now(timezone.utc)
    assert format_session_date(now) == "now"


def test_sessions_to_select_items_uses_name_and_preview():
    modified = datetime(2026, 1, 1, tzinfo=timezone.utc)
    sessions = [
        {
            "id": "abcd-1234-5678",
            "path": "/tmp/session.jsonl",
            "name": "feature work",
            "modified": modified,
            "firstMessage": "Implement export support",
        }
    ]

    items = sessions_to_select_items(sessions)

    assert len(items) == 1
    assert items[0].value == "/tmp/session.jsonl"
    assert items[0].label == "feature work"
    assert items[0].description is not None
    assert "m" in items[0].description or "mo" in items[0].description


def test_sessions_to_select_items_truncates_long_preview():
    sessions = [
        {
            "id": "abcd-1234",
            "path": "/tmp/session.jsonl",
            "firstMessage": "x" * 80,
            "modified": datetime(2026, 1, 1, tzinfo=timezone.utc),
        }
    ]

    items = sessions_to_select_items(sessions)

    assert len(items[0].label) == 80
