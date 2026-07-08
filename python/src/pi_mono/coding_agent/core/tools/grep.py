"""Grep tool."""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from typing import Any, Protocol

from pi_mono.agent.types import AgentTool, AgentToolResult
from pi_mono.coding_agent.core.tools.path_utils import resolve_to_cwd
from pi_mono.coding_agent.core.tools.truncate import (
    GREP_MAX_LINE_LENGTH,
    truncateHead,
    truncateLine,
)
from pi_mono.coding_agent.utils.tools_manager import get_tool_path

DEFAULT_LIMIT = 100


class GrepOperations(Protocol):
    def is_directory(self, absolute_path: str) -> bool: ...
    def read_file(self, absolute_path: str) -> str: ...


class DefaultGrepOperations:
    def is_directory(self, absolute_path: str) -> bool:
        return os.path.isdir(absolute_path)

    def read_file(self, absolute_path: str) -> str:
        with open(absolute_path, encoding="utf-8") as handle:
            return handle.read()


@dataclass
class GrepToolOptions:
    operations: GrepOperations | None = None


GREP_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "pattern": {"type": "string", "description": "Search pattern"},
        "path": {"type": "string", "description": "Directory or file to search"},
        "glob": {"type": "string", "description": "Filter files by glob pattern"},
        "ignoreCase": {"type": "boolean", "description": "Case-insensitive search"},
        "literal": {"type": "boolean", "description": "Treat pattern as literal string"},
        "context": {"type": "number", "description": "Context lines before/after match"},
        "limit": {"type": "number", "description": "Maximum number of matches"},
    },
    "required": ["pattern"],
}


def _python_grep(
    pattern: str,
    search_path: str,
    *,
    ignore_case: bool,
    literal: bool,
    limit: int,
) -> list[str]:
    flags = 0 if literal else re.MULTILINE
    if ignore_case:
        flags |= re.IGNORECASE
    regex = re.compile(re.escape(pattern) if literal else pattern, flags)
    output_lines: list[str] = []
    paths = [search_path]
    if os.path.isdir(search_path):
        paths = []
        for root, _dirs, files in os.walk(search_path):
            if ".git" in root.split(os.sep):
                continue
            for name in files:
                paths.append(os.path.join(root, name))
    for file_path in paths:
        if not os.path.isfile(file_path):
            continue
        try:
            with open(file_path, encoding="utf-8", errors="replace") as handle:
                for line_no, line in enumerate(handle, start=1):
                    if regex.search(line):
                        rel = os.path.relpath(
                            file_path,
                            (
                                search_path
                                if os.path.isdir(search_path)
                                else os.path.dirname(search_path)
                            ),
                        )
                        output_lines.append(f"{rel}:{line_no}:{line.rstrip()}")
                        if len(output_lines) >= limit:
                            return output_lines
        except OSError:
            continue
    return output_lines


async def execute_grep(
    cwd: str,
    pattern: str,
    path: str | None = None,
    *,
    glob: str | None = None,
    ignore_case: bool = False,
    literal: bool = False,
    limit: int | None = None,
    options: GrepToolOptions | None = None,
) -> AgentToolResult:
    search_path = resolve_to_cwd(path or ".", cwd)
    if not os.path.exists(search_path):
        raise FileNotFoundError(f"Path not found: {search_path}")
    effective_limit = max(1, limit or DEFAULT_LIMIT)
    rg_path = get_tool_path("rg")
    output_lines: list[str] = []
    if rg_path:
        args = ["--line-number", "--color=never", "--hidden"]
        if ignore_case:
            args.append("--ignore-case")
        if literal:
            args.append("--fixed-strings")
        if glob:
            args.extend(["--glob", glob])
        args.extend(["--", pattern, search_path])
        completed = subprocess.run(
            [rg_path, *args],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode not in (0, 1):
            raise RuntimeError(completed.stderr.strip() or "ripgrep failed")
        output_lines = completed.stdout.splitlines()[:effective_limit]
    else:
        output_lines = _python_grep(
            pattern,
            search_path,
            ignore_case=ignore_case,
            literal=literal,
            limit=effective_limit,
        )

    truncated_lines = [truncateLine(line, GREP_MAX_LINE_LENGTH)["text"] for line in output_lines]
    raw_output = "\n".join(truncated_lines) if truncated_lines else "No matches found"
    truncation = truncateHead(raw_output, {"maxLines": effective_limit})
    details: dict[str, Any] = {}
    if len(output_lines) >= effective_limit:
        details["matchLimitReached"] = effective_limit
    if truncation["truncated"]:
        details["truncation"] = truncation
    return {
        "content": [{"type": "text", "text": truncation["content"]}],
        "details": details or None,
    }


def create_grep_tool(cwd: str, options: GrepToolOptions | None = None) -> AgentTool:
    opts = options or GrepToolOptions()

    class GrepTool:
        name = "grep"
        label = "grep"
        description = "Search file contents for a pattern."
        parameters = GREP_PARAMETERS
        executionMode = None

        async def execute(
            self,
            tool_call_id: str,
            params: dict[str, Any],
            signal: Any = None,
            on_update: Any = None,
        ) -> AgentToolResult:
            return await execute_grep(
                cwd,
                params["pattern"],
                params.get("path"),
                glob=params.get("glob"),
                ignore_case=bool(params.get("ignoreCase")),
                literal=bool(params.get("literal")),
                limit=params.get("limit"),
                options=opts,
            )

    return GrepTool()  # type: ignore[return-value]
