"""TruncatedText component - text that truncates to fit viewport width"""

from typing import List

from pi_mono.tui.utils import truncate_to_width, visible_width
from pi_mono.tui.editor_component import Component


class TruncatedText(Component):
    """Text component that truncates to fit viewport width"""

    def __init__(self, text: str, padding_x: int = 0, padding_y: int = 0) -> None:
        self.text = text
        self.padding_x = padding_x
        self.padding_y = padding_y

    def invalidate(self) -> None:
        # No cached state to invalidate currently
        pass

    def render(self, width: int) -> List[str]:
        result: List[str] = []

        # Empty line padded to width
        empty_line = " " * width

        # Add vertical padding above
        for _ in range(self.padding_y):
            result.append(empty_line)

        # Calculate available width after horizontal padding
        available_width = max(1, width - self.padding_x * 2)

        # Take only the first line (stop at newline)
        single_line_text = self.text
        newline_index = self.text.find("\n")
        if newline_index != -1:
            single_line_text = self.text[:newline_index]

        # Truncate text if needed (accounting for ANSI codes)
        display_text = truncate_to_width(single_line_text, available_width)

        # Add horizontal padding
        left_padding = " " * self.padding_x
        right_padding = " " * self.padding_x
        line_with_padding = left_padding + display_text + right_padding

        # Pad line to exactly width characters
        line_visible_width = visible_width(line_with_padding)
        padding_needed = max(0, width - line_visible_width)
        final_line = line_with_padding + " " * padding_needed

        result.append(final_line)

        # Add vertical padding below
        for _ in range(self.padding_y):
            result.append(empty_line)

        return result

    def handle_input(self, data: str) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False
