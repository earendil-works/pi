from pi_mono.ai.providers.openai_completions import (
    has_tool_history,
    resolve_cache_retention,
    clamp_openai_prompt_cache_key,
    convert_messages,
    convert_tools,
    map_stop_reason,
    detect_compat,
    get_compat,
    build_params,
    prepare_openai_chat_completion_params,
)


def test_has_tool_history():
    # Empty messages
    assert has_tool_history([]) is False

    # Messages without tool use
    messages = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
    ]
    assert has_tool_history(messages) is False

    # Messages with toolResult
    messages = [
        {"role": "user", "content": "hello"},
        {
            "role": "toolResult",
            "toolCallId": "call_1",
            "toolName": "my_tool",
            "content": [{"type": "text", "text": "result"}],
        },
    ]
    assert has_tool_history(messages) is True

    # Assistant messages containing toolCall
    messages = [
        {
            "role": "assistant",
            "content": [{"type": "toolCall", "id": "call_1", "name": "my_tool"}],
        }
    ]
    assert has_tool_history(messages) is True


def test_resolve_cache_retention(monkeypatch):
    assert resolve_cache_retention(None) == "short"
    assert resolve_cache_retention("long") == "long"

    monkeypatch.setenv("PI_CACHE_RETENTION", "long")
    assert resolve_cache_retention(None) == "long"


def test_clamp_openai_prompt_cache_key():
    assert clamp_openai_prompt_cache_key(None) is None
    assert clamp_openai_prompt_cache_key("a" * 10) == "a" * 10
    assert clamp_openai_prompt_cache_key("a" * 100) == "a" * 64


def test_map_stop_reason():
    assert map_stop_reason(None) == {"stopReason": "stop"}
    assert map_stop_reason("stop") == {"stopReason": "stop"}
    assert map_stop_reason("end") == {"stopReason": "stop"}
    assert map_stop_reason("length") == {"stopReason": "length"}
    assert map_stop_reason("tool_calls") == {"stopReason": "toolUse"}
    assert map_stop_reason("content_filter") == {
        "stopReason": "error",
        "errorMessage": "Provider finish_reason: content_filter",
    }
    assert map_stop_reason("unknown_reason") == {
        "stopReason": "error",
        "errorMessage": "Provider finish_reason: unknown_reason",
    }


def test_detect_compat():
    model_openai = {
        "id": "gpt-4o",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
    }
    compat_openai = detect_compat(model_openai)
    assert compat_openai["supportsStore"] is True
    assert compat_openai["supportsDeveloperRole"] is True
    assert compat_openai["maxTokensField"] == "max_completion_tokens"
    assert compat_openai["thinkingFormat"] == "openai"

    model_deepseek = {
        "id": "deepseek-chat",
        "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com",
    }
    compat_deepseek = detect_compat(model_deepseek)
    assert compat_deepseek["requiresReasoningContentOnAssistantMessages"] is True
    assert compat_deepseek["thinkingFormat"] == "deepseek"


def test_get_compat():
    model = {
        "id": "gpt-4o",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "compat": {"supportsStore": False},
    }
    compat = get_compat(model)
    assert compat["supportsStore"] is False
    assert compat["supportsDeveloperRole"] is True


def test_convert_messages():
    model = {
        "id": "gpt-4o",
        "provider": "openai",
        "api": "openai-completions",
        "baseUrl": "https://api.openai.com/v1",
        "reasoning": True,
    }
    context = {
        "systemPrompt": "System directive",
        "messages": [
            {"role": "user", "content": "User question"},
            {
                "role": "assistant",
                "provider": "openai",
                "api": "openai-completions",
                "model": "gpt-4o",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": "Let's plan",
                        "thinkingSignature": "reasoning",
                    },
                    {"type": "text", "text": "Answer goes here"},
                ],
            },
        ],
    }
    compat = get_compat(model)
    compat["supportsDeveloperRole"] = True

    converted = convert_messages(model, context, compat)
    assert len(converted) == 3
    assert converted[0] == {"role": "developer", "content": "System directive"}
    assert converted[1] == {"role": "user", "content": "User question"}
    assert converted[2]["role"] == "assistant"
    # Verify thinking block is processed according to thinkingFormat
    assert converted[2]["reasoning"] == "Let's plan"
    assert converted[2]["content"] == "Answer goes here"


def test_convert_tools():
    tools = [
        {
            "name": "get_weather",
            "description": "Get the weather",
            "parameters": {"type": "object", "properties": {"location": {"type": "string"}}},
        }
    ]
    compat = {"supportsStrictMode": True}
    converted = convert_tools(tools, compat)
    assert len(converted) == 1
    assert converted[0]["type"] == "function"
    assert converted[0]["function"]["name"] == "get_weather"
    assert converted[0]["function"]["strict"] is False


def test_build_params():
    model = {
        "id": "gpt-4o",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "reasoning": True,
    }
    context = {
        "systemPrompt": "System directive",
        "messages": [{"role": "user", "content": "hello"}],
    }
    compat = get_compat(model)
    params = build_params(model, context, {"maxTokens": 100}, compat)
    assert params["model"] == "gpt-4o"
    assert params["stream"] is True
    assert params["max_completion_tokens"] == 100
    assert len(params["messages"]) == 2


def test_prepare_openai_chat_completion_params_moves_openrouter_reasoning():
    model = {
        "id": "openai/gpt-oss-20b:free",
        "provider": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "reasoning": True,
    }
    context = {
        "systemPrompt": "System directive",
        "messages": [{"role": "user", "content": "hello"}],
    }
    compat = get_compat(model)
    params = build_params(
        model,
        context,
        {"maxTokens": 100, "reasoningEffort": "minimal"},
        compat,
    )
    assert params["reasoning"] == {"effort": "minimal"}

    sdk_params = prepare_openai_chat_completion_params(params)
    assert "reasoning" not in sdk_params
    assert sdk_params["extra_body"]["reasoning"] == {"effort": "minimal"}
    assert sdk_params["model"] == "openai/gpt-oss-20b:free"
