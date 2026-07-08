"""Terminal image protocol support (Kitty, iTerm2) and capability detection.

Ported from TypeScript's terminal-image.ts with pure Python image header parsing.
"""

from __future__ import annotations

import base64
import os
import subprocess
import struct
from typing import Callable, Optional

# =============================================================================
# Type Definitions
# =============================================================================

ImageProtocol = Optional[str]  # "kitty" | "iterm2" | None


class TerminalCapabilities:
    """Terminal capabilities detected at runtime."""

    def __init__(
        self,
        images: ImageProtocol,
        true_color: bool,
        hyperlinks: bool,
    ):
        self.images = images
        self.true_color = true_color
        self.hyperlinks = hyperlinks

    def __repr__(self) -> str:
        return f"TerminalCapabilities(images={self.images!r}, true_color={self.true_color}, hyperlinks={self.hyperlinks})"


class CellDimensions:
    """Terminal cell dimensions in pixels."""

    def __init__(self, width_px: int, height_px: int):
        self.width_px = width_px
        self.height_px = height_px

    def __repr__(self) -> str:
        return f"CellDimensions(width_px={self.width_px}, height_px={self.height_px})"


class ImageDimensions:
    """Image dimensions in pixels."""

    def __init__(self, width_px: int, height_px: int):
        self.width_px = width_px
        self.height_px = height_px

    @property
    def widthPx(self) -> int:
        return self.width_px

    @property
    def heightPx(self) -> int:
        return self.height_px

    def __repr__(self) -> str:
        return f"ImageDimensions(width_px={self.width_px}, height_px={self.height_px})"


class ImageRenderOptions:
    """Options for rendering images in the terminal."""

    def __init__(
        self,
        max_width_cells: Optional[int] = None,
        max_height_cells: Optional[int] = None,
        preserve_aspect_ratio: bool = True,
        image_id: Optional[int] = None,
        move_cursor: bool = True,
    ):
        self.max_width_cells = max_width_cells
        self.max_height_cells = max_height_cells
        self.preserve_aspect_ratio = preserve_aspect_ratio
        self.image_id = image_id
        self.move_cursor = move_cursor


class ImageCellSize:
    """Calculated image size in terminal cells."""

    def __init__(self, columns: int, rows: int):
        self.columns = columns
        self.rows = rows

    def __repr__(self) -> str:
        return f"ImageCellSize(columns={self.columns}, rows={self.rows})"


# =============================================================================
# Module State
# =============================================================================

_cached_capabilities: Optional[TerminalCapabilities] = None
_cell_dimensions = CellDimensions(9, 18)  # Default cell size


# =============================================================================
# Capability Detection
# =============================================================================


def _probe_tmux_hyperlinks() -> bool:
    """Check if tmux forwards OSC 8 hyperlinks to outer terminal."""
    try:
        result = subprocess.run(
            ["tmux", "display-message", "-p", "#{client_termfeatures}"],
            capture_output=True,
            text=True,
            timeout=0.25,
            stdin=subprocess.DEVNULL,
        )
        termfeatures = result.stdout.strip()
        return "hyperlinks" in [f.strip() for f in termfeatures.split(",")]
    except Exception:
        return False


def detect_capabilities(
    tmux_forwards_hyperlink: Optional[Callable[[], bool]] = None
) -> TerminalCapabilities:
    """Detect terminal capabilities based on environment variables."""
    if tmux_forwards_hyperlink is None:
        tmux_forwards_hyperlink = _probe_tmux_hyperlinks

    term_program = os.environ.get("TERM_PROGRAM", "").lower()
    terminal_emulator = os.environ.get("TERMINAL_EMULATOR", "").lower()
    term = os.environ.get("TERM", "").lower()
    color_term = os.environ.get("COLORTERM", "").lower()
    has_true_color_hint = color_term in ("truecolor", "24bit")

    # tmux - image protocols unreliable, only hyperlinks if confirmed
    if os.environ.get("TMUX") or term.startswith("tmux"):
        return TerminalCapabilities(
            images=None,
            true_color=has_true_color_hint,
            hyperlinks=tmux_forwards_hyperlink(),
        )

    # screen - no hyperlinks
    if term.startswith("screen"):
        return TerminalCapabilities(
            images=None,
            true_color=has_true_color_hint,
            hyperlinks=False,
        )

    # Kitty
    if os.environ.get("KITTY_WINDOW_ID") or term_program == "kitty":
        return TerminalCapabilities(images="kitty", true_color=True, hyperlinks=True)

    # Ghostty
    if term_program == "ghostty" or "ghostty" in term or os.environ.get("GHOSTTY_RESOURCES_DIR"):
        return TerminalCapabilities(images="kitty", true_color=True, hyperlinks=True)

    # WezTerm
    if os.environ.get("WEZTERM_PANE") or term_program == "wezterm":
        return TerminalCapabilities(images="kitty", true_color=True, hyperlinks=True)

    # iTerm2
    if os.environ.get("ITERM_SESSION_ID") or term_program == "iterm.app":
        return TerminalCapabilities(images="iterm2", true_color=True, hyperlinks=True)

    # Windows Terminal
    if os.environ.get("WT_SESSION"):
        return TerminalCapabilities(images=None, true_color=True, hyperlinks=True)

    # VS Code
    if term_program == "vscode":
        return TerminalCapabilities(images=None, true_color=True, hyperlinks=True)

    # Alacritty
    if term_program == "alacritty":
        return TerminalCapabilities(images=None, true_color=True, hyperlinks=True)

    # JetBrains
    if terminal_emulator == "jetbrains-jediterm":
        return TerminalCapabilities(images=None, true_color=True, hyperlinks=False)

    # Unknown terminal - conservative
    return TerminalCapabilities(
        images=None,
        true_color=has_true_color_hint,
        hyperlinks=False,
    )


def get_capabilities() -> TerminalCapabilities:
    """Get cached terminal capabilities."""
    global _cached_capabilities
    if _cached_capabilities is None:
        _cached_capabilities = detect_capabilities()
    return _cached_capabilities


def reset_capabilities_cache() -> None:
    """Reset cached capabilities (useful for testing)."""
    global _cached_capabilities
    _cached_capabilities = None


def set_capabilities(caps: TerminalCapabilities) -> None:
    """Override cached capabilities (useful for testing)."""
    global _cached_capabilities
    _cached_capabilities = caps


def get_cell_dimensions() -> CellDimensions:
    """Get current cell dimensions."""
    return _cell_dimensions


def set_cell_dimensions(dims: CellDimensions) -> None:
    """Set cell dimensions (updated when terminal responds to query)."""
    global _cell_dimensions
    _cell_dimensions = dims


# =============================================================================
# Image Protocol Encoders
# =============================================================================

KITTY_PREFIX = "\x1b_G"
ITERM2_PREFIX = "\x1b]1337;File="


def is_image_line(line: str) -> bool:
    """Check if a line contains an image protocol sequence."""
    if line.startswith(KITTY_PREFIX) or line.startswith(ITERM2_PREFIX):
        return True
    return KITTY_PREFIX in line or ITERM2_PREFIX in line


def allocate_image_id() -> int:
    """Generate a random image ID for Kitty protocol."""
    import random

    return random.randrange(1, 0xFFFFFFFE)


def _kitty_option(options: dict, snake: str, camel: str):
    if snake in options:
        return options[snake]
    return options.get(camel)


def encode_kitty(
    base64_data: str,
    options: Optional[dict] = None,
) -> str:
    """Encode image data for Kitty graphics protocol."""
    options = options or {}
    CHUNK_SIZE = 4096

    params = ["a=T", "f=100", "q=2"]

    if _kitty_option(options, "move_cursor", "moveCursor") is False:
        params.append("C=1")
    columns = _kitty_option(options, "columns", "columns")
    if columns:
        params.append(f"c={columns}")
    rows = _kitty_option(options, "rows", "rows")
    if rows:
        params.append(f"r={rows}")
    image_id = _kitty_option(options, "image_id", "imageId")
    if image_id:
        params.append(f"i={image_id}")

    if len(base64_data) <= CHUNK_SIZE:
        return f"\x1b_G{','.join(params)};{base64_data}\x1b\\"

    chunks = []
    offset = 0
    is_first = True

    while offset < len(base64_data):
        chunk = base64_data[offset : offset + CHUNK_SIZE]
        is_last = offset + CHUNK_SIZE >= len(base64_data)

        if is_first:
            chunks.append(f"\x1b_G{','.join(params)},m=1;{chunk}\x1b\\")
            is_first = False
        elif is_last:
            chunks.append(f"\x1b_Gm=0;{chunk}\x1b\\")
        else:
            chunks.append(f"\x1b_Gm=1;{chunk}\x1b\\")

        offset += CHUNK_SIZE

    return "".join(chunks)


def delete_kitty_image(image_id: int) -> str:
    """Delete a Kitty graphics image by ID (uppercase 'I' frees data)."""
    return f"\x1b_Ga=d,d=I,i={image_id},q=2\x1b\\"


def delete_all_kitty_images() -> str:
    """Delete all visible Kitty graphics images."""
    return "\x1b_Ga=d,d=A,q=2\x1b\\"


def encode_iterm2(
    base64_data: str,
    options: Optional[dict] = None,
) -> str:
    """Encode image data for iTerm2 inline image protocol."""
    options = options or {}

    params = [f"inline={1 if options.get('inline', True) else 0}"]

    if options.get("width") is not None:
        params.append(f"width={options['width']}")
    if options.get("height") is not None:
        params.append(f"height={options['height']}")
    if options.get("name"):
        name_base64 = base64.b64encode(options["name"].encode()).decode()
        params.append(f"name={name_base64}")
    if options.get("preserve_aspect_ratio") is False:
        params.append("preserveAspectRatio=0")

    return f"\x1b]1337;File={';'.join(params)}:{base64_data}\x07"


def calculate_image_cell_size(
    image_dimensions: ImageDimensions,
    max_width_cells: int,
    max_height_cells: Optional[int] = None,
    cell_dimensions: CellDimensions = CellDimensions(9, 18),
) -> ImageCellSize:
    """Calculate image size in terminal cells."""
    max_width = max(1, int(max_width_cells))
    max_height = max(1, int(max_height_cells)) if max_height_cells is not None else None
    image_width = max(1, image_dimensions.width_px)
    image_height = max(1, image_dimensions.height_px)

    width_scale = (max_width * cell_dimensions.width_px) / image_width
    height_scale = (
        width_scale
        if max_height is None
        else (max_height * cell_dimensions.height_px) / image_height
    )
    scale = min(width_scale, height_scale)

    scaled_width_px = image_width * scale
    scaled_height_px = image_height * scale
    columns = int((scaled_width_px + cell_dimensions.width_px - 1) // cell_dimensions.width_px)
    rows = int((scaled_height_px + cell_dimensions.height_px - 1) // cell_dimensions.height_px)

    return ImageCellSize(
        columns=max(1, min(max_width, columns)),
        rows=max(1, rows if max_height is None else min(max_height, rows)),
    )


def calculate_image_rows(
    image_dimensions: ImageDimensions,
    target_width_cells: int,
    cell_dimensions: CellDimensions = CellDimensions(9, 18),
) -> int:
    """Calculate number of rows an image will occupy."""
    return calculate_image_cell_size(
        image_dimensions, target_width_cells, None, cell_dimensions
    ).rows


# =============================================================================
# Image Dimension Extraction (Pure Python)
# =============================================================================


def _parse_png_dimensions(data: bytes) -> Optional[ImageDimensions]:
    """Extract dimensions from PNG header."""
    if len(data) < 24:
        return None
    # PNG signature
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    # IHDR chunk at offset 8, width at 16, height at 20
    width = struct.unpack(">I", data[16:20])[0]
    height = struct.unpack(">I", data[20:24])[0]
    return ImageDimensions(width, height)


def _parse_jpeg_dimensions(data: bytes) -> Optional[ImageDimensions]:
    """Extract dimensions from JPEG header."""
    if len(data) < 2:
        return None
    if data[:2] != b"\xff\xd8":
        return None

    offset = 2
    while offset < len(data) - 9:
        if data[offset] != 0xFF:
            offset += 1
            continue

        marker = data[offset + 1]

        # SOF0, SOF1, SOF2 (baseline, extended sequential, progressive)
        if 0xC0 <= marker <= 0xC2:
            if offset + 9 > len(data):
                return None
            height = struct.unpack(">H", data[offset + 5 : offset + 7])[0]
            width = struct.unpack(">H", data[offset + 7 : offset + 9])[0]
            return ImageDimensions(width, height)

        if offset + 3 >= len(data):
            return None
        length = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
        if length < 2:
            return None
        offset += 2 + length

    return None


def _parse_gif_dimensions(data: bytes) -> Optional[ImageDimensions]:
    """Extract dimensions from GIF header."""
    if len(data) < 10:
        return None

    sig = data[:6].decode("ascii", errors="ignore")
    if sig not in ("GIF87a", "GIF89a"):
        return None

    width = struct.unpack("<H", data[6:8])[0]
    height = struct.unpack("<H", data[8:10])[0]
    return ImageDimensions(width, height)


def _parse_webp_dimensions(data: bytes) -> Optional[ImageDimensions]:
    """Extract dimensions from WebP header."""
    if len(data) < 30:
        return None

    riff = data[:4].decode("ascii", errors="ignore")
    webp = data[8:12].decode("ascii", errors="ignore")
    if riff != "RIFF" or webp != "WEBP":
        return None

    chunk = data[12:16].decode("ascii", errors="ignore")

    if chunk == "VP8 ":
        # Lossy WebP (VP8)
        if len(data) < 30:
            return None
        width = struct.unpack("<H", data[26:28])[0] & 0x3FFF
        height = struct.unpack("<H", data[28:30])[0] & 0x3FFF
        return ImageDimensions(width, height)
    elif chunk == "VP8L":
        # Lossless WebP (VP8L)
        if len(data) < 25:
            return None
        bits = struct.unpack("<I", data[21:25])[0]
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return ImageDimensions(width, height)
    elif chunk == "VP8X":
        # Extended WebP (VP8X)
        if len(data) < 30:
            return None
        width = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1
        height = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1
        return ImageDimensions(width, height)

    return None


def get_png_dimensions(base64_data: str) -> Optional[ImageDimensions]:
    """Get dimensions from base64-encoded PNG."""
    try:
        data = base64.b64decode(base64_data)
        return _parse_png_dimensions(data)
    except Exception:
        return None


def get_jpeg_dimensions(base64_data: str) -> Optional[ImageDimensions]:
    """Get dimensions from base64-encoded JPEG."""
    try:
        data = base64.b64decode(base64_data)
        return _parse_jpeg_dimensions(data)
    except Exception:
        return None


def get_gif_dimensions(base64_data: str) -> Optional[ImageDimensions]:
    """Get dimensions from base64-encoded GIF."""
    try:
        data = base64.b64decode(base64_data)
        return _parse_gif_dimensions(data)
    except Exception:
        return None


def get_webp_dimensions(base64_data: str) -> Optional[ImageDimensions]:
    """Get dimensions from base64-encoded WebP."""
    try:
        data = base64.b64decode(base64_data)
        return _parse_webp_dimensions(data)
    except Exception:
        return None


def get_image_dimensions(base64_data: str, mime_type: str) -> Optional[ImageDimensions]:
    """Get image dimensions from base64 data based on MIME type."""
    if mime_type == "image/png":
        return get_png_dimensions(base64_data)
    if mime_type == "image/jpeg":
        return get_jpeg_dimensions(base64_data)
    if mime_type == "image/gif":
        return get_gif_dimensions(base64_data)
    if mime_type == "image/webp":
        return get_webp_dimensions(base64_data)
    return None


# =============================================================================
# High-Level Rendering
# =============================================================================


def _normalize_render_options(
    options: Optional[ImageRenderOptions | dict],
) -> ImageRenderOptions:
    if options is None:
        return ImageRenderOptions()
    if isinstance(options, ImageRenderOptions):
        return options
    return ImageRenderOptions(
        max_width_cells=options.get("max_width_cells", options.get("maxWidthCells")),
        max_height_cells=options.get("max_height_cells", options.get("maxHeightCells")),
        preserve_aspect_ratio=options.get(
            "preserve_aspect_ratio",
            options.get("preserveAspectRatio", True),
        ),
        image_id=options.get("image_id", options.get("imageId")),
        move_cursor=options.get("move_cursor", options.get("moveCursor", True)),
    )


def render_image(
    base64_data: str,
    image_dimensions: ImageDimensions,
    options: Optional[ImageRenderOptions | dict] = None,
) -> Optional[dict]:
    """Render an image using the detected terminal protocol."""
    options = _normalize_render_options(options)
    caps = get_capabilities()

    if not caps.images:
        return None

    max_width = options.max_width_cells or 80
    size = calculate_image_cell_size(
        image_dimensions,
        max_width,
        options.max_height_cells,
        get_cell_dimensions(),
    )

    if caps.images == "kitty":
        sequence = encode_kitty(
            base64_data,
            {
                "columns": size.columns,
                "rows": size.rows,
                "imageId": options.image_id,
                "moveCursor": options.move_cursor,
            },
        )
        return {"sequence": sequence, "rows": size.rows, "imageId": options.image_id}

    if caps.images == "iterm2":
        sequence = encode_iterm2(
            base64_data,
            {
                "width": size.columns,
                "height": "auto",
                "preserveAspectRatio": options.preserve_aspect_ratio,
            },
        )
        return {"sequence": sequence, "rows": size.rows}

    return None


def hyperlink(text: str, url: str) -> str:
    """Wrap text in an OSC 8 hyperlink sequence."""
    return f"\x1b]8;;{url}\x1b\\{text}\x1b]8;;\x1b\\"


def image_fallback(
    mime_type: str,
    dimensions: Optional[ImageDimensions] = None,
    filename: Optional[str] = None,
) -> str:
    """Generate a text fallback for images."""
    parts = []
    if filename:
        parts.append(filename)
    parts.append(f"[{mime_type}]")
    if dimensions:
        parts.append(f"{dimensions.width_px}x{dimensions.height_px}")
    return f"[Image: {' '.join(parts)}]"


# =============================================================================
# Exports
# =============================================================================

__all__ = [
    "TerminalCapabilities",
    "CellDimensions",
    "ImageDimensions",
    "ImageRenderOptions",
    "ImageCellSize",
    "detect_capabilities",
    "get_capabilities",
    "reset_capabilities_cache",
    "set_capabilities",
    "get_cell_dimensions",
    "set_cell_dimensions",
    "is_image_line",
    "allocate_image_id",
    "encode_kitty",
    "encode_iterm2",
    "delete_kitty_image",
    "delete_all_kitty_images",
    "calculate_image_cell_size",
    "calculate_image_rows",
    "get_png_dimensions",
    "get_jpeg_dimensions",
    "get_gif_dimensions",
    "get_webp_dimensions",
    "get_image_dimensions",
    "render_image",
    "hyperlink",
    "image_fallback",
]
