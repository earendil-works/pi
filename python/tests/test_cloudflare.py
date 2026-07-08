import pytest
from unittest import mock
from pi_mono.ai.providers.cloudflare import is_cloudflare_provider, resolve_cloudflare_base_url


def test_is_cloudflare_provider():
    assert is_cloudflare_provider("cloudflare-workers-ai") is True
    assert is_cloudflare_provider("cloudflare-ai-gateway") is True
    assert is_cloudflare_provider("openai") is False
    assert is_cloudflare_provider("mistral") is False


class MockModel:
    def __init__(self, base_url, provider):
        self.base_url = base_url
        self.provider = provider


def test_resolve_cloudflare_base_url_no_braces():
    model = MockModel(
        "https://api.cloudflare.com/client/v4/accounts/123/ai/v1", "cloudflare-workers-ai"
    )
    assert (
        resolve_cloudflare_base_url(model)
        == "https://api.cloudflare.com/client/v4/accounts/123/ai/v1"
    )


def test_resolve_cloudflare_base_url_with_env():
    model = MockModel(
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
        "cloudflare-ai-gateway",
    )
    with mock.patch.dict(
        "os.environ", {"CLOUDFLARE_ACCOUNT_ID": "acc_123", "CLOUDFLARE_GATEWAY_ID": "gw_456"}
    ):
        result = resolve_cloudflare_base_url(model)
        assert result == "https://gateway.ai.cloudflare.com/v1/acc_123/gw_456/compat"


def test_resolve_cloudflare_base_url_missing_env():
    model = MockModel(
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
        "cloudflare-ai-gateway",
    )
    with mock.patch.dict("os.environ", {"CLOUDFLARE_ACCOUNT_ID": "acc_123"}):
        with pytest.raises(ValueError) as excinfo:
            resolve_cloudflare_base_url(model)
        assert "CLOUDFLARE_GATEWAY_ID is required for provider cloudflare-ai-gateway" in str(
            excinfo.value
        )
