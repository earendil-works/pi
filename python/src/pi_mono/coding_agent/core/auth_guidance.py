"""Auth and model selection guidance messages."""

from __future__ import annotations

from pathlib import Path

from pi_mono.config import get_docs_path

UNKNOWN_PROVIDER = "unknown"


def get_provider_login_help() -> str:
    docs_path = get_docs_path()
    return "\n".join(
        [
            "Use /login to log into a provider via OAuth or API key. See:",
            f"  {Path(docs_path) / 'providers.md'}",
            f"  {Path(docs_path) / 'models.md'}",
        ]
    )


def format_no_models_available_message() -> str:
    return f"No models available. {get_provider_login_help()}"


def format_no_model_selected_message() -> str:
    return (
        f"No model selected.\n\n{get_provider_login_help()}\n\nThen use /model to select a model."
    )


def format_no_api_key_found_message(provider: str) -> str:
    provider_display = "the selected model" if provider == UNKNOWN_PROVIDER else provider
    return f"No API key found for {provider_display}.\n\n{get_provider_login_help()}"


def format_api_error_message(
    error_message: str,
    *,
    provider: str | None = None,
    model_id: str | None = None,
) -> str:
    """Turn raw provider/SDK errors into actionable guidance."""
    text = error_message.strip()
    lower = text.lower()

    if "insufficient credits" in lower or "error code: 402" in lower or "'code': 402" in lower:
        model_hint = f" ({model_id})" if model_id else ""
        provider_hint = provider or "openrouter"
        return "\n".join(
            [
                f"OpenRouter has no credits for the selected model{model_hint}.",
                "This is a billing/account limit, not a project or pyproject.toml issue.",
                "",
                "Fix options:",
                "  1. Add credits: https://openrouter.ai/settings/credits",
                "  2. Switch to a free model, e.g.:",
                f"     pi --provider {provider_hint} --model openai/gpt-oss-20b:free",
                "  3. In interactive mode: Ctrl+P (model picker) or /model",
                "  4. Update ~/.pi/agent/settings.json defaultModel",
            ]
        )

    if (
        "incorrect api key" in lower
        or "invalid api key" in lower
        or "error code: 401" in lower
        or "'code': 401" in lower
    ):
        provider_hint = f" for {provider}" if provider else ""
        return "\n".join(
            [
                f"Invalid API key or credentials{provider_hint}.",
                "",
                "Fix options:",
                "  1. Use /login to log into a provider via OAuth or API key.",
                "  2. Provide a valid key via environment variables.",
            ]
        )

    if (
        "rate limit" in lower
        or "too many requests" in lower
        or "error code: 429" in lower
        or "'code': 429" in lower
    ):
        return "\n".join(
            [
                "Rate limit exceeded.",
                "",
                "Fix options:",
                "  1. Please wait and try again shortly.",
                "  2. Switch to another model or provider.",
            ]
        )

    if len(text) > 500 and "error code:" in lower:
        return text.split(" - ", 1)[0].strip()

    return text
