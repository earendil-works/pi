"""Issue #5109: exclude-tools filters built-in and extension tools."""

from __future__ import annotations

import pytest

from tests.suite.regressions.tool_filter_helpers import make_tool_session, write_tool_extension


def _tool_names(tools: list[dict[str, str]]) -> list[str]:
    return sorted(tool["name"] for tool in tools)


@pytest.mark.anyio
async def test_filters_builtin_and_extension_tools_from_available_and_active_tools(
    tmp_path,
) -> None:
    ext_dir = write_tool_extension(tmp_path)
    session = await make_tool_session(
        tmp_path,
        extension_paths=[ext_dir],
        excluded_tool_names=["read", "ask_question"],
    )

    all_tool_names = _tool_names(session.get_all_tools())
    assert "read" not in all_tool_names
    assert "ask_question" not in all_tool_names
    assert "bash" in all_tool_names
    assert "dynamic_tool" in all_tool_names
    assert sorted(session.get_active_tool_names()) == ["bash", "dynamic_tool", "edit", "write"]
    assert "- read:" not in session.system_prompt
    assert "ask_question" not in session.system_prompt
    assert "- dynamic_tool: Run dynamic test behavior" in session.system_prompt


@pytest.mark.anyio
async def test_excluded_tools_override_allowlist(tmp_path) -> None:
    ext_dir = write_tool_extension(tmp_path)
    session = await make_tool_session(
        tmp_path,
        extension_paths=[ext_dir],
        allowed_tool_names=["read", "bash", "ask_question"],
        excluded_tool_names=["read", "ask_question"],
        initial_active_tool_names=["read", "bash", "ask_question"],
    )

    assert _tool_names(session.get_all_tools()) == ["bash"]
    assert session.get_active_tool_names() == ["bash"]
    assert "- bash:" in session.system_prompt
    assert "- read:" not in session.system_prompt
    assert "ask_question" not in session.system_prompt
