import pytest

from pi_mono.ai.images_api_registry import (
    register_images_api_provider,
    get_images_api_provider,
    clear_images_api_providers,
)
from pi_mono.ai.images import generate_images
from pi_mono.ai.providers.images.openrouter import build_params, parse_usage


def test_images_api_registry():
    clear_images_api_providers()

    class FakeProvider:
        api = "fake-images"

        async def generate_images(self, model, context, options=None):
            return {"api": "fake-images", "provider": "fake", "output": [], "stopReason": "stop"}

    register_images_api_provider(FakeProvider())

    provider = get_images_api_provider("fake-images")
    assert provider is not None
    assert provider.api == "fake-images"

    assert get_images_api_provider("nonexistent") is None


@pytest.mark.anyio
async def test_generate_images_orchestration():
    clear_images_api_providers()

    called = []

    class FakeProvider:
        api = "fake-images"

        async def generate_images(self, model, context, options=None):
            called.append((model, context, options))
            return {"api": "fake-images", "provider": "fake", "output": [], "stopReason": "stop"}

    register_images_api_provider(FakeProvider())

    model = {"api": "fake-images", "id": "fake-model"}
    context = {"input": []}
    res = await generate_images(model, context, {"temperature": 0.5})

    assert len(called) == 1
    assert called[0][0] == model
    assert called[0][1] == context
    assert called[0][2] == {"temperature": 0.5}
    assert res["api"] == "fake-images"


def test_openrouter_build_params():
    model = {
        "id": "stabilityai/stable-diffusion-xl",
        "api": "openrouter-images",
        "output": ["image"],
    }
    context = {
        "input": [
            {"type": "text", "text": "A beautiful sunset"},
            {"type": "image", "mimeType": "image/png", "data": "base64encoded"},
        ]
    }

    params = build_params(model, context)
    assert params["model"] == "stabilityai/stable-diffusion-xl"
    assert params["stream"] is False
    assert params["modalities"] == ["image"]
    assert len(params["messages"]) == 1
    assert len(params["messages"][0]["content"]) == 2
    assert params["messages"][0]["content"][0] == {"type": "text", "text": "A beautiful sunset"}
    assert params["messages"][0]["content"][1]["type"] == "image_url"
    assert (
        "data:image/png;base64,base64encoded"
        in params["messages"][0]["content"][1]["image_url"]["url"]
    )


def test_openrouter_parse_usage():
    model = {
        "id": "stabilityai/stable-diffusion-xl",
        "api": "openrouter-images",
        "cost": {
            "input": 1.0,
            "output": 2.0,
            "cacheRead": 0.5,
            "cacheWrite": 0.8,
        },
    }

    class FakeUsage:
        prompt_tokens = 1000
        completion_tokens = 500

        class prompt_tokens_details:
            cached_tokens = 200
            cache_write_tokens = 50

    usage = parse_usage(FakeUsage(), model)
    assert usage["input"] == 800  # 1000 - 150 - 50
    assert usage["output"] == 500
    assert usage["cacheRead"] == 150
    assert usage["cacheWrite"] == 50
    assert usage["cost"]["input"] == (1.0 / 1000000.0) * 800
