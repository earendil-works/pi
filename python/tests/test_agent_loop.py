import asyncio
import time
import pytest
from typing import Any, List

from pi_mono.ai.types import (
    AssistantMessage,
    AssistantMessageEvent,
    Message,
    Model,
    UserMessage,
)
from pi_mono.utils.abort_signals import AbortSignal
from pi_mono.utils.event_stream import EventStream
from pi_mono.agent.agent_loop import agent_loop
from pi_mono.agent.types import (
    AgentContext,
    AgentEvent,
    AgentLoopConfig,
    AgentMessage,
)


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


def create_usage() -> dict:
    return {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    }


def create_model() -> Model:
    return {
        "id": "mock",
        "name": "mock",
        "api": "openai-responses",
        "provider": "openai",
        "baseUrl": "https://example.invalid",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 8192,
        "maxTokens": 2048,
    }


def create_assistant_message(
    content: List[Any],
    stop_reason: str = "stop",
) -> AssistantMessage:
    return {
        "role": "assistant",
        "content": content,
        "api": "openai-responses",
        "provider": "openai",
        "model": "mock",
        "usage": create_usage(),  # type: ignore
        "stopReason": stop_reason,  # type: ignore
        "timestamp": int(time.time() * 1000),
    }


def create_user_message(text: str) -> UserMessage:
    return {
        "role": "user",
        "content": text,
        "timestamp": int(time.time() * 1000),
    }


def identity_converter(messages: List[AgentMessage]) -> List[Message]:
    return [
        m for m in messages if m.get("role") in ("user", "assistant", "toolResult")
    ]  # type: ignore


class DummyTool:
    def __init__(
        self,
        name: str,
        description: str,
        parameters: dict,
        execute_func: Any,
        execution_mode: str = "parallel",
        prepare_args_func: Any = None,
    ) -> None:
        self.name = name
        self.description = description
        self.parameters = parameters
        self.label = name.capitalize()
        self.execute_func = execute_func
        self.executionMode = execution_mode
        if prepare_args_func:
            self.prepareArguments = prepare_args_func

    async def execute(
        self,
        toolCallId: str,
        params: Any,
        signal: AbortSignal | None = None,
        onUpdate: Any = None,
    ) -> Any:
        return await self.execute_func(toolCallId, params, signal, onUpdate)


@pytest.mark.anyio
async def test_agent_loop_basic_flow() -> None:
    context: AgentContext = {
        "systemPrompt": "You are helpful.",
        "messages": [],
        "tools": [],
    }

    user_prompt = create_user_message("Hello")

    config: AgentLoopConfig = {
        "model": create_model(),
        "convertToLlm": identity_converter,
    }

    async def stream_fn(*args: Any, **kwargs: Any) -> Any:
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {
                    "type": "done",
                    "reason": "stop",
                    "message": create_assistant_message([{"type": "text", "text": "Hi there!"}]),
                }
            )

        asyncio.create_task(run_stream())
        return stream

    events: List[AgentEvent] = []
    stream = agent_loop([user_prompt], context, config, None, stream_fn)

    async for event in stream:
        events.append(event)

    messages = await stream.result()

    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert messages[1]["role"] == "assistant"

    event_types = [e["type"] for e in events]
    assert "agent_start" in event_types
    assert "turn_start" in event_types
    assert "message_start" in event_types
    assert "message_end" in event_types
    assert "turn_end" in event_types
    assert "agent_end" in event_types


@pytest.mark.anyio
async def test_agent_loop_custom_types() -> None:
    # Custom notification type
    notification = {
        "role": "notification",
        "text": "This is a notification",
        "timestamp": int(time.time() * 1000),
    }

    context: AgentContext = {
        "systemPrompt": "You are helpful.",
        "messages": [notification],
        "tools": [],
    }

    user_prompt = create_user_message("Hello")
    converted_messages: List[Message] = []

    def custom_converter(messages: List[AgentMessage]) -> List[Message]:
        nonlocal converted_messages
        converted = [
            m for m in messages if m.get("role") in ("user", "assistant", "toolResult")
        ]  # type: ignore
        converted_messages = converted
        return converted

    config: AgentLoopConfig = {
        "model": create_model(),
        "convertToLlm": custom_converter,
    }

    async def stream_fn(*args: Any, **kwargs: Any) -> Any:
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {
                    "type": "done",
                    "reason": "stop",
                    "message": create_assistant_message([{"type": "text", "text": "Response"}]),
                }
            )

        asyncio.create_task(run_stream())
        return stream

    stream = agent_loop([user_prompt], context, config, None, stream_fn)
    async for _ in stream:
        pass

    assert len(converted_messages) == 1
    assert converted_messages[0]["role"] == "user"


@pytest.mark.anyio
async def test_agent_loop_transform_context() -> None:
    context: AgentContext = {
        "systemPrompt": "You are helpful.",
        "messages": [
            create_user_message("old message 1"),
            create_assistant_message([{"type": "text", "text": "old response 1"}]),
            create_user_message("old message 2"),
            create_assistant_message([{"type": "text", "text": "old response 2"}]),
        ],
        "tools": [],
    }

    user_prompt = create_user_message("new message")
    transformed_messages: List[AgentMessage] = []
    converted_messages: List[Message] = []

    async def transform_ctx(messages: List[AgentMessage], signal: AbortSignal | None) -> Any:
        nonlocal transformed_messages
        transformed_messages = messages[-2:]
        return transformed_messages

    def convert_to_llm(messages: List[AgentMessage]) -> List[Message]:
        nonlocal converted_messages
        converted = [
            m for m in messages if m.get("role") in ("user", "assistant", "toolResult")
        ]  # type: ignore
        converted_messages = converted
        return converted

    config: AgentLoopConfig = {
        "model": create_model(),
        "transformContext": transform_ctx,
        "convertToLlm": convert_to_llm,
    }

    async def stream_fn(*args: Any, **kwargs: Any) -> Any:
        stream = MockAssistantStream()

        async def run_stream() -> None:
            await asyncio.sleep(0.005)
            stream.push(
                {
                    "type": "done",
                    "reason": "stop",
                    "message": create_assistant_message([{"type": "text", "text": "Response"}]),
                }
            )

        asyncio.create_task(run_stream())
        return stream

    stream = agent_loop([user_prompt], context, config, None, stream_fn)
    async for _ in stream:
        pass

    assert len(transformed_messages) == 2
    assert len(converted_messages) == 2


@pytest.mark.anyio
async def test_agent_loop_tool_calls() -> None:
    executed = []

    async def tool_execute(
        toolCallId: str, params: Any, signal: AbortSignal | None, onUpdate: Any
    ) -> Any:
        executed.append(params.get("value"))
        return {
            "content": [{"type": "text", "text": f"echoed: {params['value']}"}],
            "details": {"value": params["value"]},
        }

    echo_tool = DummyTool(
        name="echo",
        description="Echo tool",
        parameters={
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
        execute_func=tool_execute,
    )

    context: AgentContext = {
        "systemPrompt": "",
        "messages": [],
        "tools": [echo_tool],  # type: ignore
    }

    user_prompt = create_user_message("echo something")
    config: AgentLoopConfig = {
        "model": create_model(),
        "convertToLlm": identity_converter,
    }

    call_index = 0

    async def stream_fn(*args: Any, **kwargs: Any) -> Any:
        nonlocal call_index
        stream = MockAssistantStream()

        async def run_stream() -> None:
            nonlocal call_index
            await asyncio.sleep(0.005)
            if call_index == 0:
                msg = create_assistant_message(
                    [
                        {
                            "type": "toolCall",
                            "id": "tool-1",
                            "name": "echo",
                            "arguments": {"value": "hello"},
                        }
                    ],
                    "toolUse",
                )
                stream.push({"type": "done", "reason": "toolUse", "message": msg})
            else:
                msg = create_assistant_message([{"type": "text", "text": "done"}])
                stream.push({"type": "done", "reason": "stop", "message": msg})
            call_index += 1

        asyncio.create_task(run_stream())
        return stream

    events = []
    stream = agent_loop([user_prompt], context, config, None, stream_fn)
    async for event in stream:
        events.append(event)

    assert executed == ["hello"]

    tool_start = next((e for e in events if e["type"] == "tool_execution_start"), None)
    tool_end = next((e for e in events if e["type"] == "tool_execution_end"), None)
    assert tool_start is not None
    assert tool_end is not None
    assert tool_end["isError"] is False


@pytest.mark.anyio
async def test_agent_loop_before_tool_call_mutated_args() -> None:
    executed = []

    async def tool_execute(
        toolCallId: str, params: Any, signal: AbortSignal | None, onUpdate: Any
    ) -> Any:
        executed.append(params.get("value"))
        return {
            "content": [{"type": "text", "text": f"echoed: {params['value']}"}],
            "details": {"value": params["value"]},
        }

    echo_tool = DummyTool(
        name="echo",
        description="Echo tool",
        parameters={
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
        execute_func=tool_execute,
    )

    context: AgentContext = {
        "systemPrompt": "",
        "messages": [],
        "tools": [echo_tool],  # type: ignore
    }

    async def before_tool(context: Any, signal: AbortSignal | None) -> Any:
        context["args"]["value"] = "mutated-value"
        return None

    user_prompt = create_user_message("echo something")
    config: AgentLoopConfig = {
        "model": create_model(),
        "convertToLlm": identity_converter,
        "beforeToolCall": before_tool,
    }

    call_index = 0

    async def stream_fn(*args: Any, **kwargs: Any) -> Any:
        nonlocal call_index
        stream = MockAssistantStream()

        async def run_stream() -> None:
            nonlocal call_index
            await asyncio.sleep(0.005)
            if call_index == 0:
                msg = create_assistant_message(
                    [
                        {
                            "type": "toolCall",
                            "id": "tool-1",
                            "name": "echo",
                            "arguments": {"value": "hello"},
                        }
                    ],
                    "toolUse",
                )
                stream.push({"type": "done", "reason": "toolUse", "message": msg})
            else:
                msg = create_assistant_message([{"type": "text", "text": "done"}])
                stream.push({"type": "done", "reason": "stop", "message": msg})
            call_index += 1

        asyncio.create_task(run_stream())
        return stream

    stream = agent_loop([user_prompt], context, config, None, stream_fn)
    async for _ in stream:
        pass

    assert executed == ["mutated-value"]


@pytest.mark.anyio
async def test_agent_loop_parallel_completion_order() -> None:
    first_resolved = False
    parallel_observed = False
    first_done = asyncio.Event()

    async def tool_execute(
        toolCallId: str, params: Any, signal: AbortSignal | None, onUpdate: Any
    ) -> Any:
        nonlocal first_resolved, parallel_observed
        val = params.get("value")
        if val == "first":
            await first_done.wait()
            first_resolved = True
        elif val == "second":
            if not first_resolved:
                parallel_observed = True
        return {
            "content": [{"type": "text", "text": f"echoed: {val}"}],
            "details": {"value": val},
        }

    echo_tool = DummyTool(
        name="echo",
        description="Echo tool",
        parameters={
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
        execute_func=tool_execute,
    )

    context: AgentContext = {
        "systemPrompt": "",
        "messages": [],
        "tools": [echo_tool],  # type: ignore
    }

    user_prompt = create_user_message("echo both")
    config: AgentLoopConfig = {
        "model": create_model(),
        "convertToLlm": identity_converter,
        "toolExecution": "parallel",
    }

    call_index = 0

    async def stream_fn(*args: Any, **kwargs: Any) -> Any:
        nonlocal call_index
        stream = MockAssistantStream()

        async def run_stream() -> None:
            nonlocal call_index
            await asyncio.sleep(0.005)
            if call_index == 0:
                msg = create_assistant_message(
                    [
                        {
                            "type": "toolCall",
                            "id": "tool-1",
                            "name": "echo",
                            "arguments": {"value": "first"},
                        },
                        {
                            "type": "toolCall",
                            "id": "tool-2",
                            "name": "echo",
                            "arguments": {"value": "second"},
                        },
                    ],
                    "toolUse",
                )
                stream.push({"type": "done", "reason": "toolUse", "message": msg})

                async def release() -> None:
                    await asyncio.sleep(0.02)
                    first_done.set()

                asyncio.create_task(release())
            else:
                msg = create_assistant_message([{"type": "text", "text": "done"}])
                stream.push({"type": "done", "reason": "stop", "message": msg})
            call_index += 1

        asyncio.create_task(run_stream())
        return stream

    events = []
    stream = agent_loop([user_prompt], context, config, None, stream_fn)
    async for event in stream:
        events.append(event)

    tool_ends = [e["toolCallId"] for e in events if e["type"] == "tool_execution_end"]
    # Parallel tool-2 should end first because tool-1 waits
    assert parallel_observed
    assert tool_ends == ["tool-2", "tool-1"]

    tool_results = [
        e["message"]["toolCallId"]
        for e in events
        if e["type"] == "message_end" and e["message"]["role"] == "toolResult"
    ]
    # But final toolResult messages must follow the source order (tool-1 then tool-2)
    assert tool_results == ["tool-1", "tool-2"]
