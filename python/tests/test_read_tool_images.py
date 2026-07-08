"""Read tool image handling tests (Phase 2)."""

from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from PIL import Image

from pi_mono.coding_agent.core.tools.read import (
    create_read_tool,
    execute_read,
    get_non_vision_image_note,
)
from pi_mono.coding_agent.core.tools.render_utils import get_text_output
from pi_mono.coding_agent.core.tools.truncate import DEFAULT_MAX_LINES
from pi_mono.utils.image_resize import ResizedImage, format_dimension_note, resize_image
from pi_mono.utils.mime import detect_supported_image_mime_type

TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
TINY_PNG_BYTES = base64.b64decode(TINY_PNG_BASE64)

VISION_MODEL: dict[str, Any] = {
    "provider": "test",
    "id": "vision",
    "api": "test",
    "input": ["text", "image"],
}
TEXT_ONLY_MODEL: dict[str, Any] = {
    "provider": "test",
    "id": "text",
    "api": "test",
    "input": ["text"],
}


def _write_png(path: Path, *, name: str | None = None) -> Path:
    target = path / (name or "image.png")
    target.write_bytes(TINY_PNG_BYTES)
    return target


@pytest.mark.anyio
async def test_detect_image_mime_from_magic_not_extension(tmp_path: Path) -> None:
    image_path = tmp_path / "image.txt"
    image_path.write_bytes(TINY_PNG_BYTES)

    result = await execute_read(str(tmp_path), str(image_path))

    assert result["content"][0]["type"] == "text"
    assert "Read image file [image/png]" in get_text_output(result)
    image_block = next(block for block in result["content"] if block.get("type") == "image")
    assert image_block["mimeType"] == "image/png"
    assert isinstance(image_block["data"], str)
    assert len(image_block["data"]) > 0


@pytest.mark.anyio
async def test_image_extension_with_non_image_content_reads_as_text(tmp_path: Path) -> None:
    fake_png = tmp_path / "not-an-image.png"
    fake_png.write_text("definitely not a png", encoding="utf-8")

    result = await execute_read(str(tmp_path), str(fake_png))
    output = get_text_output(result)

    assert "definitely not a png" in output
    assert not any(block.get("type") == "image" for block in result["content"])


@pytest.mark.anyio
async def test_non_vision_model_adds_note_but_keeps_image_attachment(tmp_path: Path) -> None:
    image_path = _write_png(tmp_path)

    result = await execute_read(
        str(tmp_path),
        str(image_path),
        model=TEXT_ONLY_MODEL,
    )

    text = get_text_output(result)
    assert "Read image file [image/png]" in text
    assert get_non_vision_image_note(TEXT_ONLY_MODEL) in text
    assert any(block.get("type") == "image" for block in result["content"])


@pytest.mark.anyio
async def test_vision_model_has_no_non_vision_note(tmp_path: Path) -> None:
    image_path = _write_png(tmp_path)

    result = await execute_read(
        str(tmp_path),
        str(image_path),
        model=VISION_MODEL,
    )

    text = get_text_output(result)
    assert get_non_vision_image_note(VISION_MODEL) is None
    assert "does not support images" not in text


@pytest.mark.anyio
async def test_resize_failure_returns_text_only_output(tmp_path: Path) -> None:
    image_path = _write_png(tmp_path)

    with patch(
        "pi_mono.coding_agent.core.tools.read.resize_image",
        return_value=None,
    ):
        result = await execute_read(str(tmp_path), str(image_path))

    assert len(result["content"]) == 1
    assert result["content"][0]["type"] == "text"
    assert "Image omitted" in result["content"][0]["text"]


@pytest.mark.anyio
async def test_text_truncation_unchanged_for_large_files(tmp_path: Path) -> None:
    lines = [f"line {index}" for index in range(DEFAULT_MAX_LINES + 500)]
    text_path = tmp_path / "large.txt"
    text_path.write_text("\n".join(lines), encoding="utf-8")

    result = await execute_read(str(tmp_path), str(text_path))

    assert result["details"] is not None
    truncation = result["details"]["truncation"]
    assert truncation["truncated"] is True
    assert truncation["truncatedBy"] == "lines"
    assert truncation["totalLines"] == len(lines)
    assert truncation["outputLines"] == DEFAULT_MAX_LINES
    assert not any(block.get("type") == "image" for block in result["content"])


def test_get_text_output_hides_image_blocks_when_show_images_false() -> None:
    result = {
        "content": [
            {"type": "text", "text": "Read image file [image/png]"},
            {"type": "image", "mimeType": "image/png", "data": TINY_PNG_BASE64},
        ]
    }

    assert "[image:" not in get_text_output(result, show_images=True)
    hidden = get_text_output(result, show_images=False)
    assert "Read image file [image/png]" in hidden
    assert "[image: image/png]" in hidden


def test_resize_image_keeps_small_png_within_limits() -> None:
    result = resize_image(
        TINY_PNG_BYTES,
        "image/png",
        {"max_width": 100, "max_height": 100, "max_bytes": 1024 * 1024},
    )
    assert result is not None
    assert result.was_resized is False
    assert result.original_width == 1
    assert result.original_height == 1


def test_format_dimension_note_for_resized_image() -> None:
    note = format_dimension_note(
        ResizedImage(
            data="",
            mime_type="image/png",
            original_width=2000,
            original_height=1000,
            width=1000,
            height=500,
            was_resized=True,
        )
    )
    assert note is not None
    assert "original 2000x1000" in note
    assert "displayed at 1000x500" in note
    assert "2.00" in note


def test_detect_supported_image_mime_type_from_bytes() -> None:
    assert detect_supported_image_mime_type(TINY_PNG_BYTES) == "image/png"
    assert detect_supported_image_mime_type(b"not an image") is None


def test_convert_to_png_from_jpeg() -> None:
    from pi_mono.utils.image_convert import convert_to_png

    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color="blue").save(buffer, format="JPEG")
    data = base64.b64encode(buffer.getvalue()).decode("ascii")
    converted = convert_to_png(data, "image/jpeg")
    assert converted is not None
    assert converted["mimeType"] == "image/png"


@pytest.mark.anyio
async def test_create_read_tool_execute_accepts_extension_ctx_model(tmp_path: Path) -> None:
    image_path = _write_png(tmp_path)
    tool = create_read_tool(str(tmp_path))

    class _Ctx:
        @property
        def model(self) -> dict[str, Any]:
            return TEXT_ONLY_MODEL

    result = await tool.execute("call-1", {"path": str(image_path)}, None, None, _Ctx())
    assert get_non_vision_image_note(TEXT_ONLY_MODEL) in get_text_output(result)
