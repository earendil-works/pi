"""Issue #2835: tool allowlists filter extension tools."""

from __future__ import annotations

import pytest

from tests.suite.regressions.tool_filter_helpers import (
    make_tool_session,
    write_dynamic_tool_extension,
)


@pytest.mark.anyio
async def test_allows_only_explicitly_listed_builtin_and_extension_tools(tmp_path) -> None:
    ext_dir = write_dynamic_tool_extension(tmp_path)
    session = await make_tool_session(
        tmp_path,
        extension_paths=[ext_dir],
        allowed_tool_names=["read", "dynamic_tool"],
    )

    assert sorted(tool["name"] for tool in session.get_all_tools()) == ["dynamic_tool", "read"]
    assert sorted(session.get_active_tool_names()) == ["dynamic_tool", "read"]
    assert "- read: Read file contents" in session.system_prompt
    assert "- dynamic_tool: Run dynamic test behavior" in session.system_prompt
    assert "- bash:" not in session.system_prompt
    assert "- edit:" not in session.system_prompt


@pytest.mark.anyio
async def test_disables_all_tools_when_allowlist_is_empty(tmp_path) -> None:
    ext_dir = write_dynamic_tool_extension(tmp_path)
    session = await make_tool_session(
        tmp_path,
        extension_paths=[ext_dir],
        allowed_tool_names=[],
    )

    assert session.get_all_tools() == []
    assert session.get_active_tool_names() == []
    assert "Available tools:\n(none)" in session.system_prompt
    assert "dynamic_tool" not in session.system_prompt
