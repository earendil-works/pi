"""Issue #5208: ignore bash output callbacks after operations resolve."""

from __future__ import annotations

import asyncio

import pytest

from pi_mono.coding_agent.core.tools.bash import BashToolOptions, create_bash_tool


def _text_output(result: dict) -> str:
    return "\n".join(
        block.get("text", "") for block in result.get("content", []) if block.get("type") == "text"
    )


class _LateOutputOperations:
    async def exec(self, _command, _cwd, *, on_data, signal=None, timeout=None, env=None):
        on_data(b"before\n")
        loop = asyncio.get_running_loop()
        loop.call_soon(lambda: on_data(b"late\n"))
        return {"exitCode": 0}


@pytest.mark.anyio
async def test_ignores_output_callbacks_after_bash_operations_resolve() -> None:
    bash = create_bash_tool(
        ".",
        BashToolOptions(operations=_LateOutputOperations()),
    )
    result = await bash.execute("test-call-late-output", {"command": "late-output"})
    await asyncio.sleep(0.02)
    assert _text_output(result).strip() == "before"
