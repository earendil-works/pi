from pi_mono.coding_agent.modes.interactive.components.tree_selector import (
    BranchListItem,
    filter_branch_entries,
    flatten_branch_entries,
    format_branch_entry_label,
)


def _user_entry(entry_id: str, text: str) -> dict:
    return {
        "id": entry_id,
        "type": "message",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": text}],
        },
    }


def _assistant_entry(entry_id: str, text: str) -> dict:
    return {
        "id": entry_id,
        "type": "message",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    }


def test_flatten_branch_entries_filters_navigable_messages():
    branch = [
        {"id": "s1", "type": "session_info"},
        _user_entry("u1", "hello"),
        _assistant_entry("a1", "hi there"),
        {"id": "c1", "type": "compaction"},
        {"id": "l1", "type": "label", "targetId": "u1", "label": "greeting"},
        {"id": "t1", "type": "message", "message": {"role": "toolResult", "content": []}},
    ]

    items = flatten_branch_entries(branch, current_leaf_id="a1")

    assert [item.entry_id for item in items] == ["u1", "a1", "c1"]
    assert items[0].description == "user"
    assert items[1].is_current_leaf is True
    assert items[2].entry_type == "compaction"


def test_flatten_branch_entries_uses_labels():
    branch = [_user_entry("u1", "hello world")]

    items = flatten_branch_entries(
        branch,
        labels_by_id={"u1": "greeting"},
        current_leaf_id="u1",
    )

    assert items[0].label == "greeting (user: hello world)"


def test_format_branch_entry_label_truncates_long_text():
    long_text = "word " * 30
    entry = _assistant_entry("a1", long_text.strip())

    label = format_branch_entry_label(entry)

    assert label.startswith("assistant:")
    assert label.endswith("...")


def test_filter_branch_entries_matches_query():
    items = [
        BranchListItem("u1", "user: hello", "user", "message", False),
        BranchListItem("a1", "assistant: world", "assistant", "message", True),
        BranchListItem("c1", "compaction", "compaction", "compaction", False),
    ]

    filtered = filter_branch_entries(items, "comp")

    assert [item.entry_id for item in filtered] == ["c1"]
