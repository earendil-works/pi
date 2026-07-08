"""TUI OSC/DSR terminal color query tests."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from pi_mono.tui.terminal_colors import RgbColor
from pi_mono.tui.tui import TUI


@pytest.mark.anyio
async def test_query_terminal_background_color_parses_osc11_response() -> None:
    terminal = MagicMock()
    terminal.columns = 80
    terminal.rows = 24
    terminal.kittyProtocolActive = False
    ui = TUI(terminal)

    async def run_query() -> RgbColor | None:
        return await ui.query_terminal_background_color(timeout_ms=200)

    task = asyncio.create_task(run_query())
    await asyncio.sleep(0)
    assert terminal.write.call_args_list[-1][0][0] == "\x1b]11;?\x07"

    ui.handle_input("\x1b]11;#ffffff\x07")
    result = await task
    assert result == RgbColor(r=255, g=255, b=255)


@pytest.mark.anyio
async def test_query_terminal_color_scheme_parses_dsr_response() -> None:
    terminal = MagicMock()
    terminal.columns = 80
    terminal.rows = 24
    terminal.kittyProtocolActive = False
    ui = TUI(terminal)

    async def run_query() -> str | None:
        return await ui.query_terminal_color_scheme(timeout_ms=200)

    task = asyncio.create_task(run_query())
    await asyncio.sleep(0)
    assert terminal.write.call_args_list[-1][0][0] == "\x1b[?996n"

    ui.handle_input("\x1b[?997;2n")
    result = await task
    assert result == "light"
