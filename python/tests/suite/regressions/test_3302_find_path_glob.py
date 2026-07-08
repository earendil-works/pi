"""Regression #3302: find tool path-based glob patterns."""

from __future__ import annotations

import pytest

from pi_mono.coding_agent.core.tools.find import execute_find
from pi_mono.coding_agent.utils.tools_manager import ensure_tool


def _parse_find_output(text: str) -> list[str]:
    if text == "No files found matching pattern":
        return []
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.strip().startswith("[")
    ]


@pytest.mark.anyio
async def test_basename_pattern_still_matches(tmp_path) -> None:
    await ensure_tool("fd", silent=True)
    (tmp_path / "some" / "parent" / "child").mkdir(parents=True)
    (tmp_path / "src" / "foo" / "bar").mkdir(parents=True)
    (tmp_path / "some" / "parent" / "child" / "file.ext").write_text("", encoding="utf-8")
    (tmp_path / "some" / "parent" / "child" / "test.spec.ts").write_text("", encoding="utf-8")
    (tmp_path / "src" / "foo" / "bar" / "example.spec.ts").write_text("", encoding="utf-8")

    result = await execute_find(str(tmp_path), "*.spec.ts")
    text = result["content"][0]["text"]
    assert sorted(_parse_find_output(text)) == [
        "some/parent/child/test.spec.ts",
        "src/foo/bar/example.spec.ts",
    ]


@pytest.mark.anyio
async def test_src_nested_spec_pattern(tmp_path) -> None:
    await ensure_tool("fd", silent=True)
    (tmp_path / "src" / "foo" / "bar").mkdir(parents=True)
    (tmp_path / "src" / "foo" / "bar" / "example.spec.ts").write_text("", encoding="utf-8")

    result = await execute_find(str(tmp_path), "src/**/*.spec.ts")
    text = result["content"][0]["text"]
    assert _parse_find_output(text) == ["src/foo/bar/example.spec.ts"]
