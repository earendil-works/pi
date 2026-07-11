from pi_mono.coding_agent.modes.interactive.components.settings_selector import (
    SettingsConfig,
    build_settings_items,
    handle_settings_change,
)


def test_build_settings_items_includes_phase2_settings() -> None:
    config = SettingsConfig(
        auto_compact=True,
        show_images=True,
        steering_mode="all",
        follow_up_mode="one-at-a-time",
        thinking_level="medium",
        available_thinking_levels=["off", "medium"],
        current_theme="dark",
        available_themes=["dark", "light"],
        hide_thinking_block=True,
        collapse_changelog=True,
        quiet_startup=True,
        tree_filter_mode="user-only",
    )
    items = build_settings_items(config)
    item_ids = {item.id for item in items}
    assert "hide-thinking" in item_ids
    assert "cache-miss-notices" in item_ids
    assert "output-padding" in item_ids
    assert "collapse-changelog" in item_ids
    assert "quiet-startup" in item_ids
    assert "tree-filter-mode" in item_ids


def test_handle_settings_change_phase2_callbacks() -> None:
    calls: dict[str, object] = {}

    class Callbacks:
        def on_auto_compact_change(self, enabled: bool) -> None:
            calls["auto_compact"] = enabled

        def on_show_images_change(self, enabled: bool) -> None:
            calls["show_images"] = enabled

        def on_steering_mode_change(self, mode: str) -> None:
            calls["steering"] = mode

        def on_follow_up_mode_change(self, mode: str) -> None:
            calls["follow_up"] = mode

        def on_thinking_level_change(self, level: str) -> None:
            calls["thinking"] = level

        def on_theme_change(self, theme_name: str) -> None:
            calls["theme"] = theme_name

        def on_theme_preview(self, theme_name: str) -> None:
            calls["preview"] = theme_name

        def on_hide_thinking_block_change(self, hidden: bool) -> None:
            calls["hide_thinking"] = hidden

        def on_show_cache_miss_notices_change(self, show: bool) -> None:
            calls["cache_miss"] = show

        def on_output_pad_change(self, padding: int) -> None:
            calls["output_pad"] = padding

        def on_collapse_changelog_change(self, collapsed: bool) -> None:
            calls["collapse_changelog"] = collapsed

        def on_quiet_startup_change(self, enabled: bool) -> None:
            calls["quiet_startup"] = enabled

        def on_tree_filter_mode_change(self, mode: str) -> None:
            calls["tree_filter_mode"] = mode

        def on_cancel(self) -> None:
            calls["cancel"] = True

    callbacks = Callbacks()
    handle_settings_change("hide-thinking", "true", callbacks)
    handle_settings_change("cache-miss-notices", "true", callbacks)
    handle_settings_change("output-padding", "0", callbacks)
    handle_settings_change("tree-filter-mode", "user-only", callbacks)
    assert calls["hide_thinking"] is True
    assert calls["cache_miss"] is True
    assert calls["output_pad"] == 0
    assert calls["tree_filter_mode"] == "user-only"
