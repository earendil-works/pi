from pi_mono.coding_agent.modes.interactive.components.settings_selector import (
    SettingsConfig,
    build_settings_items,
    handle_settings_change,
)


def test_build_settings_items_includes_core_subset():
    config = SettingsConfig(
        auto_compact=True,
        show_images=False,
        steering_mode="one-at-a-time",
        follow_up_mode="all",
        thinking_level="medium",
        available_thinking_levels=["off", "medium", "high"],
        current_theme="dark",
        available_themes=["dark", "light"],
    )

    items = build_settings_items(config)
    item_ids = [item.id for item in items]

    assert item_ids == [
        "autocompact",
        "show-images",
        "steering-mode",
        "follow-up-mode",
        "thinking",
        "theme",
        "hide-thinking",
        "cache-miss-notices",
        "output-padding",
        "collapse-changelog",
        "quiet-startup",
        "tree-filter-mode",
    ]
    assert next(item for item in items if item.id == "autocompact").current_value == "true"
    assert next(item for item in items if item.id == "show-images").current_value == "false"
    assert (
        next(item for item in items if item.id == "steering-mode").current_value == "one-at-a-time"
    )
    assert next(item for item in items if item.id == "thinking").current_value == "medium"
    assert next(item for item in items if item.id == "theme").current_value == "dark"


def test_handle_settings_change_dispatches_callbacks():
    calls: list[tuple[str, object]] = []

    class Callbacks:
        def on_auto_compact_change(self, enabled: bool) -> None:
            calls.append(("auto_compact", enabled))

        def on_show_images_change(self, enabled: bool) -> None:
            calls.append(("show_images", enabled))

        def on_steering_mode_change(self, mode: str) -> None:
            calls.append(("steering_mode", mode))

        def on_follow_up_mode_change(self, mode: str) -> None:
            calls.append(("follow_up_mode", mode))

        def on_thinking_level_change(self, level: str) -> None:
            calls.append(("thinking_level", level))

        def on_theme_change(self, theme_name: str) -> None:
            calls.append(("theme", theme_name))

        def on_theme_preview(self, theme_name: str) -> None:
            calls.append(("theme_preview", theme_name))

        def on_cancel(self) -> None:
            calls.append(("cancel", True))

    callbacks = Callbacks()
    handle_settings_change("autocompact", "false", callbacks)
    handle_settings_change("show-images", "true", callbacks)
    handle_settings_change("steering-mode", "all", callbacks)
    handle_settings_change("follow-up-mode", "one-at-a-time", callbacks)

    assert calls == [
        ("auto_compact", False),
        ("show_images", True),
        ("steering_mode", "all"),
        ("follow_up_mode", "one-at-a-time"),
    ]
