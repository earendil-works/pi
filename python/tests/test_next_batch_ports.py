"""Tests for v0.80 next-batch ports: retry, cache-stats, truncated tools, empty tool text."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from pi_mono.agent.agent_loop import agent_loop
from pi_mono.agent.types import AgentContext, AgentEvent, AgentLoopConfig, AgentMessage
from pi_mono.ai.types import AssistantMessage, Message, Model, UserMessage
from pi_mono.ai.utils.event_stream import EventStream
from pi_mono.ai.utils.retry import is_retryable_assistant_error
from pi_mono.ai.providers.openai_completions import convert_messages, detect_compat
from pi_mono.ai.providers.openai_responses_shared import convert_responses_messages
from pi_mono.coding_agent.core.cache_stats import (
    collect_cache_misses,
    compute_cache_waste,
    detect_cache_miss,
)
from pi_mono.utils.abort_signals import AbortSignal


def _zero_cost() -> dict[str, float]:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}


def _assistant_error(error_message: str) -> AssistantMessage:
    return {
        "role": "assistant",
        "content": [],
        "api": "openai-responses",
        "provider": "openai",
        "model": "mock",
        "usage": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 0,
            "cost": _zero_cost(),
        },
        "stopReason": "error",
        "errorMessage": error_message,
        "timestamp": int(time.time() * 1000),
    }


def test_retry_classifies_524_and_resource_exhausted() -> None:
    assert is_retryable_assistant_error(
        _assistant_error("524 status code (no body)")
    )
    assert is_retryable_assistant_error(
        _assistant_error(
            "ResourceExhausted: Worker local total request limit reached (288/48)"
        )
    )
    assert is_retryable_assistant_error(
        _assistant_error(
            "The socket connection was closed unexpectedly. For more information, "
            "pass `verbose: true` in the second argument to fetch()"
        )
    )
    assert not is_retryable_assistant_error(
        _assistant_error("429 quota exceeded")
    )
    assert not is_retryable_assistant_error(
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "api": "openai-responses",
            "provider": "openai",
            "model": "mock",
            "usage": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 0,
                "cost": _zero_cost(),
            },
            "stopReason": "stop",
            "timestamp": 0,
        }
    )


def _cache_assistant(
    *,
    input_tokens: int = 0,
    cache_read: int = 0,
    cache_write: int = 0,
    cost: dict[str, float] | None = None,
    model: str = "test-model",
    timestamp: int = 0,
) -> AssistantMessage:
    return {
        "role": "assistant",
        "content": [],
        "api": "anthropic-messages",
        "provider": "test",
        "model": model,
        "usage": {
            "input": input_tokens,
            "output": 10,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
            "totalTokens": 0,
            "cost": {**_zero_cost(), **(cost or {})},
        },
        "stopReason": "stop",
        "timestamp": timestamp,
    }


class _PriceSource:
    def find(self, provider: str, model_id: str) -> dict[str, Any] | None:
        return {"cost": {"cacheRead": 0.3}}


def _entry(message: AssistantMessage) -> dict[str, Any]:
    return {"type": "message", "id": "x", "parentId": None, "timestamp": "", "message": message}


def test_compute_cache_waste_counts_misses() -> None:
    turn1 = _cache_assistant(cache_write=100_000, cost={"cacheWrite": 0.375}, timestamp=0)
    turn2 = _cache_assistant(
        cache_read=100_000,
        cache_write=5_000,
        cost={"cacheRead": 0.03, "cacheWrite": 0.019},
        timestamp=60_000,
    )
    turn3 = _cache_assistant(cache_write=110_000, cost={"cacheWrite": 0.4125}, timestamp=120_000)
    totals = compute_cache_waste([_entry(turn1), _entry(turn2), _entry(turn3)], _PriceSource())
    assert totals["missedTokens"] == 105_000
    assert totals["missedCost"] == pytest.approx(0.36225, abs=1e-5)


def test_detect_cache_miss_on_new_message() -> None:
    turn1 = _cache_assistant(cache_write=100_000, cost={"cacheWrite": 0.375}, timestamp=0)
    turn2 = _cache_assistant(
        cache_read=100_000,
        cache_write=5_000,
        cost={"cacheRead": 0.03, "cacheWrite": 0.019},
        timestamp=60_000,
    )
    miss_turn = _cache_assistant(cache_write=110_000, cost={"cacheWrite": 0.4125}, timestamp=120_000)
    miss = detect_cache_miss([_entry(turn1), _entry(turn2)], miss_turn, _PriceSource())
    assert miss is not None
    assert miss["missedTokens"] == 105_000
    misses = collect_cache_misses(
        [_entry(turn1), _entry(turn2), _entry(miss_turn)], _PriceSource()
    )
    assert id(miss_turn) in misses


def test_openai_completions_empty_tool_result_text() -> None:
    model: Model = {
        "id": "gpt",
        "name": "gpt",
        "api": "openai-completions",
        "provider": "openai",
        "baseUrl": "https://example.invalid",
        "reasoning": False,
        "input": ["text", "image"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 8192,
        "maxTokens": 2048,
    }
    compat = detect_compat(model)
    empty = convert_messages(
        model,
        {
            "systemPrompt": "",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {}}
                    ],
                    "api": "openai-completions",
                    "provider": "openai",
                    "model": "gpt",
                    "usage": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 0,
                        "cost": _zero_cost(),
                    },
                    "stopReason": "toolUse",
                    "timestamp": 0,
                },
                {
                    "role": "toolResult",
                    "toolCallId": "c1",
                    "toolName": "bash",
                    "content": [],
                    "isError": False,
                    "timestamp": 0,
                },
            ],
            "tools": [],
        },
        compat,
    )
    tool_msgs = [m for m in empty if m.get("role") == "tool"]
    assert tool_msgs
    assert tool_msgs[0]["content"] == "(no tool output)"

    image_only = convert_messages(
        model,
        {
            "systemPrompt": "",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "c2", "name": "bash", "arguments": {}}
                    ],
                    "api": "openai-completions",
                    "provider": "openai",
                    "model": "gpt",
                    "usage": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 0,
                        "cost": _zero_cost(),
                    },
                    "stopReason": "toolUse",
                    "timestamp": 0,
                },
                {
                    "role": "toolResult",
                    "toolCallId": "c2",
                    "toolName": "bash",
                    "content": [
                        {
                            "type": "image",
                            "data": "abc",
                            "mimeType": "image/png",
                        }
                    ],
                    "isError": False,
                    "timestamp": 0,
                },
            ],
            "tools": [],
        },
        compat,
    )
    tool_msgs = [m for m in image_only if m.get("role") == "tool"]
    assert tool_msgs
    assert tool_msgs[0]["content"] == "(see attached image)"


def test_openai_responses_empty_tool_result_text() -> None:
    model: Model = {
        "id": "gpt",
        "name": "gpt",
        "api": "openai-responses",
        "provider": "openai",
        "baseUrl": "https://example.invalid",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 8192,
        "maxTokens": 2048,
    }
    messages = convert_responses_messages(
        model,
        {
            "systemPrompt": "",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "c1|fc_1",
                            "name": "bash",
                            "arguments": {},
                        }
                    ],
                    "api": "openai-responses",
                    "provider": "openai",
                    "model": "gpt",
                    "usage": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 0,
                        "cost": _zero_cost(),
                    },
                    "stopReason": "toolUse",
                    "timestamp": 0,
                },
                {
                    "role": "toolResult",
                    "toolCallId": "c1|fc_1",
                    "toolName": "bash",
                    "content": [],
                    "isError": False,
                    "timestamp": 0,
                },
            ],
            "tools": [],
        },
        {"openai"},
    )
    outputs = [m for m in messages if m.get("type") == "function_call_output"]
    assert outputs
    assert outputs[0]["output"] == "(no tool output)"


class MockAssistantStream(EventStream):
    def __init__(self) -> None:
        super().__init__(
            is_complete=lambda event: event["type"] in ("done", "error"),
            extract_result=self._extract_result,
        )

    def _extract_result(self, event: Any) -> AssistantMessage:
        if event["type"] == "done":
            return event["message"]
        if event["type"] == "error":
            return event["error"]
        raise ValueError("Unexpected event type")


def _create_model() -> Model:
    return {
        "id": "mock",
        "name": "mock",
        "api": "openai-responses",
        "provider": "openai",
        "baseUrl": "https://example.invalid",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 8192,
        "maxTokens": 2048,
    }


def _create_assistant_message(content: list[Any], stop_reason: str = "stop") -> AssistantMessage:
    return {
        "role": "assistant",
        "content": content,
        "api": "openai-responses",
        "provider": "openai",
        "model": "mock",
        "usage": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 0,
            "cost": _zero_cost(),
        },
        "stopReason": stop_reason,  # type: ignore[typeddict-item]
        "timestamp": int(time.time() * 1000),
    }


def _create_user_message(text: str) -> UserMessage:
    return {"role": "user", "content": text, "timestamp": int(time.time() * 1000)}


def _identity_converter(messages: list[AgentMessage]) -> list[Message]:
    return [m for m in messages if m.get("role") in ("user", "assistant", "toolResult")]  # type: ignore[return-value]


class _EchoTool:
    name = "echo"
    label = "Echo"
    description = "Echo"
    parameters = {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}

    def __init__(self) -> None:
        self.executed: list[str] = []

    async def execute(
        self,
        tool_call_id: str,
        params: Any,
        signal: AbortSignal | None = None,
        on_update: Any = None,
    ) -> Any:
        value = params.get("value", "") if isinstance(params, dict) else ""
        self.executed.append(str(value))
        return {"content": [{"type": "text", "text": f"echoed: {value}"}], "details": {}}


@pytest.mark.anyio
async def test_length_truncated_tool_calls_are_not_executed() -> None:
    tool = _EchoTool()
    context: AgentContext = {"systemPrompt": "", "messages": [], "tools": [tool]}  # type: ignore[list-item]
    config: AgentLoopConfig = {
        "model": _create_model(),
        "convertToLlm": _identity_converter,
    }
    call_index = 0

    async def stream_fn(*_args: Any, **_kwargs: Any) -> Any:
        nonlocal call_index
        stream = MockAssistantStream()
        index = call_index
        call_index += 1

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            if index == 0:
                stream.push(
                    {
                        "type": "done",
                        "reason": "length",
                        "message": _create_assistant_message(
                            [
                                {
                                    "type": "toolCall",
                                    "id": "tool-1",
                                    "name": "echo",
                                    "arguments": {"value": "hel"},
                                }
                            ],
                            "length",
                        ),
                    }
                )
            else:
                stream.push(
                    {
                        "type": "done",
                        "reason": "stop",
                        "message": _create_assistant_message(
                            [{"type": "text", "text": "done"}]
                        ),
                    }
                )

        asyncio.create_task(run_stream())
        return stream

    events: list[AgentEvent] = []
    stream = agent_loop(
        [_create_user_message("echo something")],
        context,
        config,
        None,
        stream_fn,
    )
    async for event in stream:
        events.append(event)

    assert tool.executed == []
    tool_end = next(e for e in events if e.get("type") == "tool_execution_end")
    assert tool_end.get("isError") is True
    text = ""
    for block in (tool_end.get("result") or {}).get("content") or []:
        if block.get("type") == "text":
            text = str(block.get("text", ""))
    assert "output token limit" in text
    assert call_index == 2
