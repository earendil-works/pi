from typing import Any, Callable, Literal, TypedDict, Union

from pi_mono.utils.diagnostics import AssistantMessageDiagnostic

KnownApi = Literal[
    "openai-completions",
    "mistral-conversations",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-vertex",
]

Api = Union[KnownApi, str]

KnownImagesApi = Literal["openrouter-images"]

ImagesApi = Union[KnownImagesApi, str]

KnownProvider = Literal[
    "amazon-bedrock",
    "ant-ling",
    "anthropic",
    "google",
    "google-vertex",
    "openai",
    "azure-openai-responses",
    "openai-codex",
    "nvidia",
    "deepseek",
    "github-copilot",
    "xai",
    "groq",
    "cerebras",
    "openrouter",
    "vercel-ai-gateway",
    "zai",
    "zai-coding-cn",
    "mistral",
    "minimax",
    "minimax-cn",
    "moonshotai",
    "moonshotai-cn",
    "huggingface",
    "fireworks",
    "together",
    "opencode",
    "opencode-go",
    "kimi-coding",
    "cloudflare-workers-ai",
    "cloudflare-ai-gateway",
    "xiaomi",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-ams",
    "xiaomi-token-plan-sgp",
    "cursor",
]

Provider = Union[KnownProvider, str]

ProviderEnv = dict[str, str]

KnownImagesProvider = Literal["openrouter"]

ImagesProvider = Union[KnownImagesProvider, str]

ThinkingLevel = Literal["minimal", "low", "medium", "high", "xhigh"]
ModelThinkingLevel = Literal["off", "minimal", "low", "medium", "high", "xhigh"]

ThinkingLevelMap = dict[ModelThinkingLevel, Union[str, None]]


class ThinkingBudgets(TypedDict, total=False):
    minimal: int
    low: int
    medium: int
    high: int


class ModelCost(TypedDict):
    input: float
    output: float
    cacheRead: float
    cacheWrite: float


Transport = Literal["sse", "websocket", "websocket-cached", "auto"]


class OpenAIResponsesCompat(TypedDict, total=False):
    """Compatibility settings for OpenAI Responses APIs."""

    sendSessionIdHeader: bool
    supportsLongCacheRetention: bool


class Model(TypedDict, total=False):
    id: str
    name: str
    api: Api
    provider: Provider
    baseUrl: str
    reasoning: bool
    input: list[Literal["text", "image"]]
    cost: ModelCost
    contextWindow: int
    maxTokens: int
    thinkingLevelMap: ThinkingLevelMap
    compat: dict[str, Any]
    headers: dict[str, str]


class ImagesModel(TypedDict, total=False):
    id: str
    name: str
    api: ImagesApi
    provider: ImagesProvider
    baseUrl: str
    input: list[Literal["text", "image"]]
    output: list[Literal["text", "image"]]
    cost: ModelCost
    headers: dict[str, str]


class CostBreakdown(TypedDict):
    input: float
    output: float
    cacheRead: float
    cacheWrite: float
    total: float


class Usage(TypedDict):
    input: int
    output: int
    cacheRead: int
    cacheWrite: int
    totalTokens: int
    cost: CostBreakdown


class TextContent(TypedDict, total=False):
    type: Literal["text"]
    text: str
    textSignature: str


class ThinkingContent(TypedDict, total=False):
    type: Literal["thinking"]
    thinking: str
    thinkingSignature: str
    redacted: bool


class ImageContent(TypedDict):
    type: Literal["image"]
    data: str  # base64 encoded image data
    mimeType: str


class ToolCall(TypedDict, total=False):
    type: Literal["toolCall"]
    id: str
    name: str
    arguments: dict[str, Any]
    thoughtSignature: str


class TextSignatureV1(TypedDict, total=False):
    v: Literal[1]
    id: str
    phase: Literal["commentary", "final_answer"] | None


StopReason = Literal["stop", "length", "toolUse", "error", "aborted"]


class AssistantMessage(TypedDict, total=False):
    role: Literal["assistant"]
    content: list[Union[TextContent, ThinkingContent, ToolCall]]
    api: Api
    provider: Provider
    model: str
    responseModel: str
    responseId: str
    diagnostics: list[AssistantMessageDiagnostic]
    usage: Usage
    stopReason: StopReason
    errorMessage: str
    timestamp: int  # Unix timestamp in milliseconds


class AssistantMessageEventStart(TypedDict):
    type: Literal["start"]
    partial: AssistantMessage


class AssistantMessageEventContentIndex(TypedDict, total=False):
    type: Literal[
        "text_start",
        "text_delta",
        "text_end",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
    ]
    contentIndex: int
    delta: str
    content: str
    toolCall: ToolCall
    partial: AssistantMessage


class AssistantMessageEventDone(TypedDict):
    type: Literal["done"]
    reason: Literal["stop", "length", "toolUse"]
    message: AssistantMessage


class AssistantMessageEventError(TypedDict):
    type: Literal["error"]
    reason: Literal["aborted", "error"]
    error: AssistantMessage


AssistantMessageEvent = Union[
    AssistantMessageEventStart,
    AssistantMessageEventContentIndex,
    AssistantMessageEventDone,
    AssistantMessageEventError,
]


class Tool(TypedDict, total=False):
    name: str
    description: str
    parameters: dict[str, Any]


class Context(TypedDict, total=False):
    systemPrompt: str
    messages: list[Any]
    tools: list[Tool]


class StreamOptions(TypedDict, total=False):
    temperature: float
    maxTokens: int
    signal: Any
    apiKey: str
    transport: str
    cacheRetention: str
    sessionId: str
    onPayload: Callable[[Any, Model], Any]
    onResponse: Callable[[Any, Model], Any]
    headers: dict[str, str]
    timeoutMs: int
    websocketConnectTimeoutMs: int
    maxRetries: int
    maxRetryDelayMs: int


class SimpleStreamOptions(StreamOptions, total=False):
    reasoning: str
    thinkingBudgets: dict[str, int]


class UserMessage(TypedDict, total=False):
    role: Literal["user"]
    content: Union[str, list[Union[TextContent, ImageContent]]]
    timestamp: int


class ToolResultMessage(TypedDict, total=False):
    role: Literal["toolResult"]
    toolCallId: str
    toolName: str
    content: list[Union[TextContent, ImageContent]]
    details: Any
    isError: bool
    timestamp: int


Message = Union[UserMessage, AssistantMessage, ToolResultMessage]

ImagesInputContent = Union[TextContent, ImageContent]
ImagesOutputContent = Union[TextContent, ImageContent]


class ImagesContext(TypedDict, total=False):
    input: list[ImagesInputContent]


class ImagesOptions(TypedDict, total=False):
    temperature: float
    maxTokens: int
    signal: Any
    apiKey: str
    transport: str
    cacheRetention: str
    sessionId: str
    onPayload: Callable[[Any, ImagesModel], Any]
    onResponse: Callable[[Any, ImagesModel], Any]
    headers: dict[str, str]
    timeoutMs: int
    websocketConnectTimeoutMs: int
    maxRetries: int
    maxRetryDelayMs: int


ImagesFunction = Callable[
    [ImagesModel, ImagesContext, ImagesOptions | None],
    Any,  # Awaitable[AssistantImages]
]


ImagesStopReason = Literal["stop", "error", "aborted"]


class AssistantImages(TypedDict, total=False):
    api: ImagesApi
    provider: ImagesProvider
    model: str
    output: list[ImagesOutputContent]
    usage: Usage
    stopReason: ImagesStopReason
    errorMessage: str
    responseId: str
    responseModel: str
    timestamp: int
