"""RPC protocol types for headless operation.

Ported from packages/coding-agent/src/modes/rpc/rpc-types.ts.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

from pi_mono.agent.types import ThinkingLevel
from pi_mono.ai.types import ImageContent, Model

RpcSteeringMode = Literal["all", "one-at-a-time"]
RpcFollowUpMode = Literal["all", "one-at-a-time"]


class RpcSlashCommand(TypedDict, total=False):
    name: str
    description: str
    source: Literal["extension", "prompt", "skill"]
    sourceInfo: dict[str, Any]


class RpcSessionState(TypedDict, total=False):
    model: Model[Any] | None
    thinkingLevel: ThinkingLevel
    isStreaming: bool
    isCompacting: bool
    steeringMode: RpcSteeringMode
    followUpMode: RpcFollowUpMode
    sessionFile: str | None
    sessionId: str
    sessionName: str | None
    autoCompactionEnabled: bool
    messageCount: int
    pendingMessageCount: int


class RpcResponseSuccess(TypedDict, total=False):
    id: str | None
    type: Literal["response"]
    command: str
    success: bool
    data: Any


class RpcResponseError(TypedDict, total=False):
    id: str | None
    type: Literal["response"]
    command: str
    success: Literal[False]
    error: str


RpcResponse = Union[RpcResponseSuccess, RpcResponseError]


class RpcPromptCommand(TypedDict, total=False):
    id: str | None
    type: Literal["prompt"]
    message: str
    images: list[ImageContent]
    streamingBehavior: Literal["steer", "followUp"]


class RpcAbortCommand(TypedDict, total=False):
    id: str | None
    type: Literal["abort"]


class RpcNewSessionCommand(TypedDict, total=False):
    id: str | None
    type: Literal["new_session"]
    parentSession: str


class RpcGetStateCommand(TypedDict, total=False):
    id: str | None
    type: Literal["get_state"]


class RpcSetModelCommand(TypedDict, total=False):
    id: str | None
    type: Literal["set_model"]
    provider: str
    modelId: str


class RpcGetAvailableModelsCommand(TypedDict, total=False):
    id: str | None
    type: Literal["get_available_models"]


class RpcSetThinkingLevelCommand(TypedDict, total=False):
    id: str | None
    type: Literal["set_thinking_level"]
    level: ThinkingLevel


class RpcGetMessagesCommand(TypedDict, total=False):
    id: str | None
    type: Literal["get_messages"]


class RpcGetCommandsCommand(TypedDict, total=False):
    id: str | None
    type: Literal["get_commands"]


class RpcSteerCommand(TypedDict, total=False):
    id: str | None
    type: Literal["steer"]
    message: str
    images: list[ImageContent]


class RpcFollowUpCommand(TypedDict, total=False):
    id: str | None
    type: Literal["follow_up"]
    message: str
    images: list[ImageContent]


class RpcCycleModelCommand(TypedDict, total=False):
    id: str | None
    type: Literal["cycle_model"]


class RpcCycleThinkingLevelCommand(TypedDict, total=False):
    id: str | None
    type: Literal["cycle_thinking_level"]


class RpcSetSteeringModeCommand(TypedDict, total=False):
    id: str | None
    type: Literal["set_steering_mode"]
    mode: RpcSteeringMode


class RpcSetFollowUpModeCommand(TypedDict, total=False):
    id: str | None
    type: Literal["set_follow_up_mode"]
    mode: RpcFollowUpMode


class RpcCompactCommand(TypedDict, total=False):
    id: str | None
    type: Literal["compact"]
    customInstructions: str


class RpcBashCommand(TypedDict, total=False):
    id: str | None
    type: Literal["bash"]
    command: str
    excludeFromContext: bool


class RpcGetSessionStatsCommand(TypedDict, total=False):
    id: str | None
    type: Literal["get_session_stats"]


class RpcGetLastAssistantTextCommand(TypedDict, total=False):
    id: str | None
    type: Literal["get_last_assistant_text"]


class RpcSetSessionNameCommand(TypedDict, total=False):
    id: str | None
    type: Literal["set_session_name"]
    name: str


class RpcForkCommand(TypedDict, total=False):
    id: str | None
    type: Literal["fork"]
    entryId: str


class RpcSwitchSessionCommand(TypedDict, total=False):
    id: str | None
    type: Literal["switch_session"]
    sessionPath: str


class RpcGetForkMessagesCommand(TypedDict, total=False):
    id: str | None
    type: Literal["get_fork_messages"]


RpcCommand = Union[
    RpcPromptCommand,
    RpcSteerCommand,
    RpcFollowUpCommand,
    RpcAbortCommand,
    RpcNewSessionCommand,
    RpcGetStateCommand,
    RpcSetModelCommand,
    RpcCycleModelCommand,
    RpcGetAvailableModelsCommand,
    RpcSetThinkingLevelCommand,
    RpcCycleThinkingLevelCommand,
    RpcSetSteeringModeCommand,
    RpcSetFollowUpModeCommand,
    RpcCompactCommand,
    RpcBashCommand,
    RpcGetSessionStatsCommand,
    RpcGetLastAssistantTextCommand,
    RpcSetSessionNameCommand,
    RpcForkCommand,
    RpcSwitchSessionCommand,
    RpcGetForkMessagesCommand,
    RpcGetMessagesCommand,
    RpcGetCommandsCommand,
    dict[str, Any],
]

RpcCommandType = str


# =============================================================================
# Extension UI Events (stdout)
# =============================================================================


class RpcExtensionUISelectRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["select"]
    title: str
    options: list[str]
    timeout: int


class RpcExtensionUIConfirmRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["confirm"]
    title: str
    message: str
    timeout: int


class RpcExtensionUIInputRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["input"]
    title: str
    placeholder: str
    timeout: int


class RpcExtensionUIEditorRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["editor"]
    title: str
    prefill: str


class RpcExtensionUINotifyRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["notify"]
    message: str
    notifyType: Literal["info", "warning", "error"]


class RpcExtensionUISetStatusRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["setStatus"]
    statusKey: str
    statusText: str | None


class RpcExtensionUISetWidgetRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["setWidget"]
    widgetKey: str
    widgetLines: list[str] | None
    widgetPlacement: Literal["aboveEditor", "belowEditor"]


class RpcExtensionUISetTitleRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["setTitle"]
    title: str


class RpcExtensionUISetEditorTextRequest(TypedDict, total=False):
    type: Literal["extension_ui_request"]
    id: str
    method: Literal["set_editor_text"]
    text: str


RpcExtensionUIRequest = Union[
    RpcExtensionUISelectRequest,
    RpcExtensionUIConfirmRequest,
    RpcExtensionUIInputRequest,
    RpcExtensionUIEditorRequest,
    RpcExtensionUINotifyRequest,
    RpcExtensionUISetStatusRequest,
    RpcExtensionUISetWidgetRequest,
    RpcExtensionUISetTitleRequest,
    RpcExtensionUISetEditorTextRequest,
    dict[str, Any],
]


# =============================================================================
# Extension UI Commands (stdin)
# =============================================================================


class RpcExtensionUIValueResponse(TypedDict):
    type: Literal["extension_ui_response"]
    id: str
    value: str


class RpcExtensionUIConfirmedResponse(TypedDict):
    type: Literal["extension_ui_response"]
    id: str
    confirmed: bool


class RpcExtensionUICancelledResponse(TypedDict):
    type: Literal["extension_ui_response"]
    id: str
    cancelled: Literal[True]


RpcExtensionUIResponse = Union[
    RpcExtensionUIValueResponse,
    RpcExtensionUIConfirmedResponse,
    RpcExtensionUICancelledResponse,
    dict[str, Any],
]
