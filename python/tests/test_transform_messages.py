import re
import time
from typing import Any, List
from pi_mono.ai.providers.transform_messages import transform_messages
from pi_mono.ai.types import AssistantMessage, Message, Model


def anthropic_normalize_tool_call_id(id_val: str, _model: Model, _source: AssistantMessage) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", id_val)[:64]


def make_copilot_claude_model() -> Model:
    return {
        "id": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "api": "anthropic-messages",
        "provider": "github-copilot",
        "reasoning": True,
        "input": ["text", "image"],
        "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0},
        "contextWindow": 128000,
        "maxTokens": 16000,
    }


def make_assistant_message(content: List[Any]) -> AssistantMessage:
    return {
        "role": "assistant",
        "content": content,
        "api": "openai-responses",
        "provider": "github-copilot",
        "model": "gpt-5",
        "usage": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 0,
            "cost": {
                "input": 0.0,
                "output": 0.0,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
                "total": 0.0,
            },
        },
        "stopReason": "toolUse",
        "timestamp": int(time.time() * 1000),
    }


def test_converts_thinking_blocks_to_plain_text_when_source_model_differs():
    model = make_copilot_claude_model()
    messages: List[Message] = [
        {"role": "user", "content": "hello", "timestamp": int(time.time() * 1000)},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "Let me think about this...",
                    "thinkingSignature": "reasoning_content",
                },
                {"type": "text", "text": "Hi there!"},
            ],
            "api": "openai-completions",
            "provider": "github-copilot",
            "model": "gpt-4o",
            "usage": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 0,
                "cost": {
                    "input": 0.0,
                    "output": 0.0,
                    "cacheRead": 0.0,
                    "cacheWrite": 0.0,
                    "total": 0.0,
                },
            },
            "stopReason": "stop",
            "timestamp": int(time.time() * 1000),
        },
    ]

    result = transform_messages(messages, model, anthropic_normalize_tool_call_id)
    assistant_msg = next(m for m in result if m["role"] == "assistant")

    # Thinking block should be converted to text since models differ
    text_blocks = [b for b in assistant_msg["content"] if b["type"] == "text"]
    thinking_blocks = [b for b in assistant_msg["content"] if b["type"] == "thinking"]
    assert len(thinking_blocks) == 0
    assert len(text_blocks) >= 2
    assert text_blocks[0]["text"] == "Let me think about this..."
    assert text_blocks[1]["text"] == "Hi there!"


def test_removes_thought_signature_from_tool_calls_when_migrating_between_models():
    model = make_copilot_claude_model()
    messages: List[Message] = [
        {"role": "user", "content": "run a command", "timestamp": int(time.time() * 1000)},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "toolCall",
                    "id": "call_123",
                    "name": "bash",
                    "arguments": {"command": "ls"},
                    "thoughtSignature": "encrypted",
                }
            ],
            "api": "openai-responses",
            "provider": "github-copilot",
            "model": "gpt-5",
            "usage": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 0,
                "cost": {
                    "input": 0.0,
                    "output": 0.0,
                    "cacheRead": 0.0,
                    "cacheWrite": 0.0,
                    "total": 0.0,
                },
            },
            "stopReason": "toolUse",
            "timestamp": int(time.time() * 1000),
        },
        {
            "role": "toolResult",
            "toolCallId": "call_123",
            "toolName": "bash",
            "content": [{"type": "text", "text": "output"}],
            "isError": False,
            "timestamp": int(time.time() * 1000),
        },
    ]

    result = transform_messages(messages, model, anthropic_normalize_tool_call_id)
    assistant_msg = next(m for m in result if m["role"] == "assistant")
    tool_call = next(b for b in assistant_msg["content"] if b["type"] == "toolCall")

    assert "thoughtSignature" not in tool_call


def test_adds_synthetic_tool_results_for_trailing_orphaned_tool_calls():
    model = make_copilot_claude_model()
    messages: List[Message] = [
        {"role": "user", "content": "read the file", "timestamp": int(time.time() * 1000)},
        make_assistant_message(
            [
                {
                    "type": "toolCall",
                    "id": "call_123|fc_123",
                    "name": "read",
                    "arguments": {"path": "README.md"},
                }
            ]
        ),
    ]

    result = transform_messages(messages, model, anthropic_normalize_tool_call_id)
    last_message = result[-1]

    assert last_message["role"] == "toolResult"
    assert last_message["toolCallId"] == "call_123_fc_123"
    assert last_message["toolName"] == "read"
    assert last_message["isError"] is True
    assert last_message["content"] == [{"type": "text", "text": "No result provided"}]


def test_adds_synthetic_results_only_for_trailing_tool_calls_that_are_still_missing_results():
    model = make_copilot_claude_model()
    messages: List[Message] = [
        {"role": "user", "content": "run commands", "timestamp": int(time.time() * 1000)},
        make_assistant_message(
            [
                {
                    "type": "toolCall",
                    "id": "call_1|fc_1",
                    "name": "read",
                    "arguments": {"path": "README.md"},
                },
                {
                    "type": "toolCall",
                    "id": "call_2|fc_2",
                    "name": "bash",
                    "arguments": {"command": "pwd"},
                },
            ]
        ),
        {
            "role": "toolResult",
            "toolCallId": "call_1|fc_1",
            "toolName": "read",
            "content": [{"type": "text", "text": "done"}],
            "isError": False,
            "timestamp": int(time.time() * 1000),
        },
    ]

    result = transform_messages(messages, model, anthropic_normalize_tool_call_id)
    synthetic_results = [
        m for m in result if m["role"] == "toolResult" and m.get("isError") is True
    ]

    assert len(synthetic_results) == 1
    assert synthetic_results[0]["toolCallId"] == "call_2_fc_2"
    assert synthetic_results[0]["toolName"] == "bash"
    assert synthetic_results[0]["content"] == [{"type": "text", "text": "No result provided"}]


def test_downgrade_unsupported_images():
    # Model without images support
    non_vision_model = make_copilot_claude_model().copy()
    non_vision_model["input"] = ["text"]

    messages: List[Message] = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Take a look:"},
                {"type": "image", "data": "base64...", "mimeType": "image/png"},
                {"type": "image", "data": "base64...", "mimeType": "image/png"},  # duplicate
                {"type": "text", "text": "And this other one:"},
                {"type": "image", "data": "base64...", "mimeType": "image/png"},
            ],
            "timestamp": int(time.time() * 1000),
        }
    ]

    result = transform_messages(messages, non_vision_model, anthropic_normalize_tool_call_id)
    user_msg = result[0]
    content = user_msg["content"]

    assert len(content) == 4
    assert content[0] == {"type": "text", "text": "Take a look:"}
    # two consecutive images collapsed into one placeholder
    assert content[1] == {
        "type": "text",
        "text": "(image omitted: model does not support images)",
    }
    assert content[2] == {"type": "text", "text": "And this other one:"}
    assert content[3] == {
        "type": "text",
        "text": "(image omitted: model does not support images)",
    }
