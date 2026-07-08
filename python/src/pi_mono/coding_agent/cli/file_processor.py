"""Process @file CLI arguments into text content and image attachments."""

from __future__ import annotations

import base64
import mimetypes
import os
import sys
from dataclasses import dataclass

from pi_mono.ai.types import ImageContent
from pi_mono.coding_agent.core.tools.path_utils import resolve_read_path

SUPPORTED_IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}


@dataclass
class ProcessedFiles:
    text: str
    images: list[ImageContent]


@dataclass
class ProcessFileOptions:
    auto_resize_images: bool = True


def _detect_image_mime_type(path: str) -> str | None:
    mime_type, _ = mimetypes.guess_type(path)
    if mime_type and mime_type in SUPPORTED_IMAGE_MIME_TYPES:
        return mime_type
    return None


async def process_file_arguments(
    file_args: list[str],
    *,
    cwd: str | None = None,
    options: ProcessFileOptions | None = None,
) -> ProcessedFiles:
    del options  # auto-resize not implemented in basic scaffold
    working_cwd = cwd or os.getcwd()
    text = ""
    images: list[ImageContent] = []

    for file_arg in file_args:
        absolute_path = os.path.abspath(resolve_read_path(file_arg, working_cwd))

        if not os.path.exists(absolute_path):
            print(f"Error: File not found: {absolute_path}", file=sys.stderr)
            raise SystemExit(1)

        if os.path.getsize(absolute_path) == 0:
            continue

        mime_type = _detect_image_mime_type(absolute_path)
        if mime_type:
            content = open(absolute_path, "rb").read()
            images.append(
                {
                    "type": "image",
                    "mimeType": mime_type,
                    "data": base64.b64encode(content).decode("ascii"),
                }
            )
            text += f'<file name="{absolute_path}"></file>\n'
            continue

        try:
            file_text = open(absolute_path, encoding="utf-8").read()
            text += f'<file name="{absolute_path}">\n{file_text}\n</file>\n'
        except OSError as error:
            print(f"Error: Could not read file {absolute_path}: {error}", file=sys.stderr)
            raise SystemExit(1) from error

    return ProcessedFiles(text=text, images=images)
