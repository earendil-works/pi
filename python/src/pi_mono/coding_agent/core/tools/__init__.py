"""Built-in coding agent tools."""

from __future__ import annotations

from typing import Literal

from pi_mono.agent.types import AgentTool
from pi_mono.coding_agent.core.tools.bash import BashToolOptions, create_bash_tool
from pi_mono.coding_agent.core.tools.edit import EditToolOptions, create_edit_tool
from pi_mono.coding_agent.core.tools.find import FindToolOptions, create_find_tool
from pi_mono.coding_agent.core.tools.grep import GrepToolOptions, create_grep_tool
from pi_mono.coding_agent.core.tools.ls import LsToolOptions, create_ls_tool
from pi_mono.coding_agent.core.tools.read import ReadToolOptions, create_read_tool
from pi_mono.coding_agent.core.tools.write import WriteToolOptions, create_write_tool

ToolName = Literal["read", "bash", "edit", "write", "grep", "find", "ls"]

ALL_TOOL_NAMES: set[ToolName] = {"read", "bash", "edit", "write", "grep", "find", "ls"}


class ToolsOptions:
    def __init__(
        self,
        *,
        read: ReadToolOptions | None = None,
        bash: BashToolOptions | None = None,
        write: WriteToolOptions | None = None,
        edit: EditToolOptions | None = None,
        grep: GrepToolOptions | None = None,
        find: FindToolOptions | None = None,
        ls: LsToolOptions | None = None,
    ) -> None:
        self.read = read
        self.bash = bash
        self.write = write
        self.edit = edit
        self.grep = grep
        self.find = find
        self.ls = ls


def create_tool(tool_name: ToolName, cwd: str, options: ToolsOptions | None = None) -> AgentTool:
    opts = options or ToolsOptions()
    factories = {
        "read": lambda: create_read_tool(cwd, opts.read),
        "bash": lambda: create_bash_tool(cwd, opts.bash),
        "edit": lambda: create_edit_tool(cwd, opts.edit),
        "write": lambda: create_write_tool(cwd, opts.write),
        "grep": lambda: create_grep_tool(cwd, opts.grep),
        "find": lambda: create_find_tool(cwd, opts.find),
        "ls": lambda: create_ls_tool(cwd, opts.ls),
    }
    factory = factories.get(tool_name)
    if factory is None:
        raise ValueError(f"Unknown tool name: {tool_name}")
    return factory()


def create_coding_tools(cwd: str, options: ToolsOptions | None = None) -> list[AgentTool]:
    return [create_tool(name, cwd, options) for name in ("read", "bash", "edit", "write")]


def create_read_only_tools(cwd: str, options: ToolsOptions | None = None) -> list[AgentTool]:
    return [create_tool(name, cwd, options) for name in ("read", "grep", "find", "ls")]


def create_all_tools(cwd: str, options: ToolsOptions | None = None) -> dict[ToolName, AgentTool]:
    return {name: create_tool(name, cwd, options) for name in ALL_TOOL_NAMES}


all_tool_names = ALL_TOOL_NAMES

__all__ = [
    "ToolName",
    "ToolsOptions",
    "ALL_TOOL_NAMES",
    "all_tool_names",
    "create_tool",
    "create_coding_tools",
    "create_read_only_tools",
    "create_all_tools",
    "create_read_tool",
    "create_write_tool",
    "create_bash_tool",
    "create_edit_tool",
    "create_grep_tool",
    "create_find_tool",
    "create_ls_tool",
]
