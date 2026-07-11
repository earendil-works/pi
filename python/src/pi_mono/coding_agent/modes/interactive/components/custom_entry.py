"""Custom extension entry component for interactive mode."""

from __future__ import annotations

from typing import Any, Callable

from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.box import Box
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container

EntryRenderer = Callable[[dict[str, Any], dict[str, Any], Any], Container | str | None]


class CustomEntryComponent(Container):
    """Renders a display-only custom session entry from an extension renderer."""

    def __init__(
        self,
        entry: dict[str, Any],
        renderer: EntryRenderer,
    ) -> None:
        super().__init__()
        self._entry = entry
        self._renderer = renderer
        self._expanded = False
        self._custom_component: Container | None = None
        self._rebuild()

    def has_content(self) -> bool:
        return self._custom_component is not None

    def set_expanded(self, expanded: bool) -> None:
        if self._expanded != expanded:
            self._expanded = expanded
            self._rebuild()

    def invalidate(self) -> None:
        super().invalidate()
        self._rebuild()

    def _rebuild(self) -> None:
        self.clear()
        self._custom_component = None
        component: Container | None = None
        try:
            rendered = self._renderer(
                self._entry,
                {"expanded": self._expanded},
                theme,
            )
            if isinstance(rendered, Container):
                component = rendered
            elif isinstance(rendered, str) and rendered.strip():
                box = Box(1, 1, theme.bg_fn("customMessageBg"))
                box.add_child(Text(rendered, padding_x=0, padding_y=0))
                component = box
        except Exception as error:
            box = Box(1, 1, theme.bg_fn("customMessageBg"))
            custom_type = str(self._entry.get("customType", "custom"))
            box.add_child(
                Text(
                    theme.fg("error", f"[{custom_type}] renderer failed: {error}"),
                    padding_x=0,
                    padding_y=0,
                )
            )
            component = box

        if component is None:
            return

        self._custom_component = component
        self.add_child(Spacer(1))
        self.add_child(component)
