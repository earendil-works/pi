"""Settings selector overlay for interactive mode."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, Protocol

from pi_mono.agent.types import AgentThinkingLevel
from pi_mono.coding_agent.modes.interactive.components.thinking_selector import (
    ThinkingSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.components.show_images_selector import (
    ShowImagesSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import (
    get_available_themes,
    get_settings_list_theme,
    theme,
)
from pi_mono.tui.components.select_list import SelectItem, SelectList
from pi_mono.tui.components.settings_list import SettingItem, SettingsList, SettingsListOptions
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container

ThinkingLevel = AgentThinkingLevel
SteeringMode = Literal["all", "one-at-a-time"]
FollowUpMode = Literal["all", "one-at-a-time"]
TreeFilterMode = Literal["default", "no-tools", "user-only", "labeled-only", "all"]


@dataclass
class SettingsConfig:
    auto_compact: bool
    show_images: bool
    steering_mode: SteeringMode
    follow_up_mode: FollowUpMode
    thinking_level: ThinkingLevel
    available_thinking_levels: list[ThinkingLevel]
    current_theme: str
    available_themes: list[str]
    hide_thinking_block: bool = False
    show_cache_miss_notices: bool = False
    collapse_changelog: bool = False
    quiet_startup: bool = False
    tree_filter_mode: TreeFilterMode = "default"
    output_pad: int = 1


class SettingsCallbacks(Protocol):
    def on_auto_compact_change(self, enabled: bool) -> None: ...

    def on_show_images_change(self, enabled: bool) -> None: ...

    def on_steering_mode_change(self, mode: SteeringMode) -> None: ...

    def on_follow_up_mode_change(self, mode: FollowUpMode) -> None: ...

    def on_thinking_level_change(self, level: ThinkingLevel) -> None: ...

    def on_theme_change(self, theme_name: str) -> None: ...

    def on_theme_preview(self, theme_name: str) -> None: ...

    def on_hide_thinking_block_change(self, hidden: bool) -> None: ...

    def on_show_cache_miss_notices_change(self, show: bool) -> None: ...

    def on_collapse_changelog_change(self, collapsed: bool) -> None: ...

    def on_quiet_startup_change(self, enabled: bool) -> None: ...

    def on_tree_filter_mode_change(self, mode: TreeFilterMode) -> None: ...

    def on_output_pad_change(self, padding: int) -> None: ...

    def on_cancel(self) -> None: ...


class _SelectSubmenu(Container):
    def __init__(
        self,
        title: str,
        description: str,
        options: list[SelectItem],
        current_value: str,
        on_select: Callable[[str], None],
        on_cancel: Callable[[], None],
        on_selection_change: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__()
        self.add_child(Text(theme.bold(theme.fg("accent", title)), padding_x=0, padding_y=0))
        if description:
            self.add_child(Spacer(1))
            self.add_child(Text(theme.fg("muted", description), padding_x=0, padding_y=0))
        self.add_child(Spacer(1))

        from pi_mono.coding_agent.modes.interactive.theme.theme import get_select_list_theme

        self._select_list = SelectList(options, min(len(options), 10), get_select_list_theme())
        current_index = next(
            (index for index, item in enumerate(options) if item.value == current_value), 0
        )
        self._select_list.set_selected_index(current_index)
        self._select_list.on_select = lambda item: on_select(item.value)
        self._select_list.on_cancel = on_cancel
        if on_selection_change is not None:
            self._select_list.on_selection_change = lambda item: on_selection_change(item.value)
        self.add_child(self._select_list)
        self.add_child(Spacer(1))
        self.add_child(
            Text(theme.fg("dim", "  Enter to select · Esc to go back"), padding_x=0, padding_y=0)
        )

    def handle_input(self, data: str) -> None:
        self._select_list.handle_input(data)


def build_settings_items(config: SettingsConfig) -> list[SettingItem]:
    """Build the settings list items for the selector (unit-testable)."""
    return [
        SettingItem(
            id="autocompact",
            label="Auto-compact",
            description="Automatically compact context when it gets too large",
            current_value="true" if config.auto_compact else "false",
            values=["true", "false"],
        ),
        SettingItem(
            id="show-images",
            label="Show images",
            description="Render images inline in terminal",
            current_value="true" if config.show_images else "false",
        ),
        SettingItem(
            id="steering-mode",
            label="Steering mode",
            description=(
                "Enter while streaming queues steering messages. "
                "'one-at-a-time': deliver one, wait for response. 'all': deliver all at once."
            ),
            current_value=config.steering_mode,
            values=["one-at-a-time", "all"],
        ),
        SettingItem(
            id="follow-up-mode",
            label="Follow-up mode",
            description=(
                "Ctrl+O queues follow-up messages until agent stops. "
                "'one-at-a-time': deliver one, wait for response. 'all': deliver all at once."
            ),
            current_value=config.follow_up_mode,
            values=["one-at-a-time", "all"],
        ),
        SettingItem(
            id="thinking",
            label="Thinking level",
            description="Reasoning depth for thinking-capable models",
            current_value=config.thinking_level,
        ),
        SettingItem(
            id="theme",
            label="Theme",
            description="Color theme for the interface",
            current_value=config.current_theme,
        ),
        SettingItem(
            id="hide-thinking",
            label="Hide thinking blocks",
            description="Collapse reasoning blocks in assistant messages",
            current_value="true" if config.hide_thinking_block else "false",
            values=["true", "false"],
        ),
        SettingItem(
            id="cache-miss-notices",
            label="Cache miss notices",
            description="Show transcript notices for significant prompt-cache misses",
            current_value="true" if config.show_cache_miss_notices else "false",
            values=["true", "false"],
        ),
        SettingItem(
            id="output-padding",
            label="Output padding",
            description="Horizontal padding for user messages, assistant messages, and thinking",
            current_value=str(config.output_pad),
            values=["0", "1"],
        ),
        SettingItem(
            id="collapse-changelog",
            label="Collapse changelog",
            description="Show condensed changelog banner on startup",
            current_value="true" if config.collapse_changelog else "false",
            values=["true", "false"],
        ),
        SettingItem(
            id="quiet-startup",
            label="Quiet startup",
            description="Suppress non-essential startup messages",
            current_value="true" if config.quiet_startup else "false",
            values=["true", "false"],
        ),
        SettingItem(
            id="tree-filter-mode",
            label="Tree filter mode",
            description="Default filter for /tree session navigator",
            current_value=config.tree_filter_mode,
            values=["default", "no-tools", "user-only", "labeled-only", "all"],
        ),
    ]


def _attach_settings_submenus(
    items: list[SettingItem],
    config: SettingsConfig,
    callbacks: SettingsCallbacks,
) -> None:
    thinking_item = next(item for item in items if item.id == "thinking")
    theme_item = next(item for item in items if item.id == "theme")
    show_images_item = next(item for item in items if item.id == "show-images")

    def thinking_submenu(current_value: str, done: Callable[[str | None], None]) -> Container:
        def on_select(level: ThinkingLevel) -> None:
            callbacks.on_thinking_level_change(level)
            done(level)

        return ThinkingSelectorComponent(
            current_value,  # type: ignore[arg-type]
            config.available_thinking_levels,
            on_select,
            lambda: done(None),
        )

    def theme_submenu(current_value: str, done: Callable[[str | None], None]) -> Container:
        options = [SelectItem(value=name, label=name) for name in config.available_themes]

        def on_select(value: str) -> None:
            callbacks.on_theme_change(value)
            done(value)

        def on_cancel() -> None:
            callbacks.on_theme_preview(current_value)
            done(None)

        return _SelectSubmenu(
            "Theme",
            "Select color theme",
            options,
            current_value,
            on_select,
            on_cancel,
            on_selection_change=callbacks.on_theme_preview,
        )

    def show_images_submenu(current_value: str, done: Callable[[str | None], None]) -> Container:
        def on_select(enabled: bool) -> None:
            callbacks.on_show_images_change(enabled)
            done("true" if enabled else "false")

        return ShowImagesSelectorComponent(
            current_value=current_value == "true",
            on_select=on_select,
            on_cancel=lambda: done(None),
        )

    thinking_item.submenu = thinking_submenu  # type: ignore[assignment]
    theme_item.submenu = theme_submenu  # type: ignore[assignment]
    show_images_item.submenu = show_images_submenu  # type: ignore[assignment]


def handle_settings_change(item_id: str, new_value: str, callbacks: SettingsCallbacks) -> None:
    if item_id == "autocompact":
        callbacks.on_auto_compact_change(new_value == "true")
    elif item_id == "show-images":
        callbacks.on_show_images_change(new_value == "true")
    elif item_id == "steering-mode":
        callbacks.on_steering_mode_change(new_value)  # type: ignore[arg-type]
    elif item_id == "follow-up-mode":
        callbacks.on_follow_up_mode_change(new_value)  # type: ignore[arg-type]
    elif item_id == "hide-thinking":
        callbacks.on_hide_thinking_block_change(new_value == "true")
    elif item_id == "cache-miss-notices":
        callbacks.on_show_cache_miss_notices_change(new_value == "true")
    elif item_id == "output-padding":
        callbacks.on_output_pad_change(0 if new_value == "0" else 1)
    elif item_id == "collapse-changelog":
        callbacks.on_collapse_changelog_change(new_value == "true")
    elif item_id == "quiet-startup":
        callbacks.on_quiet_startup_change(new_value == "true")
    elif item_id == "tree-filter-mode":
        callbacks.on_tree_filter_mode_change(new_value)  # type: ignore[arg-type]


class SettingsSelectorComponent(Container):
    """Subset settings selector for interactive mode."""

    def __init__(self, config: SettingsConfig, callbacks: SettingsCallbacks) -> None:
        super().__init__()
        items = build_settings_items(config)
        _attach_settings_submenus(items, config, callbacks)

        self._settings_list = SettingsList(
            items,
            10,
            get_settings_list_theme(),
            lambda item_id, new_value: handle_settings_change(item_id, new_value, callbacks),
            callbacks.on_cancel,
            SettingsListOptions(enable_search=True),
        )
        self.add_child(Text(theme.bold("Settings"), padding_x=1, padding_y=0))
        self.add_child(Spacer(1))
        self.add_child(self._settings_list)

    def get_settings_list(self) -> SettingsList:
        return self._settings_list

    def handle_input(self, data: str) -> None:
        self._settings_list.handle_input(data)


def build_settings_config_from_session(session: Any) -> SettingsConfig:
    """Helper to build SettingsConfig from an AgentSession."""
    settings_manager = session.settings_manager
    return SettingsConfig(
        auto_compact=session.auto_compaction_enabled,
        show_images=settings_manager.get_show_images(),
        steering_mode=session.steering_mode,  # type: ignore[arg-type]
        follow_up_mode=session.follow_up_mode,  # type: ignore[arg-type]
        thinking_level=session.thinking_level,
        available_thinking_levels=session.get_available_thinking_levels(),
        current_theme=settings_manager.get_theme() or "dark",
        available_themes=get_available_themes(),
        hide_thinking_block=settings_manager.get_hide_thinking_block(),
        show_cache_miss_notices=settings_manager.get_show_cache_miss_notices(),
        collapse_changelog=settings_manager.get_collapse_changelog(),
        quiet_startup=settings_manager.get_quiet_startup(),
        tree_filter_mode=settings_manager.get_tree_filter_mode(),  # type: ignore[arg-type]
        output_pad=settings_manager.get_output_pad(),
    )
