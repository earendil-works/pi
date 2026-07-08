from pi_mono.utils.overflow import is_context_overflow, get_overflow_patterns


def test_is_context_overflow_error_message():
    # Matches overflow patterns
    msg_anthropic = {
        "stopReason": "error",
        "errorMessage": "prompt is too long: 213462 tokens > 200000 maximum",
    }
    assert is_context_overflow(msg_anthropic) is True

    msg_openai = {
        "stopReason": "error",
        "errorMessage": "Your input exceeds the context window of this model",
    }
    assert is_context_overflow(msg_openai) is True

    # Does not match overflow patterns
    msg_other = {
        "stopReason": "error",
        "errorMessage": "Internal server error occurred",
    }
    assert is_context_overflow(msg_other) is False


def test_is_context_overflow_non_overflow_exclusions():
    # Contains "rate limit", which is in NON_OVERFLOW_PATTERNS
    msg_rate_limit = {
        "stopReason": "error",
        "errorMessage": "Rate limit exceeded: too many tokens requested",
    }
    assert is_context_overflow(msg_rate_limit) is False

    # Throttling exceptions
    msg_throttling = {
        "stopReason": "error",
        "errorMessage": "Throttling error: Too many tokens, please wait",
    }
    assert is_context_overflow(msg_throttling) is False


def test_is_context_overflow_silent():
    # Successful stop but usage exceeds context window
    msg_silent = {
        "stopReason": "stop",
        "usage": {
            "input": 120000,
            "cacheRead": 10000,
            "output": 1000,
        },
    }
    # contextWindow is 100,000
    assert is_context_overflow(msg_silent, context_window=100000) is True

    # Under context window
    msg_normal = {
        "stopReason": "stop",
        "usage": {
            "input": 80000,
            "cacheRead": 5000,
            "output": 1000,
        },
    }
    assert is_context_overflow(msg_normal, context_window=100000) is False


def test_is_context_overflow_length_stop():
    # stopReason length, output 0, input token fills context window (>= 99%)
    msg_mimo = {
        "stopReason": "length",
        "usage": {
            "input": 99000,
            "cacheRead": 500,
            "output": 0,
        },
    }
    assert is_context_overflow(msg_mimo, context_window=100000) is True

    # stopReason length but output > 0
    msg_mimo_output = {
        "stopReason": "length",
        "usage": {
            "input": 99000,
            "cacheRead": 500,
            "output": 10,
        },
    }
    assert is_context_overflow(msg_mimo_output, context_window=100000) is False

    # stopReason length, output 0, but input is lower than 99% of context window
    msg_mimo_low = {
        "stopReason": "length",
        "usage": {
            "input": 50000,
            "cacheRead": 0,
            "output": 0,
        },
    }
    assert is_context_overflow(msg_mimo_low, context_window=100000) is False


def test_get_overflow_patterns():
    patterns = get_overflow_patterns()
    assert isinstance(patterns, list)
    assert len(patterns) > 10
    # verify one of the patterns compiles and matches
    assert patterns[0].search("prompt is too long") is not None
