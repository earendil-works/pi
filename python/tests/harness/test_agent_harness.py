import asyncio
import pytest
import time
from typing import Any, Dict, List
from pi_mono.ai.models import get_model
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


class GetCurrentTimeTool:
    name = "get_current_time"
    description = "Get current system time"
    label = "Time"
    parameters = {
        "type": "object",
        "properties": {},
    }

    async def execute(
        self, toolCallId: str, params: Any, signal: Any = None, onUpdate: Any = None
    ) -> Any:
        return {"content": [{"type": "text", "text": "2026-06-10T12:00:00Z"}], "details": None}


get_current_time_tool = GetCurrentTimeTool()


class MockAppTool:
    def __init__(
        self, name: str, description: str, label: str, parameters: Any, execute: Any, source: str
    ):
        self.name = name
        self.description = description
        self.label = label
        self.parameters = parameters
        self.execute = execute
        self.source = source

    def __getitem__(self, key):
        return getattr(self, key)


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


def text_from_user_messages(messages: List[Dict[str, Any]]) -> List[str]:
    res = []
    for message in messages:
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            res.append(content)
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict) or part.get("type") != "text":
                    continue
                if "text" in part and isinstance(part["text"], str):
                    res.append(part["text"])
    return res


class Deferred:
    def __init__(self):
        self.future = asyncio.get_running_loop().create_future()

    def resolve(self):
        if not self.future.done():
            self.future.set_result(None)


def get_reasoning(options: Any) -> Any:
    if not isinstance(options, dict):
        return None
    return options.get("reasoning")


def test_constructs_directly_and_exposes_queue_modes(tmp_path):
    session = Session(InMemorySessionStorage())
    env = LocalExecutionEnv(cwd=str(tmp_path))
    initial_model = get_model("anthropic", "claude-sonnet-4-5")
    assert initial_model is not None
    harness = AgentHarness(
        {
            "env": env,
            "session": session,
            "model": initial_model,
            "thinkingLevel": "high",
            "systemPrompt": "You are helpful.",
            "steeringMode": "all",
            "followUpMode": "all",
        }
    )
    assert harness.env == env
    assert harness.getModel() == initial_model
    assert harness.getThinkingLevel() == "high"
    assert harness.getSteeringMode() == "all"
    assert harness.getFollowUpMode() == "all"
    harness.setSteeringMode("one-at-a-time")
    harness.setFollowUpMode("one-at-a-time")
    assert harness.getSteeringMode() == "one-at-a-time"
    assert harness.getFollowUpMode() == "one-at-a-time"


@pytest.mark.anyio
async def test_drains_one_queued_steering_message_at_a_time_and_emits_queue_updates(
    cleanup_faux, tmp_path
):
    registration = cleanup_faux()
    user_counts = []

    async def mock_response_1(context, options, _state, _model):
        user_counts.append(len([m for m in context.get("messages", []) if m.get("role") == "user"]))
        return faux_assistant_message("first")

    async def mock_response_2(context, options, _state, _model):
        user_counts.append(len([m for m in context.get("messages", []) if m.get("role") == "user"]))
        return faux_assistant_message("second")

    async def mock_response_3(context, options, _state, _model):
        user_counts.append(len([m for m in context.get("messages", []) if m.get("role") == "user"]))
        return faux_assistant_message("third")

    registration.set_responses([mock_response_1, mock_response_2, mock_response_3])

    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
            "steeringMode": "one-at-a-time",
        }
    )

    steer_queue_lengths = []
    queued = False

    def on_event(event, signal=None):
        nonlocal queued
        if event["type"] == "queue_update":
            steer_queue_lengths.append(len(event["steer"]))
        if (
            event["type"] == "message_start"
            and event["message"]["role"] == "assistant"
            and not queued
        ):
            queued = True
            asyncio.create_task(harness.steer("one"))
            asyncio.create_task(harness.steer("two"))

    harness.subscribe(on_event)
    await harness.prompt("hello")

    assert user_counts == [1, 2, 3]
    assert steer_queue_lengths == [1, 2, 1, 0]


@pytest.mark.anyio
async def test_appends_before_agent_start_messages_and_persists_them(cleanup_faux, tmp_path):
    registration = cleanup_faux()
    request_text = []

    async def mock_response(context, options, _state, _model):
        nonlocal request_text
        request_text = text_from_user_messages(context.get("messages", []))
        return faux_assistant_message("ok")

    registration.set_responses([mock_response])
    session = Session(InMemorySessionStorage())
    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": session,
            "model": registration.get_model(),
        }
    )

    def hook(event):
        return {
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "hook"}],
                    "timestamp": int(time.time() * 1000),
                }
            ]
        }

    harness.on("before_agent_start", hook)
    await harness.prompt("hello")

    persisted_text = []
    for entry in await session.getEntries():
        if entry.type == "message" and entry.message["role"] == "user":
            content = entry.message["content"]
            if isinstance(content, str):
                persisted_text.append(content)
            elif isinstance(content, list):
                for part in content:
                    if part.get("type") == "text":
                        persisted_text.append(part.get("text"))

    assert request_text == ["hello", "hook"]
    assert persisted_text == ["hello", "hook"]


@pytest.mark.anyio
async def test_abort_clears_steer_and_follow_up_queues_but_preserves_next_turn_messages(
    cleanup_faux, tmp_path
):
    registration = cleanup_faux()
    aborted_signal = None

    first_response_released = asyncio.get_running_loop().create_future()

    async def mock_response_1(_context, options, _state, _model):
        nonlocal aborted_signal
        aborted_signal = options.get("signal")
        await first_response_released
        return faux_assistant_message("aborted-ish")

    second_request_text = []

    async def mock_response_2(context, options, _state, _model):
        second_request_text.extend(text_from_user_messages(context.get("messages", [])))
        return faux_assistant_message("second")

    registration.set_responses([mock_response_1, mock_response_2])
    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
        }
    )

    queue_updates = []

    def on_event(event, signal=None):
        if event["type"] == "queue_update":
            queue_updates.append(
                {
                    "steer": len(event["steer"]),
                    "followUp": len(event["followUp"]),
                    "nextTurn": len(event["nextTurn"]),
                }
            )

    harness.subscribe(on_event)

    first_prompt = asyncio.create_task(harness.prompt("first"))
    await asyncio.sleep(0.01)

    await harness.steer("steer")
    await harness.followUp("follow")
    await harness.nextTurn("next")

    abort_result_promise = asyncio.create_task(harness.abort())
    await asyncio.sleep(0.01)

    assert aborted_signal is not None
    assert aborted_signal.aborted is True

    first_response_released.set_result(None)
    abort_result = await abort_result_promise
    await first_prompt

    await harness.prompt("second")

    assert len(abort_result["clearedSteer"]) == 1
    assert len(abort_result["clearedFollowUp"]) == 1
    assert {"steer": 0, "followUp": 0, "nextTurn": 1} in queue_updates
    assert second_request_text == ["first", "next", "second"]


@pytest.mark.anyio
async def test_drains_follow_up_messages_one_at_a_time_after_the_agent_would_otherwise_stop(
    cleanup_faux, tmp_path
):
    registration = cleanup_faux()
    user_counts = []

    async def mock_response_1(context, options, _state, _model):
        user_counts.append(len([m for m in context.get("messages", []) if m.get("role") == "user"]))
        return faux_assistant_message("first")

    async def mock_response_2(context, options, _state, _model):
        user_counts.append(len([m for m in context.get("messages", []) if m.get("role") == "user"]))
        return faux_assistant_message("second")

    async def mock_response_3(context, options, _state, _model):
        user_counts.append(len([m for m in context.get("messages", []) if m.get("role") == "user"]))
        return faux_assistant_message("third")

    registration.set_responses([mock_response_1, mock_response_2, mock_response_3])

    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
            "followUpMode": "one-at-a-time",
        }
    )

    follow_up_queue_lengths = []
    queued = False

    def on_event(event, signal=None):
        nonlocal queued
        if event["type"] == "queue_update":
            follow_up_queue_lengths.append(len(event["followUp"]))
        if (
            event["type"] == "message_start"
            and event["message"]["role"] == "assistant"
            and not queued
        ):
            queued = True
            asyncio.create_task(harness.followUp("one"))
            asyncio.create_task(harness.followUp("two"))

    harness.subscribe(on_event)
    await harness.prompt("hello")

    assert user_counts == [1, 2, 3]
    assert follow_up_queue_lengths == [1, 2, 1, 0]


@pytest.mark.anyio
async def test_settles_thrown_hook_failures_with_persisted_assistant_error_messages(
    cleanup_faux, tmp_path
):
    registration = cleanup_faux()
    registration.set_responses(
        [lambda ctx, opt, state, model: faux_assistant_message("should not be used")]
    )
    session = Session(InMemorySessionStorage())
    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": session,
            "model": registration.get_model(),
        }
    )

    events = []

    def on_event(event, signal=None):
        events.append(event["type"])

    harness.subscribe(on_event)

    def hook(event):
        raise Exception("context exploded")

    harness.on("context", hook)

    response = await harness.prompt("hello")
    # A subsequent prompt should work
    harness.handlers["context"] = []  # clear context hooks so subsequent prompt works
    res_2 = await harness.prompt("after failure")
    assert res_2["role"] == "assistant"

    entries = await session.getEntries()
    messages = [entry.message for entry in entries if entry.type == "message"]
    assert response["stopReason"] == "error"
    assert response["errorMessage"] == "context exploded"
    assert messages[0]["role"] == "user"
    assert messages[1]["role"] == "assistant"
    assert messages[1]["stopReason"] == "error"
    assert messages[1]["errorMessage"] == "context exploded"
    assert "agent_end" in events
    assert "settled" in events


@pytest.mark.anyio
async def test_refreshes_model_thinking_level_resources_system_prompt_and_active_tools_at_save_points(
    cleanup_faux, tmp_path
):
    registration = cleanup_faux(
        {
            "models": [
                {"id": "first", "reasoning": True},
                {"id": "second", "reasoning": True},
            ]
        }
    )
    second_model = registration.get_model("second")
    assert second_model is not None

    captured = []

    async def mock_response_1(context, options, _state, model):
        captured.append(
            {
                "modelId": model["id"],
                "reasoning": get_reasoning(options),
                "systemPrompt": context.get("systemPrompt", ""),
                "tools": [t["name"] for t in context.get("tools", [])],
            }
        )
        return faux_assistant_message(
            faux_tool_call("calculate", {"expression": "1 + 1"}, id="call-1"),
            options={"stopReason": "toolUse"},
        )

    async def mock_response_2(context, options, _state, model):
        captured.append(
            {
                "modelId": model["id"],
                "reasoning": get_reasoning(options),
                "systemPrompt": context.get("systemPrompt", ""),
                "tools": [t["name"] for t in context.get("tools", [])],
            }
        )
        return faux_assistant_message("done")

    registration.set_responses([mock_response_1, mock_response_2])

    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
            "thinkingLevel": "off",
            "resources": {
                "skills": [
                    {
                        "name": "prompt",
                        "description": "prompt",
                        "content": "first prompt",
                        "filePath": "/skills/prompt",
                    }
                ],
            },
            "systemPrompt": lambda ctx: (
                ctx["resources"].get("skills", [])[0]["content"]
                if ctx["resources"].get("skills")
                else "missing prompt"
            ),
            "tools": [calculate_tool],
        }
    )

    def on_event(event, signal=None):
        if event["type"] == "tool_execution_start":
            asyncio.create_task(harness.setModel(second_model))
            asyncio.create_task(harness.setThinkingLevel("high"))
            asyncio.create_task(
                harness.setResources(
                    {
                        "skills": [
                            {
                                "name": "prompt",
                                "description": "prompt",
                                "content": "second prompt",
                                "filePath": "/skills/prompt",
                            }
                        ],
                    }
                )
            )
            asyncio.create_task(
                harness.setTools(
                    [calculate_tool, get_current_time_tool], [get_current_time_tool.name]
                )
            )

    harness.subscribe(on_event)
    await harness.prompt("hello")

    assert captured == [
        {
            "modelId": "first",
            "reasoning": None,
            "systemPrompt": "first prompt",
            "tools": ["calculate"],
        },
        {
            "modelId": "second",
            "reasoning": "high",
            "systemPrompt": "second prompt",
            "tools": ["get_current_time"],
        },
    ]


@pytest.mark.anyio
async def test_orders_pending_listener_session_writes_after_agent_emitted_messages(
    cleanup_faux, tmp_path
):
    registration = cleanup_faux()
    registration.set_responses([lambda ctx, opt, state, model: faux_assistant_message("ok")])

    session = Session(InMemorySessionStorage())
    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": session,
            "model": registration.get_model(),
        }
    )

    wrote_pending_message = False

    async def on_event(event, signal=None):
        nonlocal wrote_pending_message
        if (
            event["type"] == "message_end"
            and event["message"]["role"] == "assistant"
            and not wrote_pending_message
        ):
            wrote_pending_message = True
            await harness.appendMessage(
                {
                    "role": "custom",
                    "customType": "listener",
                    "content": "listener write",
                    "display": True,
                    "timestamp": int(time.time() * 1000),
                }
            )

    harness.subscribe(on_event)
    await harness.prompt("hello")

    entries = await session.getEntries()
    roles = [entry.message["role"] for entry in entries if entry.type == "message"]
    assert roles == ["user", "assistant", "custom"]


@pytest.mark.anyio
async def test_wait_for_idle_waits_for_external_run_settlement_and_awaited_listeners(
    cleanup_faux, tmp_path
):
    registration = cleanup_faux()
    registration.set_responses([lambda ctx, opt, state, model: faux_assistant_message("ok")])

    barrier = Deferred()
    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": Session(InMemorySessionStorage()),
            "model": registration.get_model(),
        }
    )

    listener_finished = False

    async def on_event(event, signal=None):
        nonlocal listener_finished
        if event["type"] == "agent_end":
            await barrier.future
            listener_finished = True

    harness.subscribe(on_event)

    prompt_promise = asyncio.create_task(harness.prompt("hello"))
    idle_resolved = False

    async def run_wait_idle():
        nonlocal idle_resolved
        await harness.waitForIdle()
        idle_resolved = True

    idle_promise = asyncio.create_task(run_wait_idle())
    await asyncio.sleep(0.01)

    assert idle_resolved is False
    assert listener_finished is False

    barrier.resolve()
    await asyncio.gather(prompt_promise, idle_promise)

    assert idle_resolved is True
    assert listener_finished is True


@pytest.mark.anyio
async def test_runs_tool_call_and_tool_result_hooks_through_the_direct_loop(cleanup_faux, tmp_path):
    registration = cleanup_faux()

    async def mock_response(_ctx, options, _state, _model):
        return faux_assistant_message(
            faux_tool_call("calculate", {"expression": "2 + 2"}, id="call-1"),
            options={"stopReason": "toolUse"},
        )

    registration.set_responses([mock_response])

    session = Session(InMemorySessionStorage())
    harness = AgentHarness(
        {
            "env": LocalExecutionEnv(cwd=str(tmp_path)),
            "session": session,
            "model": registration.get_model(),
            "tools": [calculate_tool],
        }
    )

    seen_tool_calls = []

    def on_tool_call(event):
        seen_tool_calls.append(
            {
                "id": event["toolCallId"],
                "name": event["toolName"],
                "expression": event["input"]["expression"],
            }
        )
        return None

    def on_tool_result(event):
        assert event["toolCallId"] == "call-1"
        assert event["toolName"] == "calculate"
        return {
            "content": [{"type": "text", "text": "patched result"}],
            "details": {"patched": True},
            "terminate": True,
        }

    harness.on("tool_call", on_tool_call)
    harness.on("tool_result", on_tool_result)

    await harness.prompt("hello")

    entries = await session.getEntries()
    tool_result = next(
        (
            entry
            for entry in entries
            if entry.type == "message" and entry.message["role"] == "toolResult"
        ),
        None,
    )

    assert seen_tool_calls == [{"id": "call-1", "name": "calculate", "expression": "2 + 2"}]
    assert tool_result is not None
    assert tool_result.message["content"] == [{"type": "text", "text": "patched result"}]
    assert tool_result.message["details"] == {"patched": True}


@pytest.mark.anyio
async def test_preserves_app_tool_types_for_getters_and_update_events(tmp_path):
    session = Session(InMemorySessionStorage())
    env = LocalExecutionEnv(cwd=str(tmp_path))
    model = get_model("anthropic", "claude-sonnet-4-5")
    assert model is not None

    inspect_tool = MockAppTool(
        name="inspect",
        description="Inspect things",
        label="Inspector",
        parameters=calculate_tool.parameters,
        execute=calculate_tool.execute,
        source="builtin",
    )
    search_tool = MockAppTool(
        name="search",
        description="Search things",
        label="Searcher",
        parameters=calculate_tool.parameters,
        execute=calculate_tool.execute,
        source="extension",
    )

    harness = AgentHarness(
        {
            "env": env,
            "session": session,
            "model": model,
            "tools": [inspect_tool, search_tool],
            "activeToolNames": ["inspect"],
        }
    )

    updates = []

    def on_event(event, signal=None):
        if event["type"] == "tools_update":
            updates.append(
                {
                    "toolNames": event["toolNames"],
                    "previousToolNames": event["previousToolNames"],
                    "activeToolNames": event["activeToolNames"],
                    "previousActiveToolNames": event["previousActiveToolNames"],
                    "source": event["source"],
                }
            )
            assert [t.name for t in harness.getActiveTools()] == event["activeToolNames"]

    harness.subscribe(on_event)

    tools = harness.getTools()
    active_tools = harness.getActiveTools()
    tools.pop()
    active_tools.pop()

    assert [t.name for t in harness.getTools()] == ["inspect", "search"]
    assert [t["source"] for t in harness.getActiveTools()] == ["builtin"]

    await harness.setActiveTools(["search"])
    await harness.setTools([search_tool], ["search"])

    with pytest.raises(Exception) as excinfo:
        await harness.setActiveTools(["missing"])
    assert "Unknown tool" in str(excinfo.value)

    with pytest.raises(Exception) as excinfo:
        await harness.setActiveTools(["search", "search"])
    assert "Duplicate active tool" in str(excinfo.value)

    with pytest.raises(Exception) as excinfo:
        await harness.setTools([inspect_tool])
    assert "Unknown tool" in str(excinfo.value) or "invalid_argument" in str(excinfo.value)

    with pytest.raises(Exception) as excinfo:
        await harness.setTools([inspect_tool, inspect_tool], ["inspect"])
    assert "Duplicate tool" in str(excinfo.value) or "invalid_argument" in str(excinfo.value)

    assert updates == [
        {
            "toolNames": ["inspect", "search"],
            "previousToolNames": ["inspect", "search"],
            "activeToolNames": ["search"],
            "previousActiveToolNames": ["inspect"],
            "source": "set",
        },
        {
            "toolNames": ["search"],
            "previousToolNames": ["inspect", "search"],
            "activeToolNames": ["search"],
            "previousActiveToolNames": ["search"],
            "source": "set",
        },
    ]

    assert [t["source"] for t in harness.getTools()] == ["extension"]
    assert [t.name for t in harness.getActiveTools()] == ["search"]
    assert (await session.buildContext()).activeToolNames == ["search"]


def test_validates_constructor_tool_names(tmp_path):
    session = Session(InMemorySessionStorage())
    env = LocalExecutionEnv(cwd=str(tmp_path))
    model = get_model("anthropic", "claude-sonnet-4-5")
    assert model is not None

    with pytest.raises(Exception, match="Unknown tool"):
        AgentHarness(
            {
                "env": env,
                "session": session,
                "model": model,
                "tools": [calculate_tool],
                "activeToolNames": ["missing"],
            }
        )

    with pytest.raises(Exception, match="Duplicate tool"):
        AgentHarness(
            {
                "env": env,
                "session": session,
                "model": model,
                "tools": [calculate_tool, calculate_tool],
                "activeToolNames": [calculate_tool.name],
            }
        )

    with pytest.raises(Exception, match="Duplicate active tool"):
        AgentHarness(
            {
                "env": env,
                "session": session,
                "model": model,
                "tools": [calculate_tool],
                "activeToolNames": [calculate_tool.name, calculate_tool.name],
            }
        )


@pytest.mark.anyio
async def test_preserves_app_resource_types_for_getters_and_update_events(tmp_path):
    session = Session(InMemorySessionStorage())
    env = LocalExecutionEnv(cwd=str(tmp_path))
    model = get_model("anthropic", "claude-sonnet-4-5")
    assert model is not None

    harness = AgentHarness(
        {
            "env": env,
            "session": session,
            "model": model,
        }
    )

    skill = {
        "name": "inspect",
        "description": "Inspect things",
        "content": "Use inspection tools.",
        "filePath": "/skills/inspect/SKILL.md",
        "source": "project",
    }
    prompt_template = {"name": "review", "content": "Review $1", "source": "user"}
    resources = {"skills": [skill], "promptTemplates": [prompt_template]}

    updates = []

    def on_event(event, signal=None):
        if event["type"] == "resources_update":
            updates.append(
                {
                    "resourcesSource": (
                        event["resources"].get("skills", [])[0].get("source")
                        if event["resources"].get("skills")
                        else None
                    ),
                    "previousSource": (
                        event["previousResources"].get("skills", [])[0].get("source")
                        if event["previousResources"].get("skills")
                        else None
                    ),
                }
            )

    harness.subscribe(on_event)

    await harness.setResources(resources)
    await harness.setResources(resources)
    resolved = harness.getResources()

    assert updates == [
        {"resourcesSource": "project", "previousSource": None},
        {"resourcesSource": "project", "previousSource": "project"},
    ]
    assert resolved.get("skills", [])[0].get("source") == "project"
    assert resolved.get("promptTemplates", [])[0].get("source") == "user"
    assert resolved.get("skills") is not resources["skills"]
    assert resolved.get("promptTemplates") is not resources["promptTemplates"]
