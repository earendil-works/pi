"""Edit tool."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Protocol

from pi_mono.agent.types import AgentTool, AgentToolResult
from pi_mono.coding_agent.core.tools.edit_diff import (
    apply_edits_to_normalized_content,
    detect_line_ending,
    generate_diff_string,
    generate_unified_patch,
    normalize_to_lf,
    restore_line_endings,
    strip_bom,
)
from pi_mono.coding_agent.core.tools.file_mutation_queue import with_file_mutation_queue
from pi_mono.coding_agent.core.tools.path_utils import resolve_to_cwd


class EditOperations(Protocol):
    async def read_file(self, absolute_path: str) -> bytes: ...
    async def write_file(self, absolute_path: str, content: str) -> None: ...
    async def access(self, absolute_path: str) -> None: ...


class DefaultEditOperations:
    async def read_file(self, absolute_path: str) -> bytes:
        with open(absolute_path, "rb") as handle:
            return handle.read()

    async def write_file(self, absolute_path: str, content: str) -> None:
        with open(absolute_path, "w", encoding="utf-8") as handle:
            handle.write(content)

    async def access(self, absolute_path: str) -> None:
        if not os.access(absolute_path, os.R_OK | os.W_OK):
            raise PermissionError(f"Cannot access: {absolute_path}")


@dataclass
class EditToolOptions:
    operations: EditOperations | None = None


EDIT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "Path to the file to edit"},
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "oldText": {"type": "string"},
                    "newText": {"type": "string"},
                },
                "required": ["oldText", "newText"],
            },
        },
    },
    "required": ["path", "edits"],
}


def _prepare_edit_arguments(params: dict[str, Any]) -> dict[str, Any]:
    edits = params.get("edits")
    if isinstance(edits, str):
        import json

        try:
            parsed = json.loads(edits)
            if isinstance(parsed, list):
                params = {**params, "edits": parsed}
        except json.JSONDecodeError:
            pass
    if "oldText" in params and "newText" in params:
        legacy_edits = list(params.get("edits") or [])
        legacy_edits.append({"oldText": params["oldText"], "newText": params["newText"]})
        params = {k: v for k, v in params.items() if k not in ("oldText", "newText")}
        params["edits"] = legacy_edits
    return params


async def execute_edit(
    cwd: str,
    params: dict[str, Any],
    *,
    options: EditToolOptions | None = None,
    signal: Any = None,
) -> AgentToolResult:
    opts = options or EditToolOptions()
    ops = opts.operations or DefaultEditOperations()
    prepared = _prepare_edit_arguments(params)
    path = prepared["path"]
    edits = prepared.get("edits")
    if not isinstance(edits, list) or not edits:
        raise ValueError("Edit tool input is invalid. edits must contain at least one replacement.")
    absolute_path = resolve_to_cwd(path, cwd)

    async def run() -> AgentToolResult:
        if signal is not None and getattr(signal, "aborted", False):
            raise RuntimeError("Operation aborted")
        try:
            await ops.access(absolute_path)
        except OSError as error:
            raise RuntimeError(f"Could not edit file: {path}. {error}.") from error
        raw_content = (await ops.read_file(absolute_path)).decode("utf-8")
        ending = detect_line_ending(raw_content)
        normalized = normalize_to_lf(strip_bom(raw_content))
        applied = apply_edits_to_normalized_content(normalized, edits, path)  # type: ignore[arg-type]
        new_content = restore_line_endings(applied.new_content, ending)
        diff_result = generate_diff_string(normalized, applied.new_content)
        patch = generate_unified_patch(path, normalized, applied.new_content)
        await ops.write_file(absolute_path, new_content)
        return {
            "content": [{"type": "text", "text": f"Successfully edited {path}"}],
            "details": {"diff": diff_result.diff, "patch": patch},
        }

    return await with_file_mutation_queue(absolute_path, run)


def create_edit_tool(cwd: str, options: EditToolOptions | None = None) -> AgentTool:
    opts = options or EditToolOptions()

    class EditTool:
        name = "edit"
        label = "edit"
        description = "Edit a file using exact text replacement via edits[].oldText/newText."
        parameters = EDIT_PARAMETERS
        executionMode = None

        async def execute(
            self,
            tool_call_id: str,
            params: dict[str, Any],
            signal: Any = None,
            on_update: Any = None,
        ) -> AgentToolResult:
            return await execute_edit(cwd, params, options=opts, signal=signal)

    return EditTool()  # type: ignore[return-value]
