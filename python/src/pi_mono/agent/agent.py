import asyncio
import time
from typing import Any, Callable, Coroutine, List, Union, Set, cast

from pi_mono.ai.types import (
    ImageContent,
    Message,
    Model,
    TextContent,
    ThinkingBudgets,
)
from pi_mono.ai.stream import stream_simple
from pi_mono.utils.abort_signals import AbortSignal, AbortController
from pi_mono.agent.types import (
    AgentContext,
    AgentEvent,
    AgentLoopConfig,
    AgentMessage,
    AgentState,
    AgentTool,
    QueueMode,
    StreamFn,
    ToolExecutionMode,
    Transport,
    BeforeToolCallContext,
    AfterToolCallContext,
)
from pi_mono.agent.agent_loop import (
    run_agent_loop,
    run_agent_loop_continue,
    maybe_await,
)


def default_convert_to_llm(messages: List[AgentMessage]) -> List[Message]:
    return [
        m for m in messages if m.get("role") in ("user", "assistant", "toolResult")
    ]  # type: ignore


EMPTY_USAGE = {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 0,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
}

DEFAULT_MODEL: Model = {
    "id": "unknown",
    "name": "unknown",
    "api": "unknown",
    "provider": "unknown",
    "baseUrl": "",
    "reasoning": False,
    "input": [],
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    "contextWindow": 0,
    "maxTokens": 0,
}


class MutableAgentState:
    def __init__(self, initial_state: dict[str, Any] | None = None) -> None:
        initial = initial_state or {}
        self.systemPrompt: str = initial.get("systemPrompt", "")
        self.model: Model = initial.get("model", DEFAULT_MODEL)
        self.thinkingLevel: Any = initial.get("thinkingLevel", "off")

        self._tools: List[AgentTool] = list(initial.get("tools", []))
        self._messages: List[AgentMessage] = list(initial.get("messages", []))

        self._is_streaming = False
        self._streaming_message: AgentMessage | None = None
        self._pending_tool_calls: Set[str] = set()
        self._error_message: str | None = None

    @property
    def tools(self) -> List[AgentTool]:
        return self._tools

    @tools.setter
    def tools(self, next_tools: List[AgentTool]) -> None:
        self._tools = list(next_tools)

    @property
    def messages(self) -> List[AgentMessage]:
        return self._messages

    @messages.setter
    def messages(self, next_messages: List[AgentMessage]) -> None:
        self._messages = list(next_messages)

    @property
    def isStreaming(self) -> bool:
        return self._is_streaming

    @property
    def streamingMessage(self) -> AgentMessage | None:
        return self._streaming_message

    @property
    def pendingToolCalls(self) -> Set[str]:
        return self._pending_tool_calls

    @property
    def errorMessage(self) -> str | None:
        return self._error_message


class PendingMessageQueue:
    def __init__(self, mode: QueueMode) -> None:
        self.mode: QueueMode = mode
        self._messages: List[AgentMessage] = []

    def enqueue(self, message: AgentMessage) -> None:
        self._messages.append(message)

    def has_items(self) -> bool:
        return len(self._messages) > 0

    def drain(self) -> List[AgentMessage]:
        if self.mode == "all":
            drained = list(self._messages)
            self._messages.clear()
            return drained

        if not self._messages:
            return []

        first = self._messages.pop(0)
        return [first]

    def clear(self) -> None:
        self._messages.clear()


class Agent:
    def __init__(self, options: dict[str, Any] | None = None) -> None:
        opts = options or {}
        self._state = MutableAgentState(opts.get("initialState"))
        self.listeners: Set[Callable[[AgentEvent, AbortSignal], Any]] = set()

        self.convertToLlm: Callable[[list[AgentMessage]], Union[list[Message], Any]] = (
            opts.get("convertToLlm") or default_convert_to_llm
        )
        self.transformContext: Callable[[list[AgentMessage], AbortSignal | None], Any] | None = (
            opts.get("transformContext")
        )
        self.streamFn: StreamFn = opts.get("streamFn") or stream_simple
        self.getApiKey: Callable[[str], Any] | None = opts.get("getApiKey")
        self.onPayload: Callable[[Any, Model], Any] | None = opts.get("onPayload")
        self.onResponse: Callable[[Any, Model], Any] | None = opts.get("onResponse")
        self.beforeToolCall: Callable[[BeforeToolCallContext, AbortSignal | None], Any] | None = (
            opts.get("beforeToolCall")
        )
        self.afterToolCall: Callable[[AfterToolCallContext, AbortSignal | None], Any] | None = (
            opts.get("afterToolCall")
        )
        self.prepareNextTurn: Callable[[AbortSignal | None], Any] | None = opts.get(
            "prepareNextTurn"
        )

        self.steeringQueue = PendingMessageQueue(opts.get("steeringMode") or "one-at-a-time")
        self.followUpQueue = PendingMessageQueue(opts.get("followUpMode") or "one-at-a-time")

        self.sessionId: str | None = opts.get("sessionId")
        self.thinkingBudgets: ThinkingBudgets | None = opts.get("thinkingBudgets")
        self.transport: Transport = opts.get("transport") or "auto"
        self.maxRetryDelayMs: int | None = opts.get("maxRetryDelayMs")
        self.toolExecution: ToolExecutionMode = opts.get("toolExecution") or "parallel"

        self.active_run: dict[str, Any] | None = None

    def subscribe(self, listener: Callable[[AgentEvent, AbortSignal], Any]) -> Callable[[], None]:
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)

    @property
    def state(self) -> AgentState:
        return self._state  # type: ignore

    @property
    def steeringMode(self) -> QueueMode:
        return self.steeringQueue.mode

    @steeringMode.setter
    def steeringMode(self, mode: QueueMode) -> None:
        self.steeringQueue.mode = mode

    @property
    def followUpMode(self) -> QueueMode:
        return self.followUpQueue.mode

    @followUpMode.setter
    def followUpMode(self, mode: QueueMode) -> None:
        self.followUpQueue.mode = mode

    def steer(self, message: AgentMessage) -> None:
        self.steeringQueue.enqueue(message)

    def followUp(self, message: AgentMessage) -> None:
        self.followUpQueue.enqueue(message)

    def clearSteeringQueue(self) -> None:
        self.steeringQueue.clear()

    def clearFollowUpQueue(self) -> None:
        self.followUpQueue.clear()

    def clearAllQueues(self) -> None:
        self.clearSteeringQueue()
        self.clearFollowUpQueue()

    def hasQueuedMessages(self) -> bool:
        return self.steeringQueue.has_items() or self.followUpQueue.has_items()

    @property
    def signal(self) -> AbortSignal | None:
        if self.active_run:
            return self.active_run["abort_controller"].signal
        return None

    def abort(self) -> None:
        if self.active_run:
            self.active_run["abort_controller"].abort()

    async def waitForIdle(self) -> None:
        if self.active_run:
            await self.active_run["future"]

    def reset(self) -> None:
        self._state.messages = []
        self._state._is_streaming = False
        self._state._streaming_message = None
        self._state._pending_tool_calls = set()
        self._state._error_message = None
        self.clearAllQueues()

    async def prompt(
        self,
        input_val: Union[str, AgentMessage, List[AgentMessage]],
        images: List[ImageContent] | None = None,
    ) -> None:
        if self.active_run:
            raise RuntimeError(
                "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."
            )
        messages = self.normalizePromptInput(input_val, images)
        await self.runPromptMessages(messages)

    async def continue_run(self) -> None:
        # Note: continue is a python keyword, renamed to continue_run
        if self.active_run:
            raise RuntimeError(
                "Agent is already processing. Wait for completion before continuing."
            )

        if not self._state.messages:
            raise ValueError("No messages to continue from")

        last_message = self._state.messages[-1]
        if last_message.get("role") == "assistant":
            queued_steering = self.steeringQueue.drain()
            if len(queued_steering) > 0:
                await self.runPromptMessages(queued_steering, skip_initial_steering_poll=True)
                return

            queued_followups = self.followUpQueue.drain()
            if len(queued_followups) > 0:
                await self.runPromptMessages(queued_followups)
                return

            raise ValueError("Cannot continue from message role: assistant")

        await self.runContinuation()

    def normalizePromptInput(
        self,
        input_val: Union[str, AgentMessage, List[AgentMessage]],
        images: List[ImageContent] | None = None,
    ) -> List[AgentMessage]:
        if isinstance(input_val, list):
            return input_val

        if isinstance(input_val, dict):
            return [input_val]

        content: List[Union[TextContent, ImageContent]] = [{"type": "text", "text": input_val}]
        if images:
            content.extend(images)

        return [
            {
                "role": "user",
                "content": content,
                "timestamp": int(time.time() * 1000),
            }
        ]

    async def runPromptMessages(
        self, messages: List[AgentMessage], skip_initial_steering_poll: bool = False
    ) -> None:
        async def execute(signal: AbortSignal) -> None:
            await run_agent_loop(
                messages,
                self.createContextSnapshot(),
                self.createLoopConfig(skip_initial_steering_poll),
                self.processEvents,
                signal,
                self.streamFn,
            )

        await self.runWithLifecycle(execute)

    async def runContinuation(self) -> None:
        async def execute(signal: AbortSignal) -> None:
            await run_agent_loop_continue(
                self.createContextSnapshot(),
                self.createLoopConfig(),
                self.processEvents,
                signal,
                self.streamFn,
            )

        await self.runWithLifecycle(execute)

    def createContextSnapshot(self) -> AgentContext:
        return {
            "systemPrompt": self._state.systemPrompt,
            "messages": list(self._state.messages),
            "tools": list(self._state.tools),
        }

    def createLoopConfig(self, skip_initial_steering_poll: bool = False) -> AgentLoopConfig:
        skip = skip_initial_steering_poll

        async def get_steering() -> List[AgentMessage]:
            nonlocal skip
            if skip:
                skip = False
                return []
            return self.steeringQueue.drain()

        async def get_followup() -> List[AgentMessage]:
            return self.followUpQueue.drain()

        config: AgentLoopConfig = {
            "model": self._state.model,
            "transport": self.transport,
            "toolExecution": self.toolExecution,
            "convertToLlm": self.convertToLlm,
            "getSteeringMessages": get_steering,
            "getFollowUpMessages": get_followup,
        }

        if self.sessionId is not None:
            config["sessionId"] = self.sessionId
        if self.onPayload is not None:
            config["onPayload"] = self.onPayload
        if self.onResponse is not None:
            config["onResponse"] = self.onResponse
        if self.thinkingBudgets is not None:
            config["thinkingBudgets"] = cast(dict[str, int], self.thinkingBudgets)
        if self.maxRetryDelayMs is not None:
            config["maxRetryDelayMs"] = self.maxRetryDelayMs
        if self.beforeToolCall is not None:
            config["beforeToolCall"] = self.beforeToolCall
        if self.afterToolCall is not None:
            config["afterToolCall"] = self.afterToolCall
        if self.transformContext is not None:
            config["transformContext"] = self.transformContext
        if self.getApiKey is not None:
            config["getApiKey"] = self.getApiKey

        if self._state.thinkingLevel != "off":
            config["reasoning"] = self._state.thinkingLevel

        prep_next = self.prepareNextTurn
        if prep_next is not None:

            async def prepare(context: Any) -> Any:
                return await maybe_await(prep_next(self.signal))

            config["prepareNextTurn"] = prepare

        return config

    async def runWithLifecycle(
        self, executor: Callable[[AbortSignal], Coroutine[Any, Any, None]]
    ) -> None:
        if self.active_run:
            raise RuntimeError("Agent is already processing.")

        abort_controller = AbortController()
        loop = asyncio.get_running_loop()
        future = loop.create_future()

        self.active_run = {
            "future": future,
            "abort_controller": abort_controller,
        }

        self._state._is_streaming = True
        self._state._streaming_message = None
        self._state._error_message = None

        try:
            await executor(abort_controller.signal)
        except Exception as error:
            await self.handleRunFailure(error, abort_controller.signal.aborted)
        finally:
            self.finishRun()

    async def handleRunFailure(self, error: Any, aborted: bool) -> None:
        failure_message: AgentMessage = {
            "role": "assistant",
            "content": [{"type": "text", "text": ""}],
            "api": self._state.model.get("api", "unknown"),
            "provider": self._state.model.get("provider", "unknown"),
            "model": self._state.model.get("id", "unknown"),
            "usage": EMPTY_USAGE,
            "stopReason": "aborted" if aborted else "error",
            "errorMessage": str(error),
            "timestamp": int(time.time() * 1000),
        }
        await maybe_await(self.processEvents({"type": "message_start", "message": failure_message}))
        await maybe_await(self.processEvents({"type": "message_end", "message": failure_message}))
        await maybe_await(
            self.processEvents({"type": "turn_end", "message": failure_message, "toolResults": []})
        )
        await maybe_await(self.processEvents({"type": "agent_end", "messages": [failure_message]}))

    def finishRun(self) -> None:
        self._state._is_streaming = False
        self._state._streaming_message = None
        self._state._pending_tool_calls = set()
        if self.active_run:
            if not self.active_run["future"].done():
                self.active_run["future"].set_result(None)
        self.active_run = None

    async def processEvents(self, event: AgentEvent) -> None:
        event_type = event["type"]
        dict_event = cast(dict[str, Any], event)

        if event_type == "message_start":
            self._state._streaming_message = dict_event.get("message")
        elif event_type == "message_update":
            self._state._streaming_message = dict_event.get("message")
        elif event_type == "message_end":
            self._state._streaming_message = None
            msg = dict_event.get("message")
            if msg:
                self._state._messages.append(msg)
        elif event_type == "tool_execution_start":
            tool_call_id = dict_event.get("toolCallId")
            if tool_call_id:
                self._state._pending_tool_calls.add(tool_call_id)
        elif event_type == "tool_execution_end":
            tool_call_id = dict_event.get("toolCallId")
            if tool_call_id:
                self._state._pending_tool_calls.discard(tool_call_id)
        elif event_type == "turn_end":
            msg = dict_event.get("message")
            if msg and msg.get("role") == "assistant" and msg.get("errorMessage"):
                self._state._error_message = msg["errorMessage"]
        elif event_type == "agent_end":
            self._state._streaming_message = None

        signal = self.signal
        if not signal:
            raise RuntimeError("Agent listener invoked outside active run")

        listeners = list(self.listeners)
        if listeners:
            await asyncio.gather(*(maybe_await(listener(event, signal)) for listener in listeners))
