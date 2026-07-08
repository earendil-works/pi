import json
import pytest
from typing import Any, AsyncIterator
from unittest import mock

import httpx
from pi_mono.ai.types import AssistantMessage, Model
from pi_mono.agent.proxy import (
    ensure_content_index,
    process_proxy_event,
    stream_proxy,
    build_proxy_request_options,
)


def create_assistant_message() -> AssistantMessage:
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
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
        "stopReason": "stop",
        "timestamp": 1234,
    }


def test_ensure_content_index() -> None:
    lst = [1, 2]
    ensure_content_index(lst, 1)
    assert lst == [1, 2]

    ensure_content_index(lst, 4, default_val=None)
    assert lst == [1, 2, None, None, None]


def test_process_proxy_event_text() -> None:
    partial = create_assistant_message()

    # start event
    ev = process_proxy_event({"type": "start"}, partial)
    assert ev == {"type": "start", "partial": partial}

    # text_start event
    ev = process_proxy_event({"type": "text_start", "contentIndex": 0}, partial)
    assert ev == {"type": "text_start", "contentIndex": 0, "partial": partial}
    assert partial["content"] == [{"type": "text", "text": ""}]

    # text_delta event
    ev = process_proxy_event({"type": "text_delta", "contentIndex": 0, "delta": "hello"}, partial)
    assert ev == {
        "type": "text_delta",
        "contentIndex": 0,
        "delta": "hello",
        "partial": partial,
    }
    assert partial["content"][0]["text"] == "hello"  # type: ignore

    # text_end event
    ev = process_proxy_event(
        {"type": "text_end", "contentIndex": 0, "contentSignature": "sig1"}, partial
    )
    assert ev == {
        "type": "text_end",
        "contentIndex": 0,
        "content": "hello",
        "partial": partial,
    }
    assert partial["content"][0]["textSignature"] == "sig1"  # type: ignore


def test_process_proxy_event_thinking() -> None:
    partial = create_assistant_message()

    # thinking_start
    ev = process_proxy_event({"type": "thinking_start", "contentIndex": 0}, partial)
    assert ev == {"type": "thinking_start", "contentIndex": 0, "partial": partial}
    assert partial["content"] == [{"type": "thinking", "thinking": ""}]

    # thinking_delta
    ev = process_proxy_event(
        {"type": "thinking_delta", "contentIndex": 0, "delta": "thinking..."}, partial
    )
    assert ev == {
        "type": "thinking_delta",
        "contentIndex": 0,
        "delta": "thinking...",
        "partial": partial,
    }
    assert partial["content"][0]["thinking"] == "thinking..."  # type: ignore

    # thinking_end
    ev = process_proxy_event(
        {"type": "thinking_end", "contentIndex": 0, "contentSignature": "sig2"}, partial
    )
    assert ev == {
        "type": "thinking_end",
        "contentIndex": 0,
        "content": "thinking...",
        "partial": partial,
    }
    assert partial["content"][0]["thinkingSignature"] == "sig2"  # type: ignore


def test_process_proxy_event_tool_calls() -> None:
    partial = create_assistant_message()

    # toolcall_start
    ev = process_proxy_event(
        {"type": "toolcall_start", "contentIndex": 0, "id": "call1", "toolName": "read"},
        partial,
    )
    assert ev == {"type": "toolcall_start", "contentIndex": 0, "partial": partial}
    assert partial["content"][0] == {
        "type": "toolCall",
        "id": "call1",
        "name": "read",
        "arguments": {},
        "partialJson": "",
    }

    # toolcall_delta (sends valid JSON chunk)
    ev = process_proxy_event(
        {"type": "toolcall_delta", "contentIndex": 0, "delta": '{"path": "foo.txt"}'}, partial
    )
    assert ev == {
        "type": "toolcall_delta",
        "contentIndex": 0,
        "delta": '{"path": "foo.txt"}',
        "partial": partial,
    }
    assert partial["content"][0]["arguments"] == {"path": "foo.txt"}  # type: ignore

    # toolcall_end
    ev = process_proxy_event({"type": "toolcall_end", "contentIndex": 0}, partial)
    assert ev["type"] == "toolcall_end"  # type: ignore
    assert "partialJson" not in partial["content"][0]  # type: ignore


def test_process_proxy_event_done_error() -> None:
    partial = create_assistant_message()
    usage = {
        "input": 10,
        "output": 20,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 30,
        "cost": {"input": 0.1, "output": 0.2, "cacheRead": 0, "cacheWrite": 0, "total": 0.3},
    }

    # done
    ev = process_proxy_event({"type": "done", "reason": "stop", "usage": usage}, partial)
    assert ev == {"type": "done", "reason": "stop", "message": partial}
    assert partial["stopReason"] == "stop"
    assert partial["usage"] == usage

    # error
    ev = process_proxy_event(
        {"type": "error", "reason": "error", "errorMessage": "fail", "usage": usage}, partial
    )
    assert ev == {"type": "error", "reason": "error", "error": partial}
    assert partial["stopReason"] == "error"
    assert partial["errorMessage"] == "fail"


def test_build_proxy_request_options() -> None:
    opts = {
        "temperature": 0.7,
        "maxTokens": 100,
        "reasoning": "low",
        "unknown": "discarded",
    }
    res = build_proxy_request_options(opts)  # type: ignore
    assert res == {
        "temperature": 0.7,
        "maxTokens": 100,
        "reasoning": "low",
    }


class MockAsyncByteStream:
    def __init__(self, lines: list[str]) -> None:
        self.lines = lines

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for line in self.lines:
            yield line.encode("utf-8")


@pytest.mark.anyio
async def test_stream_proxy_mocked_http() -> None:
    model: Model = {"id": "gpt-mock", "provider": "openai", "api": "openai-responses"}
    context: Any = {"systemPrompt": "", "messages": []}
    options: Any = {
        "authToken": "test-token",
        "proxyUrl": "http://proxy.invalid",
    }

    sse_lines = [
        "data: " + json.dumps({"type": "start"}) + "\n",
        "data: " + json.dumps({"type": "text_start", "contentIndex": 0}) + "\n",
        "data: " + json.dumps({"type": "text_delta", "contentIndex": 0, "delta": "hello"}) + "\n",
        "data: "
        + json.dumps(
            {"type": "done", "reason": "stop", "usage": create_assistant_message()["usage"]}
        )
        + "\n",
    ]

    mock_response = mock.MagicMock(spec=httpx.Response)
    mock_response.status_code = 200

    async def aiter_lines() -> AsyncIterator[str]:
        for line in sse_lines:
            yield line.strip()

    mock_response.aiter_lines = aiter_lines

    class MockAsyncClientContext:
        async def __aenter__(self) -> "MockAsyncClientContext":
            return self

        async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
            pass

        def stream(self, *args: Any, **kwargs: Any) -> Any:
            class MockStreamContext:
                async def __aenter__(self) -> Any:
                    return mock_response

                async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
                    pass

            return MockStreamContext()

        async def aclose(self) -> None:
            pass

    with mock.patch("httpx.AsyncClient", return_value=MockAsyncClientContext()):
        stream = stream_proxy(model, context, options)
        events = []
        async for event in stream:
            events.append(event)

        assert len(events) == 4
        assert events[0]["type"] == "start"
        assert events[1]["type"] == "text_start"
        assert events[2]["type"] == "text_delta"
        assert events[3]["type"] == "done"

        res = await stream.result()
        assert res["stopReason"] == "stop"
        assert res["content"] == [{"type": "text", "text": "hello"}]
