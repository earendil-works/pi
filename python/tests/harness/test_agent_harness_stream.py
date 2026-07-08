import pytest
from typing import Any, Optional
from pi_mono.ai.providers.faux import (
    register_faux_provider,
    faux_assistant_message,
    faux_tool_call,
)
from pi_mono.agent.harness.agent_harness import AgentHarness
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.session.memory_storage import InMemorySessionStorage
from pi_mono.agent.harness.session.session import Session


class CalculateTool:
    name = "calculate"
    description = "Evaluate mathematical expressions"
    label = "Calculator"
    parameters = {
        "type": "object",
        "properties": {"expression": {"type": "string"}},
        "required": ["expression"],
    }

    async def execute(
        self, toolCallId: str, params: Any, signal: Any = None, onUpdate: Any = None
    ) -> Any:
        expr = params["expression"]
        try:
            val = eval(expr, {"__builtins__": None}, {})
            return {"content": [{"type": "text", "text": f"{expr} = {val}"}], "details": None}
        except Exception as e:
            raise Exception(str(e))


calculate_tool = CalculateTool()


@pytest.fixture(autouse=True)
def cleanup_faux():
    registrations = []

    def register_helper(options=None):
        reg = register_faux_provider(options)
        registrations.append(reg)
        return reg

    yield register_helper

    for reg in registrations:
        try:
            reg.unregister()
        except Exception:
            pass


def capture_options(options: Optional[dict]) -> dict:
    if options is None:
        return {}
    res = dict(options)
    if options.get("headers") is not None:
        res["headers"] = dict(options["headers"])
    if options.get("metadata") is not None:
        res["metadata"] = dict(options["metadata"])
    return res


@pytest.mark.anyio
async def test_snapshots_stream_options_and_merges_auth_headers_before_provider_request_hooks(
    cleanup_faux, tmp_path
):
    captured_options = None
    registration = cleanup_faux()

    async def mock_response(_ctx, options, _state, _req_model):
        nonlocal captured_options
        captured_options = options
        return faux_assistant_message("ok")

    registration.set_responses([mock_response])

    session = Session(InMemorySessionStorage({"metadata": {"id": "session-1", "createdAt": "now"}}))
    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": session,
            "model": registration.get_model(),
            "streamOptions": {
                "timeoutMs": 1000,
                "maxRetries": 2,
                "maxRetryDelayMs": 3000,
                "headers": {"x-base": "base"},
                "metadata": {"base": True},
                "cacheRetention": "none",
            },
            "getApiKeyAndHeaders": lambda model: {
                "apiKey": "secret",
                "headers": {"x-auth": "auth"},
            },
        }
    )

    before_request_calls = []

    def on_before_provider_request(event):
        before_request_calls.append(event)
        assert event["sessionId"] == "session-1"
        assert event["streamOptions"]["headers"] == {"x-base": "base", "x-auth": "auth"}
        return {
            "streamOptions": {
                "headers": {"x-hook": "hook"},
                "metadata": {"hook": True},
            }
        }

    harness.on("before_provider_request", on_before_provider_request)

    await harness.prompt("hello")

    assert len(before_request_calls) == 1
    assert captured_options is not None
    assert captured_options.get("apiKey") == "secret"
    assert captured_options.get("timeoutMs") == 1000
    assert captured_options.get("maxRetries") == 2
    assert captured_options.get("maxRetryDelayMs") == 3000
    assert captured_options.get("sessionId") == "session-1"
    assert captured_options.get("cacheRetention") == "none"
    assert captured_options.get("headers") == {"x-base": "base", "x-auth": "auth", "x-hook": "hook"}
    assert captured_options.get("metadata") == {"base": True, "hook": True}


@pytest.mark.anyio
async def test_chains_provider_request_patches_and_supports_deletion_semantics(
    cleanup_faux, tmp_path
):
    captured_options = None
    registration = cleanup_faux()

    async def mock_response(_ctx, options, _state, _req_model):
        nonlocal captured_options
        captured_options = options
        return faux_assistant_message("ok")

    registration.set_responses([mock_response])

    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
            "streamOptions": {
                "timeoutMs": 1000,
                "maxRetries": 2,
                "headers": {"keep": "base", "remove": "base"},
                "metadata": {"keep": "base", "remove": "base"},
            },
        }
    )

    def hook1(event):
        assert event["streamOptions"]["headers"] == {"keep": "base", "remove": "base"}
        return {
            "streamOptions": {
                "headers": {"first": "1", "remove": None},
                "metadata": {"first": 1, "remove": None},
            }
        }

    def hook2(event):
        assert event["streamOptions"]["headers"] == {"keep": "base", "first": "1"}
        assert event["streamOptions"]["metadata"] == {"keep": "base", "first": 1}
        return {
            "streamOptions": {
                "timeoutMs": None,
                "headers": {"second": "2"},
                "metadata": None,
            }
        }

    harness.on("before_provider_request", hook1)
    harness.on("before_provider_request", hook2)

    await harness.prompt("hello")

    assert captured_options is not None
    assert "timeoutMs" not in captured_options or captured_options["timeoutMs"] is None
    assert captured_options.get("maxRetries") == 2
    assert captured_options.get("headers") == {"keep": "base", "first": "1", "second": "2"}
    assert captured_options.get("metadata") is None


@pytest.mark.anyio
async def test_uses_updated_stream_options_for_save_point_snapshots_without_mutating_the_active_request(
    cleanup_faux, tmp_path
):
    captured_options = []
    registration = cleanup_faux()

    async def mock_response_1(_ctx, options, _state, _req_model):
        captured_options.append(capture_options(options))
        return faux_assistant_message(
            faux_tool_call("calculate", {"expression": "1 + 1"}, id="call-1"),
            options={"stopReason": "toolUse"},
        )

    async def mock_response_2(_ctx, options, _state, _req_model):
        captured_options.append(capture_options(options))
        return faux_assistant_message("done")

    registration.set_responses([mock_response_1, mock_response_2])

    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
            "tools": [calculate_tool],
            "streamOptions": {"timeoutMs": 1000, "headers": {"turn": "first"}},
        }
    )

    def on_event(event, signal=None):
        if event["type"] == "tool_execution_start":
            harness.setStreamOptions({"timeoutMs": 2000, "headers": {"turn": "second"}})

    harness.subscribe(on_event)

    await harness.prompt("hello")

    assert len(captured_options) == 2
    assert captured_options[0].get("timeoutMs") == 1000
    assert captured_options[0].get("headers") == {"turn": "first"}
    assert captured_options[1].get("timeoutMs") == 2000
    assert captured_options[1].get("headers") == {"turn": "second"}


@pytest.mark.anyio
async def test_chains_provider_payload_hooks(cleanup_faux, tmp_path):
    seen_payloads = []
    final_payload = None
    registration = cleanup_faux()

    async def mock_response(_ctx, options, _state, model):
        nonlocal final_payload
        on_payload = options.get("onPayload") if options else None
        if on_payload and callable(on_payload):
            final_payload = await on_payload({"steps": ["provider"]}, model)
        return faux_assistant_message("ok")

    registration.set_responses([mock_response])

    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
        }
    )

    def hook1(event):
        seen_payloads.append(event["payload"])
        return {"payload": {"steps": ["provider", "first"]}}

    def hook2(event):
        seen_payloads.append(event["payload"])
        return {"payload": {"steps": ["provider", "first", "second"]}}

    harness.on("before_provider_payload", hook1)
    harness.on("before_provider_payload", hook2)

    await harness.prompt("hello")

    assert seen_payloads == [{"steps": ["provider"]}, {"steps": ["provider", "first"]}]
    assert final_payload == {"steps": ["provider", "first", "second"]}
