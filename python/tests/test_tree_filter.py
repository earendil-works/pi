from pi_mono.coding_agent.modes.interactive.components.tree_selector import (
    BranchListItem,
    apply_tree_filter_mode,
)


def _item(entry_id: str, description: str, entry_type: str = "message") -> BranchListItem:
    return BranchListItem(
        entry_id=entry_id,
        label=entry_id,
        description=description,
        entry_type=entry_type,
        is_current_leaf=False,
    )


def test_apply_tree_filter_mode_user_only() -> None:
    items = [_item("1", "user"), _item("2", "assistant")]
    filtered = apply_tree_filter_mode(items, "user-only")
    assert [item.entry_id for item in filtered] == ["1"]


def test_apply_tree_filter_mode_labeled_only() -> None:
    items = [_item("1", "user"), _item("2", "assistant")]
    filtered = apply_tree_filter_mode(items, "labeled-only", labels_by_id={"2": "checkpoint"})
    assert [item.entry_id for item in filtered] == ["2"]
