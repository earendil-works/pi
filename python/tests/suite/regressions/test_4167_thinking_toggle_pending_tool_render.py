"""Issue #4167: thinking toggle must preserve pending tool render state."""

from __future__ import annotations

from unittest.mock import MagicMock

from pi_mono.coding_agent.modes.interactive.components.tool_execution import ToolExecutionComponent
from pi_mono.coding_agent.modes.interactive.interactive_mode import InteractiveMode
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme


TOOL_CALL_ID = "tool-4167"
TOOL_NAME = "slow_tool"


def _assistant_tool_call_message() -> dict[str, object]:
    return {
        "role": "assistant",
        "content": [
            {
                "type": "toolCall",
                "id": TOOL_CALL_ID,
                "name": TOOL_NAME,
                "arguments": {"delayMs": 10_000},
            }
        ],
        "stopReason": "toolUse",
    }


def _tool_result_message(text: str) -> dict[str, object]:
    return {
        "role": "toolResult",
        "toolCallId": TOOL_CALL_ID,
        "toolName": TOOL_NAME,
        "content": [{"type": "text", "text": text}],
        "isError": False,
    }


def _build_mode() -> InteractiveMode:
    mode = InteractiveMode.__new__(InteractiveMode)
    mode._pending_tools = {}
    mode._chat_container = MagicMock()
    mode._chat_container.add_child = MagicMock()
    mode._expandable_components = []
    mode._tool_output_expanded = False
    mode._hide_thinking_block = False
    mode._output_pad = 1
    mode._session = MagicMock()
    mode._session.retry_attempt = 0
    mode._session.settings_manager.get_show_images.return_value = False
    mode._session.session_manager.get_cwd.return_value = "."
    mode._ui = MagicMock()
    mode._create_tool_component = InteractiveMode._create_tool_component.__get__(
        mode, InteractiveMode
    )
    return mode


def test_keeps_unresolved_tool_calls_registered_for_live_completion() -> None:
    init_theme("dark")
    mode = _build_mode()
    mode._render_session_context({"messages": [_assistant_tool_call_message()]})
    assert TOOL_CALL_ID in mode._pending_tools
    component = mode._pending_tools[TOOL_CALL_ID]
    assert isinstance(component, ToolExecutionComponent)


def test_does_not_keep_completed_historical_tool_calls_pending() -> None:
    init_theme("dark")
    mode = _build_mode()
    mode._render_session_context(
        {"messages": [_assistant_tool_call_message(), _tool_result_message("HISTORICAL_RESULT")]}
    )
    assert mode._pending_tools == {}
