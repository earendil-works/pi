"""Convert images to PNG for terminal display."""

from __future__ import annotations

import base64
import io

from PIL import Image

from pi_mono.utils.exif_orientation import apply_exif_orientation


def convert_to_png(base64_data: str, mime_type: str) -> dict[str, str] | None:
    """Convert an image to PNG. Returns base64 data and mime type."""
    if mime_type == "image/png":
        return {"data": base64_data, "mimeType": mime_type}

    try:
        raw = base64.b64decode(base64_data)
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            oriented = apply_exif_orientation(image.copy())
            if oriented.mode not in ("RGB", "RGBA", "L", "LA"):
                oriented = oriented.convert("RGBA")
            buffer = io.BytesIO()
            oriented.save(buffer, format="PNG")
            return {
                "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
                "mimeType": "image/png",
            }
    except Exception:
        return None
