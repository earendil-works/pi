"""Image component - renders images using terminal graphics protocols"""

from dataclasses import dataclass
from typing import Callable, List, Optional

from pi_mono.tui.terminal_image import (
    allocate_image_id,
    get_capabilities,
    get_cell_dimensions,
    get_image_dimensions,
    ImageDimensions,
    image_fallback,
    render_image,
)
from pi_mono.tui.editor_component import Component


@dataclass
class ImageTheme:
    fallback_color: Callable[[str], str]


@dataclass
class ImageOptions:
    max_width_cells: Optional[int] = None
    max_height_cells: Optional[int] = None
    filename: Optional[str] = None
    image_id: Optional[int] = None


class Image(Component):
    """Image component - renders images using terminal graphics protocols"""

    def __init__(
        self,
        base64_data: str,
        mime_type: str,
        theme: ImageTheme,
        options: Optional[ImageOptions] = None,
        dimensions: Optional[ImageDimensions] = None,
    ) -> None:
        self._base64_data = base64_data
        self._mime_type = mime_type
        self._theme = theme
        self._options = options or ImageOptions()
        self._image_id = self._options.image_id
        self._cached_lines: Optional[List[str]] = None
        self._cached_width: Optional[int] = None

        if dimensions:
            self._dimensions = dimensions
        else:
            dims = get_image_dimensions(base64_data, mime_type)
            self._dimensions = dims or ImageDimensions(800, 600)

    @property
    def image_id(self) -> Optional[int]:
        """Get the Kitty image ID used by this image (if any)"""
        return self._image_id

    def invalidate(self) -> None:
        self._cached_lines = None
        self._cached_width = None

    def render(self, width: int) -> List[str]:
        if self._cached_lines and self._cached_width == width:
            return self._cached_lines

        max_width = max(1, min(width - 2, self._options.max_width_cells or 60))
        cell_dimensions = get_cell_dimensions()
        default_max_height = max(
            1, (max_width * cell_dimensions.widthPx) // cell_dimensions.heightPx
        )
        max_height = self._options.max_height_cells or default_max_height

        caps = get_capabilities()
        lines: List[str]

        if caps.images:
            if caps.images == "kitty" and self._image_id is None:
                self._image_id = allocate_image_id()

            result = render_image(
                self._base64_data,
                self._dimensions,
                {
                    "max_width_cells": max_width,
                    "max_height_cells": max_height,
                    "image_id": self._image_id,
                    "move_cursor": False,
                },
            )

            if result:
                # Store the image ID for later cleanup
                if result.get("image_id"):
                    self._image_id = result["image_id"]

                if caps.images == "kitty":
                    # For Kitty: C=1 prevents cursor movement
                    lines = [result["sequence"]]

                    # Return `rows` lines so TUI accounts for image height
                    for _ in range(result["rows"] - 1):
                        lines.append("")
                else:
                    # iTerm2: cursor movement handling
                    lines = []
                    for _ in range(result["rows"] - 1):
                        lines.append("")
                    row_offset = result["rows"] - 1
                    move_up = f"\x1b[{row_offset}A" if row_offset > 0 else ""
                    lines.append(move_up + result["sequence"])
            else:
                fallback = image_fallback(self._mime_type, self._dimensions, self._options.filename)
                lines = [self._theme.fallback_color(fallback)]
        else:
            fallback = image_fallback(self._mime_type, self._dimensions, self._options.filename)
            lines = [self._theme.fallback_color(fallback)]

        self._cached_lines = lines
        self._cached_width = width

        return lines

    def handle_input(self, data: str) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False
