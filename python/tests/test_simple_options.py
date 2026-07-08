from pi_mono.ai.providers.simple_options import (
    build_base_options,
    clamp_reasoning,
    adjust_max_tokens_for_thinking,
)


def test_build_base_options():
    model = {"id": "test-model"}
    options = {
        "temperature": 0.7,
        "maxTokens": 100,
        "sessionId": "session-123",
        "headers": {"x-test": "val"},
        "apiKey": "key-1",
    }
    # Test builder
    base = build_base_options(model, options)
    assert base["temperature"] == 0.7
    assert base["maxTokens"] == 100
    assert base["sessionId"] == "session-123"
    assert base["headers"] == {"x-test": "val"}
    assert base["apiKey"] == "key-1"

    # Test override with explicit apiKey
    base2 = build_base_options(model, options, api_key="key-override")
    assert base2["apiKey"] == "key-override"

    # Test empty options
    base3 = build_base_options(model)
    assert all(value is None for value in base3.values())


def test_clamp_reasoning():
    assert clamp_reasoning("xhigh") == "high"
    assert clamp_reasoning("high") == "high"
    assert clamp_reasoning("medium") == "medium"
    assert clamp_reasoning("low") == "low"
    assert clamp_reasoning("minimal") == "minimal"
    assert clamp_reasoning(None) is None


def test_adjust_max_tokens_for_thinking():
    # Case 1: base_max_tokens is None, should use model_max_tokens
    res = adjust_max_tokens_for_thinking(None, 4096, "medium")
    assert res["maxTokens"] == 4096
    # thinking budget default for medium is 8192, but maxTokens is 4096 <= 8192
    # So budget is max(0, 4096 - 1024) = 3072
    assert res["thinkingBudget"] == 3072

    # Case 2: base_max_tokens is set, fits inside model cap
    res2 = adjust_max_tokens_for_thinking(2000, 16384, "low")
    # budget for low is 2048. maxTokens = min(2000 + 2048, 16384) = 4048.
    # since 4048 > 2048, thinkingBudget remains 2048.
    assert res2["maxTokens"] == 4048
    assert res2["thinkingBudget"] == 2048

    # Case 3: base_max_tokens + budget exceeds model cap, caps at model cap
    res3 = adjust_max_tokens_for_thinking(15000, 16384, "high")
    # budget for high is 16384. maxTokens = min(15000 + 16384, 16384) = 16384.
    # since 16384 > 16384 is false (16384 <= 16384), budget = max(0, 16384 - 1024) = 15360.
    assert res3["maxTokens"] == 16384
    assert res3["thinkingBudget"] == 15360

    # Case 4: Custom budget override
    custom = {"medium": 500}
    res4 = adjust_max_tokens_for_thinking(1000, 4000, "medium", custom_budgets=custom)
    # budget = 500. maxTokens = min(1000 + 500, 4000) = 1500.
    # 1500 > 500, budget stays 500.
    assert res4["maxTokens"] == 1500
    assert res4["thinkingBudget"] == 500
