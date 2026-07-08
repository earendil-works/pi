"""Pillow-based image resize helpers."""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from typing import Any

from PIL import Image

from pi_mono.utils.exif_orientation import apply_exif_orientation

DEFAULT_MAX_BYTES = int(4.5 * 1024 * 1024)


@dataclass
class ImageResizeOptions:
    max_width: int = 2000
    max_height: int = 2000
    max_bytes: int = DEFAULT_MAX_BYTES
    jpeg_quality: int = 80


@dataclass
class ResizedImage:
    data: str
    mime_type: str
    original_width: int
    original_height: int
    width: int
    height: int
    was_resized: bool


def _encoded_size(data_b64: str) -> int:
    return len(data_b64.encode("utf-8"))


def _encode_image(image: Image.Image, mime_type: str, jpeg_quality: int) -> tuple[str, str]:
    buffer = io.BytesIO()
    if mime_type == "image/png":
        image.save(buffer, format="PNG", optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("ascii"), "image/png"
    image = image.convert("RGB")
    image.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii"), "image/jpeg"


def resize_image(
    input_bytes: bytes,
    mime_type: str,
    options: ImageResizeOptions | dict[str, Any] | None = None,
) -> ResizedImage | None:
    """Resize an image to fit within max dimensions and encoded size."""
    opts = (
        options
        if isinstance(options, ImageResizeOptions)
        else ImageResizeOptions(**(options or {}))
    )

    try:
        with Image.open(io.BytesIO(input_bytes)) as image:
            image.load()
            original_width, original_height = image.size
            working = apply_exif_orientation(image.copy())
    except Exception:
        return None

    was_resized = False
    if working.width > opts.max_width or working.height > opts.max_height:
        working.thumbnail((opts.max_width, opts.max_height), Image.Resampling.LANCZOS)
        was_resized = True

    output_mime = (
        mime_type if mime_type in ("image/png", "image/jpeg", "image/webp") else "image/jpeg"
    )
    data, output_mime = _encode_image(working, output_mime, opts.jpeg_quality)

    quality = opts.jpeg_quality
    while _encoded_size(data) > opts.max_bytes and (working.width > 1 or working.height > 1):
        was_resized = True
        new_width = max(1, int(working.width * 0.85))
        new_height = max(1, int(working.height * 0.85))
        working = working.resize((new_width, new_height), Image.Resampling.LANCZOS)
        if output_mime == "image/jpeg" and quality > 40:
            quality = max(40, quality - 10)
        data, output_mime = _encode_image(working, output_mime, quality)

    if _encoded_size(data) > opts.max_bytes:
        return None

    return ResizedImage(
        data=data,
        mime_type=output_mime,
        original_width=original_width,
        original_height=original_height,
        width=working.width,
        height=working.height,
        was_resized=was_resized,
    )


def format_dimension_note(result: ResizedImage) -> str | None:
    if not result.was_resized:
        return None
    scale = result.original_width / result.width if result.width else 1.0
    return (
        f"[Image: original {result.original_width}x{result.original_height}, "
        f"displayed at {result.width}x{result.height}. "
        f"Multiply coordinates by {scale:.2f} to map to original image.]"
    )
