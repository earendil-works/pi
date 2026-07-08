import pytest
from pi_mono.ai.api_registry import (
    register_api_provider,
    get_api_provider,
    get_api_providers,
    unregister_api_providers,
    clear_api_providers,
    ApiProvider,
)
from pi_mono.ai.types import Model, Context
from pi_mono.utils.event_stream import create_assistant_message_event_stream


class MockProvider(ApiProvider):
    def __init__(self, api: str):
        self.api = api

    def stream(self, model, context, options=None):
        return create_assistant_message_event_stream()

    def stream_simple(self, model, context, options=None):
        return create_assistant_message_event_stream()


def test_api_registry_basic():
    clear_api_providers()
    provider = MockProvider("mock-api")
    register_api_provider(provider, "source-1")

    p = get_api_provider("mock-api")
    assert p is not None
    assert p.api == "mock-api"

    providers = get_api_providers()
    assert len(providers) == 1
    assert providers[0].api == "mock-api"


def test_api_registry_mismatch():
    clear_api_providers()
    provider = MockProvider("mock-api")
    register_api_provider(provider)

    p = get_api_provider("mock-api")
    assert p is not None

    model: Model = {"api": "another-api", "id": "m1"}
    context: Context = {"messages": []}

    with pytest.raises(ValueError) as exc_info:
        p.stream(model, context)
    assert "Mismatched api" in str(exc_info.value)

    with pytest.raises(ValueError) as exc_info:
        p.stream_simple(model, context)
    assert "Mismatched api" in str(exc_info.value)


def test_api_registry_unregister():
    clear_api_providers()
    p1 = MockProvider("api-1")
    p2 = MockProvider("api-2")
    register_api_provider(p1, "source-1")
    register_api_provider(p2, "source-2")

    assert len(get_api_providers()) == 2

    unregister_api_providers("source-1")
    assert len(get_api_providers()) == 1
    assert get_api_provider("api-1") is None
    assert get_api_provider("api-2") is not None


def test_api_registry_clear():
    clear_api_providers()
    p = MockProvider("api-1")
    register_api_provider(p)
    assert len(get_api_providers()) == 1

    clear_api_providers()
    assert len(get_api_providers()) == 0
