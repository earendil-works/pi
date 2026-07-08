from google.genai.types import FinishReason, FunctionCallingConfigMode

from pi_mono.ai.providers.google_shared import (
    is_thinking_part,
    retain_thought_signature,
    requires_tool_call_id,
    get_gemini_major_version,
    supports_multimodal_function_response,
    convert_messages,
    convert_tools,
    map_tool_choice,
    map_stop_reason,
    map_stop_reason_string,
)
from pi_mono.ai.providers.google_vertex import (
    resolve_api_key,
    resolve_project,
    resolve_location,
)


def test_is_thinking_part():
    assert is_thinking_part({"thought": True}) is True
    assert is_thinking_part({"thought": False}) is False
    assert is_thinking_part({}) is False


def test_retain_thought_signature():
    assert retain_thought_signature("existing", "incoming") == "incoming"
    assert retain_thought_signature("existing", None) == "existing"
    assert retain_thought_signature("existing", "") == "existing"


def test_requires_tool_call_id():
    assert requires_tool_call_id("claude-3") is True
    assert requires_tool_call_id("gpt-oss-model") is True
    assert requires_tool_call_id("gemini-1.5-pro") is False


def test_get_gemini_major_version():
    assert get_gemini_major_version("gemini-2.5-pro") == 2
    assert get_gemini_major_version("gemini-3-pro") == 3
    assert get_gemini_major_version("gemini-3.5-flash") == 3
    assert get_gemini_major_version("unknown") is None


def test_supports_multimodal_function_response():
    assert supports_multimodal_function_response("gemini-2.5-pro") is False
    assert supports_multimodal_function_response("gemini-3-pro") is True
    assert supports_multimodal_function_response("gemini-3.5-flash") is True


def test_convert_messages():
    model = {
        "id": "gemini-2.5-pro",
        "provider": "google",
        "baseUrl": "https://generativelanguage.googleapis.com",
        "input": ["text"],
    }
    context = {
        "systemPrompt": "System instruction",
        "messages": [
            {"role": "user", "content": "Hello"},
            {
                "role": "assistant",
                "provider": "google",
                "model": "gemini-2.5-pro",
                "content": [{"type": "text", "text": "Hi back!"}],
            },
        ],
    }

    converted = convert_messages(model, context)
    assert len(converted) == 2
    assert converted[0].role == "user"
    assert converted[0].parts[0].text == "Hello"
    assert converted[1].role == "model"
    assert converted[1].parts[0].text == "Hi back!"


def test_convert_tools():
    tools = [
        {
            "name": "search",
            "description": "web search",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
        }
    ]
    converted = convert_tools(tools)
    assert len(converted) == 1
    assert "function_declarations" in converted[0]
    assert converted[0]["function_declarations"][0]["name"] == "search"


def test_map_tool_choice():
    assert map_tool_choice("auto") == FunctionCallingConfigMode.AUTO
    assert map_tool_choice("none") == FunctionCallingConfigMode.NONE
    assert map_tool_choice("any") == FunctionCallingConfigMode.ANY
    assert map_tool_choice("unknown") == FunctionCallingConfigMode.AUTO


def test_map_stop_reason():
    assert map_stop_reason(FinishReason.STOP) == "stop"
    assert map_stop_reason(FinishReason.MAX_TOKENS) == "length"
    assert map_stop_reason(FinishReason.SAFETY) == "error"


def test_map_stop_reason_string():
    assert map_stop_reason_string("STOP") == "stop"
    assert map_stop_reason_string("MAX_TOKENS") == "length"
    assert map_stop_reason_string("UNKNOWN") == "error"


def test_vertex_resolve_api_key():
    assert resolve_api_key(None) is None
    assert resolve_api_key({"apiKey": "gcp-vertex-credentials"}) is None
    assert resolve_api_key({"apiKey": "<placeholder>"}) is None
    assert resolve_api_key({"apiKey": "real-api-key"}) == "real-api-key"


def test_vertex_resolve_project(monkeypatch):
    assert resolve_project({"project": "my-project"}) == "my-project"

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "env-project")
    assert resolve_project(None) == "env-project"


def test_vertex_resolve_location(monkeypatch):
    assert resolve_location({"location": "us-central1"}) == "us-central1"

    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "env-location")
    assert resolve_location(None) == "env-location"
