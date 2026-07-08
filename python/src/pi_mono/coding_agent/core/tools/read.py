"""Read tool."""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Any, Protocol

from pi_mono.agent.types import AgentTool, AgentToolResult
from pi_mono.coding_agent.core.tools.path_utils import resolve_read_path_async
from pi_mono.coding_agent.core.tools.truncate import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    TruncationResult,
    formatSize,
    truncateHead,
)
from pi_mono.utils.image_resize import format_dimension_note, resize_image
from pi_mono.utils.mime import detect_supported_image_mime_type_from_file

NON_VISION_IMAGE_NOTE = (
    "[Current model does not support images. The image will be omitted from this request.]"
)


def get_non_vision_image_note(model: dict[str, Any] | None) -> str | None:
    if not model:
        return None
    input_types = model.get("input") or []
    if "image" in input_types:
        return None
    return NON_VISION_IMAGE_NOTE


@dataclass
class ReadToolDetails:
    truncation: TruncationResult | None = None


class ReadOperations(Protocol):
    async def read_file(self, absolute_path: str) -> bytes: ...
    async def access(self, absolute_path: str) -> None: ...
    async def detect_image_mime_type(self, absolute_path: str) -> str | None: ...


class DefaultReadOperations:
    async def read_file(self, absolute_path: str) -> bytes:
        with open(absolute_path, "rb") as handle:
            return handle.read()

    async def access(self, absolute_path: str) -> None:
        if not os.access(absolute_path, os.R_OK):
            raise PermissionError(f"Cannot read: {absolute_path}")

    async def detect_image_mime_type(self, absolute_path: str) -> str | None:
        return await detect_supported_image_mime_type_from_file(absolute_path)


@dataclass
class ReadToolOptions:
    auto_resize_images: bool = True
    operations: ReadOperations | None = None


READ_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": {
            "type": "string",
            "description": "Path to the file to read (relative or absolute)",
        },
        "offset": {
            "type": "number",
            "description": "Line number to start reading from (1-indexed)",
        },
        "limit": {"type": "number", "description": "Maximum number of lines to read"},
    },
    "required": ["path"],
}


async def _read_text_content(
    buffer: bytes,
    path: str,
    offset: int | None,
    limit: int | None,
) -> tuple[list[dict[str, Any]], ReadToolDetails | None]:
    text_content = buffer.decode("utf-8")
    all_lines = text_content.split("\n")
    total_file_lines = len(all_lines)
    start_line = max(0, (offset or 1) - 1)
    start_line_display = start_line + 1
    if start_line >= len(all_lines):
        raise ValueError(f"Offset {offset} is beyond end of file ({len(all_lines)} lines total)")

    details: ReadToolDetails | None = None
    if limit is not None:
        end_line = min(start_line + limit, len(all_lines))
        selected_content = "\n".join(all_lines[start_line:end_line])
        user_limited_lines = end_line - start_line
    else:
        selected_content = "\n".join(all_lines[start_line:])
        user_limited_lines = None

    truncation = truncateHead(selected_content)
    if truncation["firstLineExceedsLimit"]:
        first_line_size = formatSize(len(all_lines[start_line].encode("utf-8")))
        output_text = (
            f"[Line {start_line_display} is {first_line_size}, exceeds "
            f"{formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: "
            f"sed -n '{start_line_display}p' {path} | head -c {DEFAULT_MAX_BYTES}]"
        )
        details = ReadToolDetails(truncation=truncation)
    elif truncation["truncated"]:
        end_line_display = start_line_display + truncation["outputLines"] - 1
        next_offset = end_line_display + 1
        output_text = truncation["content"]
        if truncation["truncatedBy"] == "lines":
            output_text += (
                f"\n\n[Showing lines {start_line_display}-{end_line_display} of "
                f"{total_file_lines}. Use offset={next_offset} to continue.]"
            )
        else:
            output_text += (
                f"\n\n[Showing lines {start_line_display}-{end_line_display} of "
                f"{total_file_lines} ({formatSize(DEFAULT_MAX_BYTES)} limit). "
                f"Use offset={next_offset} to continue.]"
            )
        details = ReadToolDetails(truncation=truncation)
    elif user_limited_lines is not None and start_line + user_limited_lines < len(all_lines):
        remaining = len(all_lines) - (start_line + user_limited_lines)
        next_offset = start_line + user_limited_lines + 1
        output_text = (
            f"{truncation['content']}\n\n[{remaining} more lines in file. "
            f"Use offset={next_offset} to continue.]"
        )
    else:
        output_text = truncation["content"]

    return [{"type": "text", "text": output_text}], details


async def _read_image_content(
    buffer: bytes,
    mime_type: str,
    *,
    auto_resize_images: bool,
    model: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    non_vision_image_note = get_non_vision_image_note(model)
    if auto_resize_images:
        resized = resize_image(buffer, mime_type)
        if resized is None:
            text_note = (
                f"Read image file [{mime_type}]\n"
                "[Image omitted: could not be resized below the inline image size limit.]"
            )
            if non_vision_image_note:
                text_note += f"\n{non_vision_image_note}"
            return [{"type": "text", "text": text_note}]

        dimension_note = format_dimension_note(resized)
        text_note = f"Read image file [{resized.mime_type}]"
        if dimension_note:
            text_note += f"\n{dimension_note}"
        if non_vision_image_note:
            text_note += f"\n{non_vision_image_note}"
        return [
            {"type": "text", "text": text_note},
            {"type": "image", "data": resized.data, "mimeType": resized.mime_type},
        ]

    text_note = f"Read image file [{mime_type}]"
    if non_vision_image_note:
        text_note += f"\n{non_vision_image_note}"
    return [
        {"type": "text", "text": text_note},
        {
            "type": "image",
            "data": base64.b64encode(buffer).decode("ascii"),
            "mimeType": mime_type,
        },
    ]


async def execute_read(
    cwd: str,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
    *,
    options: ReadToolOptions | None = None,
    model: dict[str, Any] | None = None,
) -> AgentToolResult:
    opts = options or ReadToolOptions()
    ops = opts.operations or DefaultReadOperations()
    absolute_path = await resolve_read_path_async(path, cwd)
    await ops.access(absolute_path)

    detect_image_mime_type = getattr(ops, "detect_image_mime_type", None)
    mime_type = await detect_image_mime_type(absolute_path) if detect_image_mime_type else None

    if mime_type:
        buffer = await ops.read_file(absolute_path)
        content = await _read_image_content(
            buffer,
            mime_type,
            auto_resize_images=opts.auto_resize_images,
            model=model,
        )
        return {"content": content, "details": None}

    buffer = await ops.read_file(absolute_path)
    content, details = await _read_text_content(buffer, path, offset, limit)
    return {
        "content": content,
        "details": details.__dict__ if details else None,
    }


def create_read_tool(cwd: str, options: ReadToolOptions | None = None) -> AgentTool:
    opts = options or ReadToolOptions()

    class ReadTool:
        name = "read"
        label = "read"
        description = (
            f"Read the contents of a file. Supports text files and images "
            f"(jpg, png, gif, webp). Images are sent as attachments. For text files, "
            f"output is truncated to {DEFAULT_MAX_LINES} lines or "
            f"{DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first). Use offset/limit "
            f"for large files."
        )
        parameters = READ_PARAMETERS
        executionMode = None

        async def execute(
            self,
            tool_call_id: str,
            params: dict[str, Any],
            signal: Any = None,
            on_update: Any = None,
            ctx: Any = None,
        ) -> AgentToolResult:
            del tool_call_id, on_update
            if signal is not None and getattr(signal, "aborted", False):
                raise RuntimeError("Operation aborted")
            model = getattr(ctx, "model", None) if ctx is not None else None
            return await execute_read(
                cwd,
                params["path"],
                params.get("offset"),
                params.get("limit"),
                options=opts,
                model=model,
            )

    return ReadTool()  # type: ignore[return-value]
