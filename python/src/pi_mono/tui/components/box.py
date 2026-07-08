"""Box component - a container that applies padding and background to all children"""

from typing import Callable, List, Optional

from pi_mono.tui.utils import apply_background_to_line, visible_width
from pi_mono.tui.editor_component import Component


class RenderCache:
    """Cache for rendered output"""

    def __init__(
        self, child_lines: List[str], width: int, bg_sample: Optional[str], lines: List[str]
    ):
        self.child_lines = child_lines
        self.width = width
        self.bg_sample = bg_sample
        self.lines = lines


class Box(Component):
    """Box component - a container that applies padding and background to all children"""

    def __init__(
        self,
        padding_x: int = 1,
        padding_y: int = 1,
        bg_fn: Optional[Callable[[str], str]] = None,
    ) -> None:
        self.children: List[Component] = []
        self.padding_x = padding_x
        self.padding_y = padding_y
        self.bg_fn = bg_fn
        self._cache: Optional[RenderCache] = None

    def add_child(self, component: Component) -> None:
        self.children.append(component)
        self._invalidate_cache()

    def remove_child(self, component: Component) -> None:
        if component in self.children:
            self.children.remove(component)
            self._invalidate_cache()

    def clear(self) -> None:
        self.children = []
        self._invalidate_cache()

    def set_bg_fn(self, bg_fn: Optional[Callable[[str], str]]) -> None:
        self.bg_fn = bg_fn
        # Don't invalidate here - we'll detect bg_fn changes by sampling output

    def _invalidate_cache(self) -> None:
        self._cache = None

    def _match_cache(self, width: int, child_lines: List[str], bg_sample: Optional[str]) -> bool:
        cache = self._cache
        if not cache:
            return False
        return (
            cache.width == width
            and cache.bg_sample == bg_sample
            and len(cache.child_lines) == len(child_lines)
            and all(a == b for a, b in zip(cache.child_lines, child_lines))
        )

    def invalidate(self) -> None:
        self._invalidate_cache()
        for child in self.children:
            if hasattr(child, "invalidate"):
                child.invalidate()

    def render(self, width: int) -> List[str]:
        if not self.children:
            return []

        content_width = max(1, width - self.padding_x * 2)
        left_pad = " " * self.padding_x

        # Render all children
        child_lines: List[str] = []
        for child in self.children:
            lines = child.render(content_width)
            for line in lines:
                child_lines.append(left_pad + line)

        if not child_lines:
            return []

        # Check if bg_fn output changed by sampling
        bg_sample = self.bg_fn("test") if self.bg_fn else None

        # Check cache validity
        if self._match_cache(width, child_lines, bg_sample):
            assert self._cache is not None
            return self._cache.lines

        # Apply background and padding
        result: List[str] = []

        # Top padding
        for _ in range(self.padding_y):
            result.append(self._apply_bg("", width))

        # Content
        for line in child_lines:
            result.append(self._apply_bg(line, width))

        # Bottom padding
        for _ in range(self.padding_y):
            result.append(self._apply_bg("", width))

        # Update cache
        self._cache = RenderCache(child_lines, width, bg_sample, result)

        return result

    def _apply_bg(self, line: str, width: int) -> str:
        vis_len = visible_width(line)
        pad_needed = max(0, width - vis_len)
        padded = line + " " * pad_needed

        if self.bg_fn:
            return apply_background_to_line(padded, width, self.bg_fn)
        return padded

    def handle_input(self, data: str) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False
