from datetime import datetime, timezone

from pi_mono.coding_agent.modes.interactive.components.session_selector_search import (
    filter_and_sort_sessions,
    has_session_name,
    match_session,
    parse_search_query,
)


def _session(
    *,
    session_id: str = "abc",
    name: str | None = None,
    first_message: str = "hello",
    all_messages_text: str = "hello world",
    cwd: str = "/tmp/proj",
    modified: datetime | None = None,
) -> dict:
    return {
        "id": session_id,
        "path": f"/tmp/{session_id}.jsonl",
        "name": name,
        "firstMessage": first_message,
        "allMessagesText": all_messages_text,
        "cwd": cwd,
        "modified": modified or datetime(2026, 1, 1, tzinfo=timezone.utc),
    }


def test_has_session_name():
    assert has_session_name(_session(name="named")) is True
    assert has_session_name(_session(name="  ")) is False
    assert has_session_name(_session(name=None)) is False


def test_parse_search_query_empty():
    parsed = parse_search_query("   ")
    assert parsed.mode == "tokens"
    assert parsed.tokens == []
    assert parsed.regex is None
    assert parsed.error is None


def test_parse_search_query_regex_mode():
    parsed = parse_search_query("re:hello")
    assert parsed.mode == "regex"
    assert parsed.regex is not None
    assert parsed.regex.search("say hello there")


def test_parse_search_query_regex_invalid():
    parsed = parse_search_query("re:[")
    assert parsed.error is not None


def test_parse_search_query_phrase_tokens():
    parsed = parse_search_query('foo "exact phrase" bar')
    assert [token.value for token in parsed.tokens] == ["foo", "exact phrase", "bar"]
    assert [token.kind for token in parsed.tokens] == ["fuzzy", "phrase", "fuzzy"]


def test_match_session_phrase():
    session = _session(all_messages_text="alpha beta gamma")
    parsed = parse_search_query('"beta gamma"')
    assert match_session(session, parsed).matches is True


def test_filter_and_sort_sessions_recent_preserves_order():
    sessions = [
        _session(session_id="a", modified=datetime(2026, 1, 3, tzinfo=timezone.utc)),
        _session(session_id="b", modified=datetime(2026, 1, 2, tzinfo=timezone.utc)),
    ]
    filtered = filter_and_sort_sessions(sessions, "hello", "recent")
    assert [item["id"] for item in filtered] == ["a", "b"]


def test_filter_and_sort_sessions_relevance_sorts_by_score():
    sessions = [
        _session(session_id="late", all_messages_text="zzzz hello at end"),
        _session(session_id="early", all_messages_text="hello near start"),
    ]
    filtered = filter_and_sort_sessions(sessions, "hello", "relevance")
    assert [item["id"] for item in filtered] == ["early", "late"]


def test_filter_and_sort_sessions_named_filter():
    sessions = [
        _session(session_id="named", name="work"),
        _session(session_id="unnamed", name=None),
    ]
    filtered = filter_and_sort_sessions(sessions, "", "recent", "named")
    assert len(filtered) == 1
    assert filtered[0]["id"] == "named"
