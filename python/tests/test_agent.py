import asyncio
import time
import pytest
from unittest import mock
from typing import Any, List

from pi_mono.ai.types import AssistantMessage, AssistantMessageEvent, Model
from pi_mono.utils.abort_signals import AbortSignal
from pi_mono.utils.event_stream import EventStream
from pi_mono.agent.agent import Agent
from pi_mono.agent.types import AgentMessage, AgentEvent, AgentTool


class MockAssistantStream(EventStream[AssistantMessageEvent, AssistantMessage]):
    def __init__(self) -> None:
        super().__init__(
            is_complete=lambda event: event["type"] in ("done", "error"),
            extract_result=self._extract_result,
        )

    def _extract_result(self, event: AssistantMessageEvent) -> AssistantMessage:
        if event["type"] == "done":
            return event["message"]
        elif event["type"] == "error":
            return event["error"]
        raise ValueError("Unexpected event type")


def create_assistant_message(text: str) -> AssistantMessage:
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "api": "openai-responses",
        "provider": "openai",
        "model": "mock",
        "usage": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 0,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
        "stopReason": "stop",
        "timestamp": int(time.time() * 1000),
    }


class Deferred:
    def __init__(self) -> None:
        self.future = asyncio.get_running_loop().create_future()

    def resolve(self) -> None:
        if not self.future.done():
            self.future.set_result(None)


def test_agent_default_state() -> None:
    agent = Agent()
    assert agent.state is not None
    assert agent.state.systemPrompt == ""
    assert agent.state.model is not None
    assert agent.state.thinkingLevel == "off"
    assert agent.state.tools == []
    assert agent.state.messages == []
    assert agent.state.isStreaming is False
    assert agent.state.streamingMessage is None
    assert agent.state.pendingToolCalls == set()
    assert agent.state.errorMessage is None


def test_agent_custom_initial_state() -> None:
    custom_model: Model = {
        "id": "gpt-4o-mini",
        "name": "GPT 4o Mini",
        "api": "openai-responses",
        "provider": "openai",
    }
    agent = Agent(
        {
            "initialState": {
                "systemPrompt": "You are a helpful assistant.",
                "model": custom_model,
                "thinkingLevel": "low",
            }
        }
    )
    assert agent.state.systemPrompt == "You are a helpful assistant."
    assert agent.state.model == custom_model
    assert agent.state.thinkingLevel == "low"


def test_agent_subscribe() -> None:
    agent = Agent()
    event_count = 0

    def listener(event: AgentEvent, signal: AbortSignal) -> None:
        nonlocal event_count
        event_count += 1

    unsubscribe = agent.subscribe(listener)
    assert event_count == 0

    # Mutator changes do not emit events
    agent.state.systemPrompt = "Test prompt"
    assert event_count == 0
    assert agent.state.systemPrompt == "Test prompt"

    unsubscribe()
    agent.state.systemPrompt = "Another prompt"
    assert event_count == 0


@pytest.mark.anyio
async def test_agent_thrown_run_failures() -> None:
    async def explode(*args: Any, **kwargs: Any) -> Any:
        raise ValueError("provider exploded")

    agent = Agent({"streamFn": explode})
    events: List[str] = []

    def listener(event: AgentEvent, signal: AbortSignal) -> None:
        events.append(event["type"])

    agent.subscribe(listener)

    await agent.prompt("hello")

    assert events == [
        "agent_start",
        "turn_start",
        "message_start",
        "message_end",
        "message_start",
        "message_end",
        "turn_end",
        "agent_end",
    ]
    last_msg = agent.state.messages[-1]
    assert last_msg["role"] == "assistant"
    assert last_msg["stopReason"] == "error"
    assert last_msg["errorMessage"] == "provider exploded"
    assert agent.state.errorMessage == "provider exploded"


@pytest.mark.anyio
async def test_agent_await_async_subscribers_before_resolve() -> None:
    deferred = Deferred()

    async def mock_stream(*args: Any, **kwargs: Any) -> Any:
        stream = MockAssistantStream()

        async def push_done() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {"type": "done", "reason": "stop", "message": create_assistant_message("ok")}
            )

        asyncio.create_task(push_done())
        return stream

    agent = Agent({"streamFn": mock_stream})

    listener_finished = False

    async def listener(event: AgentEvent, signal: AbortSignal) -> None:
        nonlocal listener_finished
        if event["type"] == "agent_end":
            await deferred.future
            listener_finished = True

    agent.subscribe(listener)

    prompt_resolved = False

    async def run_prompt() -> None:
        nonlocal prompt_resolved
        await agent.prompt("hello")
        prompt_resolved = True

    prompt_task = asyncio.create_task(run_prompt())

    await asyncio.sleep(0.01)
    assert not prompt_resolved
    assert not listener_finished
    assert agent.state.isStreaming is True

    deferred.resolve()
    await prompt_task

    assert listener_finished
    assert prompt_resolved
    assert agent.state.isStreaming is False


@pytest.mark.anyio
async def test_agent_wait_for_idle() -> None:
    deferred = Deferred()

    async def mock_stream(*args: Any, **kwargs: Any) -> Any:
        stream = MockAssistantStream()

        async def push_done() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {"type": "done", "reason": "stop", "message": create_assistant_message("ok")}
            )

        asyncio.create_task(push_done())
        return stream

    agent = Agent({"streamFn": mock_stream})

    async def listener(event: AgentEvent, signal: AbortSignal) -> None:
        if event["type"] == "message_end" and event["message"]["role"] == "assistant":
            await deferred.future

    agent.subscribe(listener)

    prompt_task = asyncio.create_task(agent.prompt("hello"))
    idle_resolved = False

    async def run_idle() -> None:
        nonlocal idle_resolved
        await agent.waitForIdle()
        idle_resolved = True

    idle_task = asyncio.create_task(run_idle())

    await asyncio.sleep(0.01)
    assert not idle_resolved
    assert agent.state.isStreaming is True

    deferred.resolve()
    await asyncio.gather(prompt_task, idle_task)

    assert idle_resolved
    assert agent.state.isStreaming is False


@pytest.mark.anyio
async def test_agent_pass_abort_signal() -> None:
    received_signal: AbortSignal | None = None

    async def mock_stream(model: Any, context: Any, options: Any) -> Any:
        nonlocal received_signal
        received_signal = options.get("signal")
        stream = MockAssistantStream()

        async def check_abort() -> None:
            await asyncio.sleep(0.005)
            stream.push({"type": "start", "partial": create_assistant_message("")})
            while True:
                if received_signal and received_signal.aborted:
                    stream.push(
                        {
                            "type": "error",
                            "reason": "aborted",
                            "error": create_assistant_message("Aborted"),
                        }
                    )
                    break
                await asyncio.sleep(0.005)

        asyncio.create_task(check_abort())
        return stream

    agent = Agent({"streamFn": mock_stream})

    prompt_task = asyncio.create_task(agent.prompt("hello"))
    await asyncio.sleep(0.01)

    assert received_signal is not None
    assert not received_signal.aborted

    agent.abort()
    await prompt_task

    assert received_signal.aborted


def test_agent_state_mutators() -> None:
    agent = Agent()

    agent.state.systemPrompt = "Custom prompt"
    assert agent.state.systemPrompt == "Custom prompt"

    new_model: Model = {
        "id": "gemini-2.5-flash",
        "name": "Gemini Flash",
        "api": "google-generative-ai",
        "provider": "google",
    }
    agent.state.model = new_model
    assert agent.state.model == new_model

    agent.state.thinkingLevel = "high"
    assert agent.state.thinkingLevel == "high"

    tools: List[AgentTool] = [mock.MagicMock(spec=AgentTool)]
    agent.state.tools = tools
    assert agent.state.tools == tools
    assert agent.state.tools is not tools  # copy

    messages: List[AgentMessage] = [{"role": "user", "content": "Hello", "timestamp": 1234}]
    agent.state.messages = messages
    assert agent.state.messages == messages
    assert agent.state.messages is not messages  # copy

    agent.state.messages = []
    assert agent.state.messages == []


def test_agent_steering_followup_queues() -> None:
    agent = Agent()

    steer_msg = {"role": "user", "content": "Steering message", "timestamp": 1234}
    agent.steer(steer_msg)
    assert steer_msg not in agent.state.messages
    assert agent.hasQueuedMessages()

    followup_msg = {"role": "user", "content": "Follow-up message", "timestamp": 5678}
    agent.followUp(followup_msg)
    assert followup_msg not in agent.state.messages
    assert agent.hasQueuedMessages()

    agent.clearAllQueues()
    assert not agent.hasQueuedMessages()


@pytest.mark.anyio
async def test_agent_prompt_while_streaming() -> None:
    async def mock_stream(model: Any, context: Any, options: Any) -> Any:
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push({"type": "start", "partial": create_assistant_message("")})
            while not options.get("signal").aborted:
                await asyncio.sleep(0.005)
            stream.push(
                {
                    "type": "error",
                    "reason": "aborted",
                    "error": create_assistant_message("Aborted"),
                }
            )

        asyncio.create_task(run_stream())
        return stream

    agent = Agent({"streamFn": mock_stream})

    first_prompt_task = asyncio.create_task(agent.prompt("First message"))
    await asyncio.sleep(0.01)
    assert agent.state.isStreaming is True

    with pytest.raises(RuntimeError) as excinfo:
        await agent.prompt("Second message")
    assert "Agent is already processing a prompt" in str(excinfo.value)

    agent.abort()
    await first_prompt_task


@pytest.mark.anyio
async def test_agent_continue_while_streaming() -> None:
    async def mock_stream(model: Any, context: Any, options: Any) -> Any:
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push({"type": "start", "partial": create_assistant_message("")})
            while not options.get("signal").aborted:
                await asyncio.sleep(0.005)
            stream.push(
                {
                    "type": "error",
                    "reason": "aborted",
                    "error": create_assistant_message("Aborted"),
                }
            )

        asyncio.create_task(run_stream())
        return stream

    agent = Agent({"streamFn": mock_stream})

    first_prompt_task = asyncio.create_task(agent.prompt("First message"))
    await asyncio.sleep(0.01)
    assert agent.state.isStreaming is True

    with pytest.raises(RuntimeError) as excinfo:
        await agent.continue_run()
    assert "Agent is already processing" in str(excinfo.value)

    agent.abort()
    await first_prompt_task


@pytest.mark.anyio
async def test_agent_continue_queued_followups() -> None:
    async def mock_stream(*args: Any, **kwargs: Any) -> Any:
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {
                    "type": "done",
                    "reason": "stop",
                    "message": create_assistant_message("Processed"),
                }
            )

        asyncio.create_task(run_stream())
        return stream

    agent = Agent({"streamFn": mock_stream})
    agent.state.messages = [
        {"role": "user", "content": "Initial", "timestamp": 1234},
        create_assistant_message("Initial response"),
    ]

    followup_msg = {"role": "user", "content": "Queued follow-up", "timestamp": 5678}
    agent.followUp(followup_msg)

    await agent.continue_run()

    has_queued = any(
        m["role"] == "user" and "Queued follow-up" in str(m["content"])
        for m in agent.state.messages
    )
    assert has_queued
    assert agent.state.messages[-1]["role"] == "assistant"


@pytest.mark.anyio
async def test_agent_continue_one_at_a_time_steering() -> None:
    response_count = 0

    async def mock_stream(*args: Any, **kwargs: Any) -> Any:
        nonlocal response_count
        response_count += 1
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {
                    "type": "done",
                    "reason": "stop",
                    "message": create_assistant_message(f"Processed {response_count}"),
                }
            )

        asyncio.create_task(run_stream())
        return stream

    agent = Agent({"streamFn": mock_stream})
    agent.state.messages = [
        {"role": "user", "content": "Initial", "timestamp": 1234},
        create_assistant_message("Initial response"),
    ]

    agent.steer({"role": "user", "content": "Steering 1", "timestamp": 5678})
    agent.steer({"role": "user", "content": "Steering 2", "timestamp": 9012})

    await agent.continue_run()

    recent_roles = [m["role"] for m in agent.state.messages[-4:]]
    assert recent_roles == ["user", "assistant", "user", "assistant"]
    assert response_count == 2


@pytest.mark.anyio
async def test_agent_forwards_session_id() -> None:
    received_session_id = None

    async def mock_stream(model: Any, context: Any, options: Any) -> Any:
        nonlocal received_session_id
        received_session_id = options.get("sessionId")
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {"type": "done", "reason": "stop", "message": create_assistant_message("ok")}
            )

        asyncio.create_task(run_stream())
        return stream

    agent = Agent({"sessionId": "session-abc", "streamFn": mock_stream})
    await agent.prompt("hello")
    assert received_session_id == "session-abc"

    agent.sessionId = "session-def"
    assert agent.sessionId == "session-def"

    await agent.prompt("hello again")
    assert received_session_id == "session-def"
