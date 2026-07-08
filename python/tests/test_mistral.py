import pytest
from unittest.mock import MagicMock, patch
from pi_mono.ai.providers.mistral import stream_mistral, stream_simple_mistral
from pi_mono.ai.types import Context, Model


class MockDelta:
    def __init__(self, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls


class MockChoice:
    def __init__(self, delta, finish_reason=None):
        self.delta = delta
        self.finish_reason = finish_reason


class MockUsage:
    def __init__(self, prompt_tokens, completion_tokens, total_tokens):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = total_tokens


class MockChunk:
    def __init__(self, id, choices, usage=None):
        self.id = id
        self.choices = choices
        self.usage = usage


class MockEvent:
    def __init__(self, data):
        self.data = data


class MockFunction:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class MockToolCall:
    def __init__(self, id, function, index=0):
        self.id = id
        self.function = function
        self.index = index


@pytest.mark.anyio
async def test_stream_mistral_text():
    model: Model = {
        "id": "mistral-large-latest",
        "provider": "mistral",
        "api": "mistral-conversations",
        "input": ["text"],
        "cost": {"input": 2.0, "output": 6.0, "cacheRead": 0.0, "cacheWrite": 0.0},
    }

    context: Context = {
        "messages": [{"role": "user", "content": "Hello"}],
    }

    events = [
        MockEvent(MockChunk("msg-1", [MockChoice(MockDelta("Hello"))])),
        MockEvent(MockChunk("msg-1", [MockChoice(MockDelta(" world"))])),
        MockEvent(MockChunk("msg-1", [MockChoice(MockDelta(None), "stop")], MockUsage(10, 5, 15))),
    ]

    async def mock_stream_async(*args, **kwargs):
        class MockAsyncIterable:
            async def __aiter__(self):
                for ev in events:
                    yield ev

        return MockAsyncIterable()

    mock_client = MagicMock()
    mock_client.chat.stream_async = mock_stream_async

    with patch("pi_mono.ai.providers.mistral.Mistral", return_value=mock_client):
        stream = stream_mistral(model, context, {"apiKey": "mock-key"})
        results = []
        async for event in stream:
            results.append(event)

        assert len(results) >= 5
        assert results[0]["type"] == "start"
        assert results[-1]["type"] == "done"

        message = results[-1]["message"]
        assert message["responseId"] == "msg-1"
        assert message["content"][0]["text"] == "Hello world"
        assert message["usage"]["input"] == 10
        assert message["usage"]["output"] == 5
        assert message["usage"]["totalTokens"] == 15
        assert message["usage"]["cost"]["total"] == pytest.approx(
            (2.0 * 10 / 1e6) + (6.0 * 5 / 1e6)
        )


@pytest.mark.anyio
async def test_stream_mistral_tool_calls():
    model: Model = {
        "id": "mistral-large-latest",
        "provider": "mistral",
        "api": "mistral-conversations",
        "input": ["text"],
        "cost": {"input": 2.0, "output": 6.0, "cacheRead": 0.0, "cacheWrite": 0.0},
    }

    context: Context = {
        "messages": [{"role": "user", "content": "Search for weather"}],
        "tools": [{"name": "weather", "description": "Get weather", "parameters": {}}],
    }

    events = [
        MockEvent(
            MockChunk(
                id="msg-tool",
                choices=[
                    MockChoice(
                        delta=MockDelta(
                            tool_calls=[
                                MockToolCall(
                                    id="call-1",
                                    function=MockFunction(
                                        name="weather", arguments={"location": "SF"}
                                    ),
                                )
                            ]
                        )
                    )
                ],
            )
        ),
        MockEvent(
            MockChunk(
                id="msg-tool",
                choices=[MockChoice(delta=MockDelta(content=None), finish_reason="tool_calls")],
                usage=MockUsage(prompt_tokens=12, completion_tokens=8, total_tokens=20),
            )
        ),
    ]

    async def mock_stream_async(*args, **kwargs):
        class MockAsyncIterable:
            async def __aiter__(self):
                for ev in events:
                    yield ev

        return MockAsyncIterable()

    mock_client = MagicMock()
    mock_client.chat.stream_async = mock_stream_async

    with patch("pi_mono.ai.providers.mistral.Mistral", return_value=mock_client):
        stream = stream_mistral(model, context, {"apiKey": "mock-key"})
        results = []
        async for event in stream:
            results.append(event)

        message = results[-1]["message"]
        assert message["stopReason"] == "toolUse"
        assert len(message["content"]) == 1
        assert message["content"][0]["type"] == "toolCall"
        assert message["content"][0]["name"] == "weather"
        assert message["content"][0]["arguments"] == {"location": "SF"}


@pytest.mark.anyio
async def test_stream_simple_mistral_reasoning():
    model: Model = {
        "id": "mistral-small-latest",
        "provider": "mistral",
        "api": "mistral-conversations",
        "reasoning": True,
        "input": ["text"],
        "cost": {"input": 2.0, "output": 6.0, "cacheRead": 0.0, "cacheWrite": 0.0},
        "thinkingLevelMap": {"high": "high", "low": "low"},
    }

    context: Context = {"messages": []}

    payload_captured = None

    async def mock_stream_async(*args, **kwargs):
        nonlocal payload_captured
        payload_captured = kwargs

        class MockAsyncIterable:
            async def __aiter__(self):
                yield MockEvent(MockChunk("msg-r", [MockChoice(MockDelta("thinking result"))]))

        return MockAsyncIterable()

    mock_client = MagicMock()
    mock_client.chat.stream_async = mock_stream_async

    with patch("pi_mono.ai.providers.mistral.Mistral", return_value=mock_client):
        stream = stream_simple_mistral(model, context, {"apiKey": "mock-key", "reasoning": "high"})
        async for _ in stream:
            pass

        assert payload_captured is not None
        assert payload_captured["reasoning_effort"] == "high"
