from pi_mono.ai.providers.amazon_bedrock import (
    normalize_tool_call_id,
    create_non_blank_text_block,
    create_required_text_block,
    convert_tool_result_content,
    map_thinking_level_to_effort,
    convert_messages,
    build_system_prompt,
    convert_tool_config,
    build_additional_model_request_fields,
    get_configured_bedrock_region,
    get_standard_bedrock_endpoint_region,
    should_use_explicit_bedrock_endpoint,
)


def test_normalize_tool_call_id():
    model = {"id": "us.anthropic.claude-3-5-sonnet-20241022-v2:0"}
    assistant_msg = {"role": "assistant", "content": []}

    # Standard ID
    assert normalize_tool_call_id("call-12345", model, assistant_msg) == "call-12345"

    # ID with special characters
    assert normalize_tool_call_id("call:123/45", model, assistant_msg) == "call_123_45"

    # Excessively long ID
    long_id = "a" * 100
    assert len(normalize_tool_call_id(long_id, model, assistant_msg)) == 64


def test_create_non_blank_text_block():
    assert create_non_blank_text_block("  ") is None
    assert create_non_blank_text_block("hello") == {"text": "hello"}


def test_create_required_text_block():
    assert create_required_text_block("  ") == {"text": "<empty>"}
    assert create_required_text_block("hello") == {"text": "hello"}


def test_convert_tool_result_content():
    # Text block
    content = [{"type": "text", "text": "result content"}]
    res = convert_tool_result_content(content)
    assert len(res) == 1
    assert res[0] == {"text": "result content"}

    # Image block
    content = [{"type": "image", "mimeType": "image/png", "data": "YmFzZTY0ZGF0YQ=="}]
    res = convert_tool_result_content(content)
    assert len(res) == 1
    assert "image" in res[0]
    assert res[0]["image"]["format"] == "png"
    assert res[0]["image"]["source"]["bytes"] == b"base64data"

    # Empty content
    assert convert_tool_result_content([]) == [{"text": "<empty>"}]


def test_map_thinking_level_to_effort():
    model = {
        "id": "claude-3-5",
        "thinkingLevelMap": {
            "low": "low_effort",
            "high": "high_effort",
        },
    }
    assert map_thinking_level_to_effort(model, "low") == "low_effort"
    assert map_thinking_level_to_effort(model, "high") == "high_effort"

    # Default fallbacks
    model_no_map = {"id": "claude-3-5"}
    assert map_thinking_level_to_effort(model_no_map, "minimal") == "low"
    assert map_thinking_level_to_effort(model_no_map, "medium") == "medium"
    assert map_thinking_level_to_effort(model_no_map, "xhigh") == "high"


def test_convert_messages():
    model = {"id": "anthropic.claude-v2", "provider": "amazon-bedrock"}

    # Convert simple user message
    context = {
        "messages": [
            {"role": "user", "content": "Hello Bedrock"},
        ]
    }
    msgs = convert_messages(context, model, "none")
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == [{"text": "Hello Bedrock"}]

    # Convert tool usage and response
    context = {
        "messages": [
            {"role": "user", "content": "Run tool"},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "tool-1",
                        "name": "calculator",
                        "arguments": {"x": 1},
                    }
                ],
            },
            {
                "role": "toolResult",
                "toolCallId": "tool-1",
                "toolName": "calculator",
                "content": [{"type": "text", "text": "result is 2"}],
            },
        ]
    }
    msgs = convert_messages(context, model, "none")
    assert len(msgs) == 3
    assert msgs[0]["role"] == "user"
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"][0]["toolUse"]["toolUseId"] == "tool-1"
    assert msgs[2]["role"] == "user"
    assert msgs[2]["content"][0]["toolResult"]["toolUseId"] == "tool-1"


def test_build_system_prompt():
    model = {"id": "anthropic.claude-v3", "provider": "amazon-bedrock"}

    # No system prompt
    assert build_system_prompt(None, model, "none") is None

    # Simple system prompt
    prompt = build_system_prompt("System rules", model, "none")
    assert prompt == [{"text": "System rules"}]

    # System prompt with cache retention (not supported by this model ID)
    prompt = build_system_prompt("System rules", model, "short")
    assert prompt == [{"text": "System rules"}]


def test_convert_tool_config():
    tools = [
        {
            "name": "get_weather",
            "description": "Weather check",
            "parameters": {"type": "object", "properties": {"loc": {"type": "string"}}},
        }
    ]

    # Auto tool choice
    config = convert_tool_config(tools, "auto")
    assert config is not None
    assert len(config["tools"]) == 1
    assert config["tools"][0]["toolSpec"]["name"] == "get_weather"
    assert "auto" in config["toolChoice"]

    # Any tool choice
    config = convert_tool_config(tools, "any")
    assert "any" in config["toolChoice"]


def test_build_additional_model_request_fields():
    model = {"id": "anthropic.claude-3-opus", "provider": "amazon-bedrock", "reasoning": True}

    # Empty options
    assert build_additional_model_request_fields(model, {}) is None

    # Interleaved thinking option
    options = {"reasoning": "low", "interleavedThinking": True}
    fields = build_additional_model_request_fields(model, options)
    assert fields is not None
    assert "thinking" in fields
    assert fields.get("anthropic_beta") == ["interleaved-thinking-2025-05-14"]


def test_endpoint_and_region_resolution(monkeypatch):
    # region from options
    assert get_configured_bedrock_region({"region": "us-west-2"}) == "us-west-2"

    # region from env
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    assert get_configured_bedrock_region({}) == "eu-west-1"

    # endpoint region
    assert (
        get_standard_bedrock_endpoint_region("https://bedrock-runtime.us-east-1.amazonaws.com")
        == "us-east-1"
    )
    assert get_standard_bedrock_endpoint_region("https://custom.endpoint.com") is None

    # should use explicit endpoint
    assert (
        should_use_explicit_bedrock_endpoint("https://custom.endpoint.com", "us-east-1", False)
        is True
    )
    assert should_use_explicit_bedrock_endpoint("", "us-east-1", False) is False
