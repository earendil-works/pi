from pi_mono.coding_agent.core.auth_guidance import format_api_error_message


def test_format_api_error_message_openrouter_402():
    raw = (
        "Error code: 402 - {'error': {'message': 'Insufficient credits. "
        "This account never purchased credits.', 'code': 402}}"
    )
    formatted = format_api_error_message(
        raw,
        provider="openrouter",
        model_id="anthropic/claude-opus-4.1",
    )
    assert "no credits" in formatted.lower()
    assert "openai/gpt-oss-20b:free" in formatted
    assert "pyproject.toml" in formatted


def test_format_api_error_message_openrouter_401():
    raw = (
        "Error code: 401 - {'error': {'message': 'Incorrect API key provided. "
        "Please check your credentials.', 'code': 401}}"
    )
    formatted = format_api_error_message(
        raw,
        provider="openrouter",
        model_id="anthropic/claude-opus-4.1",
    )
    assert "invalid api key" in formatted.lower()
    assert "use /login" in formatted.lower()


def test_format_api_error_message_openrouter_429():
    raw = (
        "Error code: 429 - {'error': {'message': 'Rate limit exceeded. "
        "Too many requests.', 'code': 429}}"
    )
    formatted = format_api_error_message(
        raw,
        provider="openrouter",
        model_id="anthropic/claude-opus-4.1",
    )
    assert "rate limit exceeded" in formatted.lower()
    assert "please wait and try again" in formatted.lower()
