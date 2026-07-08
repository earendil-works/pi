import pytest
from pi_mono.ai.stream import stream, complete, complete_simple
from pi_mono.ai.providers.faux import (
    register_faux_provider,
    faux_assistant_message,
)
from pi_mono.ai.types import Context, StreamOptions


@pytest.mark.anyio
async def test_stream_and_complete_basic():
    # Register faux provider
    faux = register_faux_provider(
        {
            "tokensPerSecond": 1000,
            "tokenSize": {"min": 1, "max": 2},
        }
    )

    model = faux.get_model()
    assert model is not None

    context: Context = {
        "systemPrompt": "You are a helpful assistant.",
        "messages": [{"role": "user", "content": "Hello"}],
    }

    # Queue response
    msg = faux_assistant_message("Hello from faux!")
    faux.set_responses([msg])

    # Test stream
    events = []
    async for event in stream(model, context):
        events.append(event)

    assert len(events) >= 5  # start, text_start, text_delta(s), text_end, done
    assert events[0]["type"] == "start"
    assert events[-1]["type"] == "done"
    assert events[-1]["message"]["content"][0]["text"] == "Hello from faux!"

    # Queue another response for complete
    msg2 = faux_assistant_message("Response 2")
    faux.set_responses([msg2])

    res = await complete(model, context)
    assert res["content"][0]["text"] == "Response 2"

    faux.unregister()


@pytest.mark.anyio
async def test_stream_simple_and_complete_simple():
    faux = register_faux_provider()
    model = faux.get_model()
    assert model is not None

    context: Context = {"messages": []}

    msg = faux_assistant_message("Simple response")
    faux.set_responses([msg])

    res = await complete_simple(model, context)
    assert res["content"][0]["text"] == "Simple response"

    faux.unregister()


@pytest.mark.anyio
async def test_api_key_injection(monkeypatch):
    # Set env var
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-key-123")

    faux = register_faux_provider({"provider": "openai"})
    model = faux.get_model()
    assert model is not None

    context: Context = {"messages": []}

    apiKey_received = None

    async def response_factory(ctx, options, state, req_model):
        nonlocal apiKey_received
        apiKey_received = options.get("apiKey") if options else None
        return faux_assistant_message("Received API key")

    faux.set_responses([response_factory])

    await complete(model, context)
    assert apiKey_received == "sk-test-key-123"

    faux.unregister()


class FauxAbortSignal:
    def __init__(self, aborted=False):
        self.aborted = aborted


@pytest.mark.anyio
async def test_abort_signal():
    faux = register_faux_provider()
    model = faux.get_model()
    assert model is not None

    context: Context = {"messages": []}
    msg = faux_assistant_message("Should be aborted")
    faux.set_responses([msg])

    signal = FauxAbortSignal(aborted=True)
    options: StreamOptions = {"signal": signal}

    events = []
    async for event in stream(model, context, options):
        events.append(event)

    assert len(events) == 1  # only the error event is yielded before the stream ends
    assert events[0]["type"] == "error"
    assert events[0]["reason"] == "aborted"

    faux.unregister()
