"""Text component - displays multi-line text with word wrapping"""

from typing import Callable, List, Optional

from pi_mono.tui.utils import (
    apply_background_to_line,
    visible_width,
    wrap_text_with_ansi,
)
from pi_mono.tui.editor_component import Component


class Text(Component):
    """Text component - displays multi-line text with word wrapping"""

    def __init__(
        self,
        text: str = "",
        padding_x: int = 1,
        padding_y: int = 1,
        custom_bg_fn: Optional[Callable[[str], str]] = None,
    ) -> None:
        self.text = text
        self.padding_x = padding_x
        self.padding_y = padding_y
        self.custom_bg_fn = custom_bg_fn

        self._cached_text: Optional[str] = None
        self._cached_width: Optional[int] = None
        self._cached_lines: Optional[List[str]] = None

    def set_text(self, text: str) -> None:
        self.text = text
        self._cached_text = None
        self._cached_width = None
        self._cached_lines = None

    def set_custom_bg_fn(self, custom_bg_fn: Optional[Callable[[str], str]]) -> None:
        self.custom_bg_fn = custom_bg_fn
        self._cached_text = None
        self._cached_width = None
        self._cached_lines = None

    def invalidate(self) -> None:
        self._cached_text = None
        self._cached_width = None
        self._cached_lines = None

    def render(self, width: int) -> List[str]:
        # Check cache
        if (
            self._cached_lines is not None
            and self._cached_text == self.text
            and self._cached_width == width
        ):
            return self._cached_lines

        # Don't render anything if there's no actual text
        if not self.text or self.text.strip() == "":
            result: List[str] = []
            self._cached_text = self.text
            self._cached_width = width
            self._cached_lines = result
            return result

        # Replace tabs with 3 spaces
        normalized_text = self.text.replace("\t", "   ")

        # Calculate content width (subtract left/right margins)
        content_width = max(1, width - self.padding_x * 2)

        # Wrap text (this preserves ANSI codes but does NOT pad)
        wrapped_lines = wrap_text_with_ansi(normalized_text, content_width)

        # Add margins and background to each line
        left_margin = " " * self.padding_x
        right_margin = " " * self.padding_x
        content_lines: List[str] = []

        for line in wrapped_lines:
            # Add margins
            line_with_margins = left_margin + line + right_margin

            # Apply background if specified (this also pads to full width)
            if self.custom_bg_fn:
                content_lines.append(
                    apply_background_to_line(line_with_margins, width, self.custom_bg_fn)
                )
            else:
                # No background - just pad to width with spaces
                visible_len = visible_width(line_with_margins)
                padding_needed = max(0, width - visible_len)
                content_lines.append(line_with_margins + " " * padding_needed)

        # Add top/bottom padding (empty lines)
        empty_line = " " * width
        empty_lines: List[str] = []
        for _ in range(self.padding_y):
            line = (
                apply_background_to_line(empty_line, width, self.custom_bg_fn)
                if self.custom_bg_fn
                else empty_line
            )
            empty_lines.append(line)

        result = empty_lines + content_lines + empty_lines

        # Update cache
        self._cached_text = self.text
        self._cached_width = width
        self._cached_lines = result

        return result if len(result) > 0 else [""]

    def handle_input(self, data: str) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False
