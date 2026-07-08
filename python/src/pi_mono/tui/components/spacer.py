"""Spacer component that renders empty lines"""

from typing import List

from pi_mono.tui.editor_component import Component


class Spacer(Component):
    """Spacer component that renders empty lines"""

    def __init__(self, lines: int = 1) -> None:
        self.lines = lines

    def set_lines(self, lines: int) -> None:
        self.lines = lines

    def invalidate(self) -> None:
        # No cached state to invalidate currently
        pass

    def render(self, width: int) -> List[str]:
        return [""] * self.lines

    def handle_input(self, data: str) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False
