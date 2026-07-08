"""EXIF orientation helpers for images."""

from __future__ import annotations

import io

from PIL import Image, ImageOps


def apply_exif_orientation(image: Image.Image) -> Image.Image:
    """Apply EXIF orientation tag so the image displays upright."""
    try:
        return ImageOps.exif_transpose(image)
    except Exception:
        return image


def apply_exif_orientation_bytes(input_bytes: bytes) -> bytes:
    """Return image bytes with EXIF orientation applied."""
    with Image.open(io.BytesIO(input_bytes)) as image:
        image.load()
        oriented = apply_exif_orientation(image.copy())
        buffer = io.BytesIO()
        fmt = image.format or "PNG"
        save_format = "PNG" if fmt.upper() == "PNG" else "JPEG"
        if save_format == "JPEG" and oriented.mode not in ("RGB", "L"):
            oriented = oriented.convert("RGB")
        oriented.save(buffer, format=save_format)
        return buffer.getvalue()
