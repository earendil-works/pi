import json
from pi_mono.ai.providers.openai_responses import (
    clamp_openai_prompt_cache_key,
    resolve_cache_retention,
    get_compat,
    get_prompt_cache_retention,
    format_openai_responses_error,
    encode_text_signature_v1,
    parse_text_signature,
    convert_responses_messages,
)


def test_clamp_openai_prompt_cache_key():
    assert clamp_openai_prompt_cache_key(None) is None
    assert clamp_openai_prompt_cache_key("abc") == "abc"
    long_key = "a" * 100
    assert len(clamp_openai_prompt_cache_key(long_key)) == 64


def test_resolve_cache_retention(monkeypatch):
    assert resolve_cache_retention("long") == "long"
    assert resolve_cache_retention(None) == "short"

    monkeypatch.setenv("PI_CACHE_RETENTION", "long")
    assert resolve_cache_retention(None) == "long"


def test_get_compat():
    model_empty = {}
    compat = get_compat(model_empty)
    assert compat["sendSessionIdHeader"] is True
    assert compat["supportsLongCacheRetention"] is True

    model_custom = {"compat": {"sendSessionIdHeader": False, "supportsLongCacheRetention": False}}
    compat_custom = get_compat(model_custom)
    assert compat_custom["sendSessionIdHeader"] is False
    assert compat_custom["supportsLongCacheRetention"] is False


def test_get_prompt_cache_retention():
    compat = {"sendSessionIdHeader": True, "supportsLongCacheRetention": True}
    assert get_prompt_cache_retention(compat, "long") == "24h"
    assert get_prompt_cache_retention(compat, "short") is None

    compat_no_long = {"sendSessionIdHeader": True, "supportsLongCacheRetention": False}
    assert get_prompt_cache_retention(compat_no_long, "long") is None


def test_format_openai_responses_error():
    # Exception with status_code
    class CustomError(Exception):
        status_code = 403

    assert "OpenAI API error (403)" in format_openai_responses_error(CustomError("Forbidden"))

    # Exception with status
    class StatusError(Exception):
        status = 500

    assert "OpenAI API error (500)" in format_openai_responses_error(StatusError("Internal error"))

    # Normal Exception
    assert format_openai_responses_error(ValueError("Simple error")) == "Simple error"


def test_text_signatures():
    # encode_text_signature_v1
    sig1 = encode_text_signature_v1("id123")
    parsed1 = json.loads(sig1)
    assert parsed1["v"] == 1
    assert parsed1["id"] == "id123"
    assert "phase" not in parsed1

    sig2 = encode_text_signature_v1("id123", "commentary")
    parsed2 = json.loads(sig2)
    assert parsed2["phase"] == "commentary"

    # parse_text_signature
    assert parse_text_signature(None) is None
    assert parse_text_signature("simple-id") == {"id": "simple-id"}

    encoded_json = encode_text_signature_v1("my-id", "final_answer")
    assert parse_text_signature(encoded_json) == {"id": "my-id", "phase": "final_answer"}


def test_convert_responses_messages():
    model = {"id": "gpt-4o", "provider": "openai", "api": "openai-responses", "reasoning": True}
    context = {
        "systemPrompt": "Keep it concise.",
        "messages": [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": [{"type": "text", "text": "Hi there!"}]},
        ],
    }

    msgs = convert_responses_messages(model, context, {"openai"})
    assert len(msgs) == 3
    assert msgs[0]["role"] == "developer"
    assert msgs[0]["content"] == "Keep it concise."
    assert msgs[1]["role"] == "user"
    assert msgs[1]["content"] == [{"type": "input_text", "text": "Hello"}]
    assert msgs[2]["role"] == "assistant"
