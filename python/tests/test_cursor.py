"""Tests for the Cursor provider and Cursor Agent CLI integration."""

from __future__ import annotations

from subprocess import CompletedProcess
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pi_mono.ai.cursor_agent import (
    discover_cursor_models,
    refresh_cursor_models_cache,
)
from pi_mono.ai.providers.cursor import stream_cursor
from pi_mono.ai.types import Context, Model


@pytest.fixture(autouse=True)
def clear_cursor_model_cache() -> None:
    refresh_cursor_models_cache()
    yield
    refresh_cursor_models_cache()


def test_discover_cursor_models_parses_agent_models_output() -> None:
    stdout = (
        "Available models:\n"
        "  auto - Auto (default)\n"
        "  composer-2.5-fast - Composer 2.5 Fast (current)\n"
        "  sonnet-4.6-thinking - Claude 4.6 Sonnet (Thinking)\n"
        "Tip: choose a model\n"
    )
    completed = CompletedProcess(
        args=["agent", "models"],
        returncode=0,
        stdout=stdout,
        stderr="",
    )

    with patch("subprocess.run", return_value=completed):
        models = discover_cursor_models(refresh=True)

    ids = [model["id"] for model in models]
    assert ids == ["auto", "composer-2.5-fast", "sonnet-4.6-thinking"]
    assert models[1]["name"] == "Composer 2.5 Fast"
    assert models[1]["provider"] == "cursor"
    assert models[1]["baseUrl"] == "cursor://agent"


def test_discover_cursor_models_refreshes_stale_fallback_after_login() -> None:
    from pi_mono.ai import cursor_agent

    completed_fail = CompletedProcess(args=["agent", "models"], returncode=1, stdout="", stderr="")
    completed_ok = CompletedProcess(
        args=["agent", "models"],
        returncode=0,
        stdout="  auto - Auto\n  composer-2.5-fast - Composer 2.5 Fast\n",
        stderr="",
    )

    with patch("pi_mono.ai.cursor_agent.is_cursor_agent_authenticated", return_value=False):
        with patch("subprocess.run", return_value=completed_fail):
            stale = discover_cursor_models(refresh=True)
    assert len(stale) == 20

    cursor_agent._DISCOVERED_MODELS_CACHE = stale
    cursor_agent._CACHE_FROM_CLI = False

    with patch("pi_mono.ai.cursor_agent.is_cursor_agent_authenticated", return_value=True):
        with patch("subprocess.run", return_value=completed_ok):
            refreshed = discover_cursor_models()
    assert [model["id"] for model in refreshed] == ["auto", "composer-2.5-fast"]


@pytest.mark.anyio
async def test_stream_cursor_launches_and_streams_agent_output() -> None:
    model: Model = {
        "id": "composer-2.5-fast",
        "name": "Composer 2.5 Fast",
        "api": "openai-completions",
        "provider": "cursor",
        "baseUrl": "cursor://agent",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 200000,
        "maxTokens": 32768,
    }
    context: Context = {
        "systemPrompt": "You are a helpful assistant",
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [],
    }
    options = {"apiKey": "mock-session-token"}

    assistant_line = (
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},'
        '"session_id":"123"}\n'
    ).encode("utf-8")

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.stdout = AsyncMock()
    mock_process.stdout.readline = AsyncMock(side_effect=[assistant_line, b""])
    mock_process.stderr = AsyncMock()
    mock_process.stderr.read = AsyncMock(return_value=b"")
    mock_process.wait = AsyncMock(return_value=0)
    mock_process.terminate = MagicMock()
    mock_process.kill = MagicMock()

    with patch("asyncio.create_subprocess_exec", return_value=mock_process) as mock_create_subproc:
        event_stream = stream_cursor(model, context, options)

        events = []
        async for event in event_stream:
            events.append(event)

    assert [event["type"] for event in events] == ["start", "text_start", "text_delta", "done"]
    assert events[2]["delta"] == "OK"

    mock_create_subproc.assert_called_once()
    args, kwargs = mock_create_subproc.call_args
    assert args[0] == "agent"
    assert "--print" in args
    assert "--output-format" in args
    assert "stream-json" in args
    assert "--model" in args
    assert "--trust" not in args
    assert "composer-2.5-fast" in args
    assert kwargs["env"]["CURSOR_API_KEY"] == "mock-session-token"
    mock_process.terminate.assert_not_called()
    mock_process.kill.assert_not_called()
