import os
import re
from typing import Any

CLOUDFLARE_WORKERS_AI_BASE_URL = (
    "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
)

CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL = (
    "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat"
)

CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL = (
    "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai"
)

CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL = (
    "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic"
)


def is_cloudflare_provider(provider: str) -> bool:
    """Check if the provider is a Cloudflare provider."""
    return provider in ("cloudflare-workers-ai", "cloudflare-ai-gateway")


def resolve_cloudflare_base_url(model: Any) -> str:
    """Substitute {VAR} placeholders in a Cloudflare baseUrl from environment variables."""
    url = str(getattr(model, "base_url", None) or getattr(model, "baseUrl", None) or "")
    if "{" not in url:
        return url

    def replace_match(match: re.Match[str]) -> str:
        name = match.group(1)
        value = os.environ.get(name)
        if not value:
            provider = getattr(model, "provider", "")
            raise ValueError(f"{name} is required for provider {provider} but is not set.")
        return value

    return re.sub(r"\{([A-Z_][A-Z0-9_]*)\}", replace_match, url)
