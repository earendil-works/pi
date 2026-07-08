from pathlib import Path

import pytest

from pi_mono.coding_agent.core.tools.bash import execute_bash
from pi_mono.coding_agent.core.tools.edit import execute_edit
from pi_mono.coding_agent.core.tools.ls import execute_ls
from pi_mono.coding_agent.core.tools.read import execute_read
from pi_mono.coding_agent.core.tools.write import execute_write


@pytest.mark.anyio
async def test_read_write_edit_tools(tmp_path: Path):
    cwd = str(tmp_path)
    file_path = "sample.txt"
    await execute_write(cwd, file_path, "hello world\nsecond line")
    read_result = await execute_read(cwd, file_path)
    assert "hello world" in read_result["content"][0]["text"]

    edit_result = await execute_edit(
        cwd,
        {
            "path": file_path,
            "edits": [{"oldText": "hello world", "newText": "hello pi"}],
        },
    )
    assert "Successfully edited" in edit_result["content"][0]["text"]

    updated = await execute_read(cwd, file_path)
    assert "hello pi" in updated["content"][0]["text"]


@pytest.mark.anyio
async def test_ls_tool(tmp_path: Path):
    (tmp_path / "alpha.txt").write_text("a", encoding="utf-8")
    (tmp_path / "beta.txt").write_text("b", encoding="utf-8")
    result = await execute_ls(str(tmp_path))
    output = result["content"][0]["text"]
    assert "alpha.txt" in output
    assert "beta.txt" in output


@pytest.mark.anyio
async def test_bash_tool_echo(tmp_path: Path):
    result = await execute_bash(str(tmp_path), "echo hello-from-bash")
    assert "hello-from-bash" in result["content"][0]["text"]
