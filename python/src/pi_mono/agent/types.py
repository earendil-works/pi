"""Agent types - core agent interfaces and events.

Ported from TypeScript's packages/agent/src/types.ts
"""

from __future__ import annotations

import asyncio
import inspect
from typing import (
    Any,
    Callable,
    Coroutine,
    Literal,
    Protocol,
    Set,
    TypedDict,
    Union,
)

from pi_mono.ai.types import (
    AssistantMessage,
    AssistantMessageEvent,
    ImageContent,
    Message,
    Model,
    SimpleStreamOptions,
    TextContent,
    ToolResultMessage,
)
from pi_mono.utils.abort_signals import AbortSignal


# =============================================================================
# Stream Function
# =============================================================================

StreamFn = Callable[..., Union[Coroutine[Any, Any, Any], Any]]


# =============================================================================
# Execution & Queue Modes
# =============================================================================

ToolExecutionMode = Literal["sequential", "parallel"]
QueueMode = Literal["all", "one-at-a-time"]

ThinkingLevel = Literal["off", "minimal", "low", "medium", "high", "xhigh"]
AgentThinkingLevel = ThinkingLevel

Transport = Literal["sse", "websocket", "websocket-cached", "auto"]


# =============================================================================
# Tool Call & Hook Results
# =============================================================================


class AgentToolCall(TypedDict):
    type: Literal["toolCall"]
    id: str
    name: str
    arguments: dict[str, Any]


class BeforeToolCallResult(TypedDict, total=False):
    block: bool
    reason: str


class AfterToolCallResult(TypedDict, total=False):
    content: list[Union[TextContent, ImageContent]]
    details: Any
    isError: bool
    terminate: bool


class AgentToolResult(TypedDict, total=False):
    content: list[Union[TextContent, ImageContent]]
    details: Any
    terminate: bool


# =============================================================================
# Context Types
# =============================================================================


class AgentContext(TypedDict, total=False):
    systemPrompt: str
    messages: list["AgentMessage"]
    tools: list["AgentTool"]


class BeforeToolCallContext(TypedDict):
    assistantMessage: AssistantMessage
    toolCall: AgentToolCall
    args: Any
    context: AgentContext


class AfterToolCallContext(TypedDict):
    assistantMessage: AssistantMessage
    toolCall: AgentToolCall
    args: Any
    result: AgentToolResult
    isError: bool
    context: AgentContext


class ShouldStopAfterTurnContext(TypedDict):
    message: AssistantMessage
    toolResults: list[ToolResultMessage]
    context: AgentContext
    newMessages: list["AgentMessage"]


class PrepareNextTurnContext(ShouldStopAfterTurnContext):
    pass


class AgentLoopTurnUpdate(TypedDict, total=False):
    context: AgentContext
    model: Model[Any]
    thinkingLevel: AgentThinkingLevel


# =============================================================================
# Agent Tool & State
# =============================================================================

AgentToolUpdateCallback = Callable[[AgentToolResult], None]


class AgentTool(Protocol):
    name: str
    description: str
    parameters: dict[str, Any]
    label: str
    executionMode: ToolExecutionMode | None

    def execute(
        self,
        toolCallId: str,
        params: Any,
        signal: AbortSignal | None = None,
        onUpdate: AgentToolUpdateCallback | None = None,
    ) -> Coroutine[Any, Any, AgentToolResult]: ...


class AgentState(Protocol):
    systemPrompt: str
    model: Model[Any]
    thinkingLevel: AgentThinkingLevel

    @property
    def tools(self) -> list[AgentTool]: ...
    @tools.setter
    def tools(self, next_tools: list[AgentTool]) -> None: ...

    @property
    def messages(self) -> list["AgentMessage"]: ...
    @messages.setter
    def messages(self, next_messages: list["AgentMessage"]) -> None: ...

    @property
    def isStreaming(self) -> bool: ...
    @property
    def streamingMessage(self) -> "AgentMessage | None": ...
    @property
    def pendingToolCalls(self) -> Set[str]: ...
    @property
    def errorMessage(self) -> str | None: ...


# =============================================================================
# Agent Events
# =============================================================================


class AgentEventAgentStart(TypedDict):
    type: Literal["agent_start"]


class AgentEventAgentEnd(TypedDict):
    type: Literal["agent_end"]
    messages: list["AgentMessage"]


class AgentEventTurnStart(TypedDict):
    type: Literal["turn_start"]


class AgentEventTurnEnd(TypedDict):
    type: Literal["turn_end"]
    message: "AgentMessage"
    toolResults: list[ToolResultMessage]


class AgentEventMessageStart(TypedDict):
    type: Literal["message_start"]
    message: "AgentMessage"


class AgentEventMessageUpdate(TypedDict):
    type: Literal["message_update"]
    message: "AgentMessage"
    assistantMessageEvent: AssistantMessageEvent


class AgentEventMessageEnd(TypedDict):
    type: Literal["message_end"]
    message: "AgentMessage"


class AgentEventToolExecutionStart(TypedDict):
    type: Literal["tool_execution_start"]
    toolCallId: str
    toolName: str
    args: Any


class AgentEventToolExecutionUpdate(TypedDict):
    type: Literal["tool_execution_update"]
    toolCallId: str
    toolName: str
    args: Any
    partialResult: Any


class AgentEventToolExecutionEnd(TypedDict):
    type: Literal["tool_execution_end"]
    toolCallId: str
    toolName: str
    result: Any
    isError: bool


AgentEvent = Union[
    AgentEventAgentStart,
    AgentEventAgentEnd,
    AgentEventTurnStart,
    AgentEventTurnEnd,
    AgentEventMessageStart,
    AgentEventMessageUpdate,
    AgentEventMessageEnd,
    AgentEventToolExecutionStart,
    AgentEventToolExecutionUpdate,
    AgentEventToolExecutionEnd,
]


# =============================================================================
# Agent Loop Config
# =============================================================================


class AgentLoopConfig(SimpleStreamOptions, total=False):
    model: Model[Any]
    reasoning: str | None  # corresponds to thinkingLevel
    convertToLlm: Callable[
        [list["AgentMessage"]], Union[list[Message], Coroutine[Any, Any, list[Message]]]
    ]
    transformContext: (
        Callable[
            [list["AgentMessage"], AbortSignal | None],
            Union[list["AgentMessage"], Coroutine[Any, Any, list["AgentMessage"]]],
        ]
        | None
    )
    getApiKey: Callable[[str], Union[str | None, Coroutine[Any, Any, str | None]]] | None
    shouldStopAfterTurn: (
        Callable[[ShouldStopAfterTurnContext], Union[bool, Coroutine[Any, Any, bool]]] | None
    )
    prepareNextTurn: (
        Callable[
            [PrepareNextTurnContext],
            Union[AgentLoopTurnUpdate | None, Coroutine[Any, Any, AgentLoopTurnUpdate | None]],
        ]
        | None
    )
    getSteeringMessages: (
        Callable[[], Union[list["AgentMessage"], Coroutine[Any, Any, list["AgentMessage"]]]] | None
    )
    getFollowUpMessages: (
        Callable[[], Union[list["AgentMessage"], Coroutine[Any, Any, list["AgentMessage"]]]] | None
    )
    toolExecution: ToolExecutionMode
    beforeToolCall: (
        Callable[
            [BeforeToolCallContext, AbortSignal | None],
            Union[BeforeToolCallResult | None, Coroutine[Any, Any, BeforeToolCallResult | None]],
        ]
        | None
    )
    afterToolCall: (
        Callable[
            [AfterToolCallContext, AbortSignal | None],
            Union[AfterToolCallResult | None, Coroutine[Any, Any, AfterToolCallResult | None]],
        ]
        | None
    )


# =============================================================================
# Agent Message (union type - kept as Any for flexibility)
# =============================================================================

AgentMessage = Any


# =============================================================================
# Utility Functions
# =============================================================================


async def maybe_await(val: Any) -> Any:
    """Await if val is awaitable, otherwise return as-is."""
    if asyncio.isfuture(val) or inspect.iscoroutine(val):
        return await val
    if hasattr(val, "__await__"):
        return await val
    return val
