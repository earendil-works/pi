import pytest
from unittest import mock
from pi_mono.ai.providers.anthropic import (
    to_claude_code_name,
    from_claude_code_name,
    is_oauth_token,
    map_stop_reason,
    convert_messages,
    convert_tools,
    stream_anthropic,
)


def test_tool_name_conversion():
    assert to_claude_code_name("read") == "Read"
    assert to_claude_code_name("write") == "Write"
    assert to_claude_code_name("unknown") == "unknown"

    tools = [{"name": "read_file", "description": "read", "parameters": {}}]
    assert from_claude_code_name("read_file", tools) == "read_file"
    assert from_claude_code_name("Read_File", tools) == "read_file"
    assert from_claude_code_name("unknown", tools) == "unknown"


def test_is_oauth_token():
    assert is_oauth_token("sk-ant-oat-12345") is True
    assert is_oauth_token("sk-ant-api-12345") is False


def test_map_stop_reason():
    assert map_stop_reason("end_turn") == "stop"
    assert map_stop_reason("max_tokens") == "length"
    assert map_stop_reason("tool_use") == "toolUse"
    assert map_stop_reason("sensitive") == "error"
    assert map_stop_reason("unknown") == "error"


def test_convert_messages():
    model = {"id": "claude-3-5-sonnet", "provider": "anthropic", "api": "anthropic-messages"}
    messages = [
        {"role": "user", "content": "hello"},
        {
            "role": "assistant",
            "provider": "anthropic",
            "model": "claude-3-5-sonnet",
            "api": "anthropic-messages",
            "content": [
                {"type": "thinking", "thinking": "Let's think", "thinkingSignature": "sig123"},
                {"type": "text", "text": "Hi there!"},
            ],
        },
    ]

    converted = convert_messages(
        messages, model, is_oauth=False, cache_control=None, allow_empty_signature=True
    )
    assert len(converted) == 2
    assert converted[0] == {"role": "user", "content": "hello"}
    assert converted[1]["role"] == "assistant"
    assert converted[1]["content"][0]["type"] == "thinking"
    assert converted[1]["content"][0]["thinking"] == "Let's think"
    assert converted[1]["content"][0]["signature"] == "sig123"
    assert converted[1]["content"][1] == {"type": "text", "text": "Hi there!"}


def test_convert_messages_with_tool_results():
    model = {"id": "claude-3-5-sonnet", "provider": "anthropic"}
    messages = [
        {
            "role": "toolResult",
            "toolCallId": "call_123",
            "toolName": "Read",
            "content": [{"type": "text", "text": "file content"}],
        },
        {
            "role": "toolResult",
            "toolCallId": "call_456",
            "toolName": "Write",
            "content": [{"type": "text", "text": "success"}],
        },
    ]

    converted = convert_messages(messages, model, is_oauth=False, cache_control=None)
    assert len(converted) == 1
    assert converted[0]["role"] == "user"
    assert len(converted[0]["content"]) == 2
    assert converted[0]["content"][0]["tool_use_id"] == "call_123"
    assert converted[0]["content"][0]["content"] == "file content"
    assert converted[0]["content"][1]["tool_use_id"] == "call_456"
    assert converted[0]["content"][1]["content"] == "success"


def test_convert_tools():
    tools = [
        {
            "name": "Read",
            "description": "Read a file",
            "parameters": {"properties": {"path": {"type": "string"}}, "required": ["path"]},
        }
    ]
    converted = convert_tools(tools, is_oauth=False, supports_eager=True)
    assert len(converted) == 1
    assert converted[0]["name"] == "Read"
    assert converted[0]["input_schema"]["properties"] == {"path": {"type": "string"}}
    assert converted[0]["eager_input_streaming"] is True


# Mock event structure returned by anthropic AsyncStream
class MockUsage:
    def __init__(self, input_tokens, output_tokens):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_read_input_tokens = 0
        self.cache_creation_input_tokens = 0


class MockMessage:
    def __init__(self, id, usage):
        self.id = id
        self.usage = usage


class MockEvent:
    def __init__(self, type, message=None, index=0, content_block=None, delta=None, usage=None):
        self.type = type
        self.message = message
        self.index = index
        self.content_block = content_block
        self.delta = delta
        self.usage = usage


class MockTextDelta:
    def __init__(self, text):
        self.type = "text_delta"
        self.text = text


class MockStream:
    def __init__(self, events):
        self.events = events

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.events:
            raise StopAsyncIteration
        return self.events.pop(0)


@pytest.mark.anyio
async def test_stream_anthropic():
    model = {
        "id": "claude-3-5-sonnet",
        "provider": "anthropic",
        "cost": {"input": 3.0, "output": 15.0, "cacheRead": 0.0, "cacheWrite": 0.0},
    }
    context = {"messages": [{"role": "user", "content": "hello"}]}
    options = {"apiKey": "sk-ant-api-12345"}

    usage = MockUsage(10, 5)
    msg = MockMessage("msg_123", usage)

    events = [
        MockEvent("message_start", message=msg),
        MockEvent("content_block_start", index=0, content_block=mock.Mock(type="text")),
        MockEvent("content_block_delta", index=0, delta=MockTextDelta("Hello")),
        MockEvent("content_block_stop", index=0),
        MockEvent("message_delta", usage=usage),
    ]

    mock_client = mock.MagicMock()
    mock_client.messages.create = mock.AsyncMock(return_value=MockStream(events))

    with mock.patch("pi_mono.ai.providers.anthropic.AsyncAnthropic", return_value=mock_client):
        stream = stream_anthropic(model, context, options)

        received_events = []
        async for ev in stream:
            received_events.append(ev)

        assert len(received_events) > 0
        assert received_events[0]["type"] == "start"
        assert received_events[-1]["type"] == "done"
        assert received_events[-1]["message"]["responseId"] == "msg_123"
        assert received_events[-1]["message"]["content"][0]["text"] == "Hello"
