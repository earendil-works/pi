"""Regression #3303: nested .gitignore rules must not leak across siblings."""

from __future__ import annotations

import pytest

from pi_mono.coding_agent.core.tools.find import execute_find
from pi_mono.coding_agent.utils.tools_manager import ensure_tool


def _parse_find_output(text: str) -> list[str]:
    if text == "No files found matching pattern":
        return []
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return sorted(line for line in lines if not line.startswith("["))


@pytest.mark.anyio
async def test_flat_sibling_gitignore_scope(tmp_path) -> None:
    await ensure_tool("fd", silent=True)
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    (tmp_path / "a" / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    (tmp_path / "a" / "ignored.txt").write_text("", encoding="utf-8")
    (tmp_path / "a" / "kept.txt").write_text("", encoding="utf-8")
    (tmp_path / "b" / "ignored.txt").write_text("", encoding="utf-8")
    (tmp_path / "b" / "kept.txt").write_text("", encoding="utf-8")
    (tmp_path / "root.txt").write_text("", encoding="utf-8")

    result = await execute_find(str(tmp_path), "**/*.txt")
    text = result["content"][0]["text"]
    assert _parse_find_output(text) == ["a/kept.txt", "b/ignored.txt", "b/kept.txt", "root.txt"]


@pytest.mark.anyio
async def test_deep_nested_gitignore_scope(tmp_path) -> None:
    await ensure_tool("fd", silent=True)
    (tmp_path / "a" / "deep").mkdir(parents=True)
    (tmp_path / "b").mkdir()
    (tmp_path / "a" / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    (tmp_path / "a" / "deep" / ".gitignore").write_text("secret.txt\n", encoding="utf-8")
    (tmp_path / "a" / "ignored.txt").write_text("", encoding="utf-8")
    (tmp_path / "a" / "kept.txt").write_text("", encoding="utf-8")
    (tmp_path / "a" / "deep" / "ignored.txt").write_text("", encoding="utf-8")
    (tmp_path / "a" / "deep" / "secret.txt").write_text("", encoding="utf-8")
    (tmp_path / "a" / "deep" / "kept.txt").write_text("", encoding="utf-8")
    (tmp_path / "b" / "ignored.txt").write_text("", encoding="utf-8")
    (tmp_path / "b" / "kept.txt").write_text("", encoding="utf-8")
    (tmp_path / "root.txt").write_text("", encoding="utf-8")

    result = await execute_find(str(tmp_path), "**/*.txt")
    text = result["content"][0]["text"]
    assert _parse_find_output(text) == [
        "a/deep/kept.txt",
        "a/kept.txt",
        "b/ignored.txt",
        "b/kept.txt",
        "root.txt",
    ]
