"""Normalize images for inline model attachments (BMP→PNG, resize)."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Literal

from pi_mono.utils.image_convert import convert_to_png
from pi_mono.utils.image_resize import ImageResizeOptions, format_dimension_note, resize_image


@dataclass
class ProcessImageOptions:
    auto_resize_images: bool = True
    resize_options: ImageResizeOptions | None = None


@dataclass
class ProcessImageOk:
    ok: Literal[True] = True
    data: str = ""
    mime_type: str = ""
    hints: list[str] | None = None


@dataclass
class ProcessImageErr:
    ok: Literal[False] = False
    message: str = ""


ProcessImageResult = ProcessImageOk | ProcessImageErr


def _base_mime_type(mime_type: str) -> str:
    return (mime_type.split(";", 1)[0] or mime_type).strip().lower()


def _normalize_supported_image_mime_type(mime_type: str) -> str | None:
    match _base_mime_type(mime_type):
        case "image/png":
            return "image/png"
        case "image/jpeg" | "image/jpg":
            return "image/jpeg"
        case "image/gif":
            return "image/gif"
        case "image/webp":
            return "image/webp"
        case _:
            return None


def _conversion_hint(from_type: str | None, to_type: str) -> str | None:
    if not from_type or from_type == to_type:
        return None
    return f"[Image converted from {from_type} to {to_type}.]"


def process_image(
    raw_bytes: bytes,
    mime_type: str,
    options: ProcessImageOptions | None = None,
) -> ProcessImageResult:
    opts = options or ProcessImageOptions()
    auto_resize = opts.auto_resize_images
    normalized_mime = _normalize_supported_image_mime_type(mime_type)
    converted_from: str | None = None
    data_b64 = base64.b64encode(raw_bytes).decode("ascii")
    out_mime = normalized_mime or mime_type

    if normalized_mime is None:
        converted = convert_to_png(data_b64, mime_type)
        if converted is None:
            return ProcessImageErr(
                message="[Image omitted: could not be converted to a supported inline image format.]"
            )
        data_b64 = converted["data"]
        out_mime = converted["mimeType"]
        converted_from = _base_mime_type(mime_type)

    if auto_resize:
        resized = resize_image(
            base64.b64decode(data_b64),
            out_mime,
            opts.resize_options,
        )
        if resized is None:
            return ProcessImageErr(
                message="[Image omitted: could not be resized below the inline image size limit.]"
            )
        hints: list[str] = []
        converted_hint = _conversion_hint(converted_from, resized.mime_type)
        if converted_hint:
            hints.append(converted_hint)
        dimension_note = format_dimension_note(resized)
        if dimension_note:
            hints.append(dimension_note)
        return ProcessImageOk(
            data=resized.data,
            mime_type=resized.mime_type,
            hints=hints,
        )

    hints = []
    converted_hint = _conversion_hint(converted_from, out_mime)
    if converted_hint:
        hints.append(converted_hint)
    return ProcessImageOk(data=data_b64, mime_type=out_mime, hints=hints)
