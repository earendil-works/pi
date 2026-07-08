"""Extension system types."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypedDict

from pi_mono.agent.types import AgentMessage, AgentToolResult, ThinkingLevel
from pi_mono.ai.types import ImageContent, Model
from pi_mono.coding_agent.core.bash_executor import BashResult
from pi_mono.coding_agent.core.slash_commands import SlashCommandInfo
from pi_mono.coding_agent.core.source_info import SourceInfo
from pi_mono.core.event_bus import EventBusController
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager

ExtensionMode = Literal["tui", "rpc", "json", "print"]
HandlerFn = Callable[..., Awaitable[Any] | Any]
ExtensionFactory = Callable[["ExtensionAPI"], Awaitable[None] | None]
ExtensionHandler = Callable[[Any, "ExtensionContext"], Awaitable[Any] | Any]


class ContextUsage(TypedDict):
    tokens: int | None
    contextWindow: int
    percent: float | None


class CompactOptions(TypedDict, total=False):
    customInstructions: str
    onComplete: Callable[[Any], None]
    onError: Callable[[Exception], None]


class ResourcesDiscoverEvent(TypedDict):
    type: Literal["resources_discover"]
    cwd: str
    reason: Literal["startup", "reload"]


class ResourcesDiscoverResult(TypedDict, total=False):
    skillPaths: list[str]
    promptPaths: list[str]
    themePaths: list[str]


class SessionStartEvent(TypedDict, total=False):
    type: Literal["session_start"]
    reason: Literal["startup", "reload", "new", "resume", "fork"]
    previousSessionFile: str


class SessionShutdownEvent(TypedDict, total=False):
    type: Literal["session_shutdown"]
    reason: Literal["quit", "reload", "new", "resume", "fork"]
    targetSessionFile: str


class ContextEvent(TypedDict):
    type: Literal["context"]
    messages: list[AgentMessage]


class ContextEventResult(TypedDict, total=False):
    messages: list[AgentMessage]


class InputEvent(TypedDict, total=False):
    type: Literal["input"]
    text: str
    images: list[ImageContent]
    source: Literal["interactive", "rpc", "extension"]
    streamingBehavior: Literal["steer", "followUp"]


class InputEventResult(TypedDict, total=False):
    action: Literal["continue", "transform", "handled"]
    text: str
    images: list[ImageContent]


class ToolCallEventResult(TypedDict, total=False):
    block: bool
    reason: str


class ToolResultEventResult(TypedDict, total=False):
    content: list[dict[str, Any]]
    details: Any
    isError: bool


class UserBashEvent(TypedDict):
    type: Literal["user_bash"]
    command: str
    excludeFromContext: bool
    cwd: str


class UserBashEventResult(TypedDict, total=False):
    operations: Any
    result: BashResult


class ProviderConfig(TypedDict, total=False):
    name: str
    baseUrl: str
    apiKey: str
    api: str
    headers: dict[str, str]
    authHeader: bool
    models: list[dict[str, Any]]


@dataclass
class ExtensionFlag:
    name: str
    extension_path: str
    description: str | None = None
    type: Literal["boolean", "string"] = "boolean"
    default: bool | str | None = None


@dataclass
class ExtensionShortcut:
    shortcut: str
    extension_path: str
    description: str | None = None
    handler: Callable[["ExtensionContext"], Awaitable[None] | None] | None = None


@dataclass
class RegisteredCommand:
    name: str
    source_info: SourceInfo
    handler: Callable[[str, "ExtensionCommandContext"], Awaitable[None]]
    description: str | None = None


@dataclass
class ResolvedCommand(RegisteredCommand):
    invocation_name: str = ""


@dataclass
class ToolDefinition:
    name: str
    label: str
    description: str
    parameters: dict[str, Any]
    execute: Callable[..., Awaitable[AgentToolResult[Any]]]
    prompt_snippet: str | None = None
    prompt_guidelines: list[str] | None = None


@dataclass
class RegisteredTool:
    definition: ToolDefinition
    source_info: SourceInfo


@dataclass
class Extension:
    path: str
    resolved_path: str
    source_info: SourceInfo
    handlers: dict[str, list[HandlerFn]] = field(default_factory=dict)
    tools: dict[str, RegisteredTool] = field(default_factory=dict)
    message_renderers: dict[str, Callable[..., Any]] = field(default_factory=dict)
    commands: dict[str, RegisteredCommand] = field(default_factory=dict)
    flags: dict[str, ExtensionFlag] = field(default_factory=dict)
    shortcuts: dict[str, ExtensionShortcut] = field(default_factory=dict)


@dataclass
class ExtensionError:
    extension_path: str
    event: str
    error: str
    stack: str | None = None


class ExtensionUIContext(Protocol):
    async def select(
        self, title: str, options: list[str], opts: dict[str, Any] | None = None
    ) -> str | None: ...
    async def confirm(
        self, title: str, message: str, opts: dict[str, Any] | None = None
    ) -> bool: ...
    async def input(
        self, title: str, placeholder: str | None = None, opts: dict[str, Any] | None = None
    ) -> str | None: ...
    def notify(
        self, message: str, type: Literal["info", "warning", "error"] | None = None
    ) -> None: ...


class ExtensionContext(Protocol):
    @property
    def ui(self) -> ExtensionUIContext: ...
    @property
    def mode(self) -> ExtensionMode: ...
    @property
    def has_ui(self) -> bool: ...
    @property
    def cwd(self) -> str: ...
    @property
    def session_manager(self) -> SessionManager: ...
    @property
    def model_registry(self) -> ModelRegistry: ...
    @property
    def model(self) -> Model[Any] | None: ...
    def is_idle(self) -> bool: ...
    @property
    def signal(self) -> Any: ...
    def abort(self) -> None: ...
    def has_pending_messages(self) -> bool: ...
    def shutdown(self) -> None: ...
    def get_context_usage(self) -> ContextUsage | None: ...
    def compact(self, options: CompactOptions | None = None) -> None: ...
    def get_system_prompt(self) -> str: ...


class ExtensionCommandContext(ExtensionContext, Protocol):
    def get_system_prompt_options(self) -> dict[str, Any]: ...
    async def wait_for_idle(self) -> None: ...
    async def new_session(self, options: dict[str, Any] | None = None) -> dict[str, bool]: ...
    async def fork(
        self, entry_id: str, options: dict[str, Any] | None = None
    ) -> dict[str, bool]: ...
    async def navigate_tree(
        self, target_id: str, options: dict[str, Any] | None = None
    ) -> dict[str, bool]: ...
    async def switch_session(
        self, session_path: str, options: dict[str, Any] | None = None
    ) -> dict[str, bool]: ...
    async def reload(self) -> None: ...


class ExtensionAPI(Protocol):
    def on(self, event: str, handler: ExtensionHandler) -> None: ...
    def register_tool(self, tool: ToolDefinition) -> None: ...
    def register_command(self, name: str, options: dict[str, Any]) -> None: ...
    def register_shortcut(self, shortcut: str, options: dict[str, Any]) -> None: ...
    def register_flag(self, name: str, options: dict[str, Any]) -> None: ...
    def register_message_renderer(self, custom_type: str, renderer: Any) -> None: ...
    def get_flag(self, name: str) -> bool | str | None: ...
    def send_message(
        self, message: dict[str, Any], options: dict[str, Any] | None = None
    ) -> None: ...
    def send_user_message(
        self, content: str | list[dict[str, Any]], options: dict[str, Any] | None = None
    ) -> None: ...
    def append_entry(self, custom_type: str, data: Any = None) -> None: ...
    def set_session_name(self, name: str) -> None: ...
    def get_session_name(self) -> str | None: ...
    def set_label(self, entry_id: str, label: str | None) -> None: ...
    async def exec(
        self, command: str, args: list[str], options: dict[str, Any] | None = None
    ) -> Any: ...
    def get_active_tools(self) -> list[str]: ...
    def get_all_tools(self) -> list[dict[str, Any]]: ...
    def set_active_tools(self, tool_names: list[str]) -> None: ...
    def get_commands(self) -> list[SlashCommandInfo]: ...
    async def set_model(self, model: Model[Any]) -> bool: ...
    def get_thinking_level(self) -> ThinkingLevel: ...
    def set_thinking_level(self, level: ThinkingLevel) -> None: ...
    def register_provider(self, name: str, config: ProviderConfig) -> None: ...
    def unregister_provider(self, name: str) -> None: ...
    @property
    def events(self) -> EventBusController: ...


@dataclass
class ExtensionRuntime:
    flag_values: dict[str, bool | str] = field(default_factory=dict)
    pending_provider_registrations: list[dict[str, Any]] = field(default_factory=list)
    send_message: Callable[..., None] = field(default=lambda *_a, **_k: None)
    send_user_message: Callable[..., None] = field(default=lambda *_a, **_k: None)
    append_entry: Callable[..., None] = field(default=lambda *_a, **_k: None)
    set_session_name: Callable[[str], None] = field(default=lambda *_a: None)
    get_session_name: Callable[[], str | None] = field(default=lambda: None)
    set_label: Callable[[str, str | None], None] = field(default=lambda *_a: None)
    get_active_tools: Callable[[], list[str]] = field(default=list)
    get_all_tools: Callable[[], list[dict[str, Any]]] = field(default=list)
    set_active_tools: Callable[[list[str]], None] = field(default=lambda *_a: None)
    refresh_tools: Callable[[], None] = field(default=lambda: None)
    get_commands: Callable[[], list[SlashCommandInfo]] = field(default=list)
    set_model: Callable[[Model[Any]], Awaitable[bool]] = field(default=lambda *_a: _async_false())
    get_thinking_level: Callable[[], ThinkingLevel] = field(default=lambda: "off")
    set_thinking_level: Callable[[ThinkingLevel], None] = field(default=lambda *_a: None)
    _stale_message: str | None = field(default=None, repr=False)

    def assert_active(self) -> None:
        if self._stale_message:
            raise RuntimeError(self._stale_message)

    def invalidate(self, message: str | None = None) -> None:
        if self._stale_message is None:
            self._stale_message = message or (
                "This extension ctx is stale after session replacement or reload."
            )

    def register_provider(
        self, name: str, config: ProviderConfig, extension_path: str = "<unknown>"
    ) -> None:
        self.pending_provider_registrations.append(
            {"name": name, "config": config, "extensionPath": extension_path}
        )

    def unregister_provider(self, name: str, extension_path: str | None = None) -> None:
        del extension_path
        self.pending_provider_registrations = [
            item for item in self.pending_provider_registrations if item.get("name") != name
        ]


async def _async_false() -> bool:
    return False


@dataclass
class ProjectTrustEvent:
    type: Literal["project_trust"]
    cwd: str


@dataclass
class ProjectTrustEventResult:
    trusted: Literal["yes", "no", "undecided"]
    remember: bool | None = None


@dataclass
class LoadExtensionsResult:
    extensions: list[Extension]
    errors: list[dict[str, str]]
    runtime: ExtensionRuntime


@dataclass
class ExtensionActions:
    send_message: Callable[..., None]
    send_user_message: Callable[..., None]
    append_entry: Callable[..., None]
    set_session_name: Callable[[str], None]
    get_session_name: Callable[[], str | None]
    set_label: Callable[[str, str | None], None]
    get_active_tools: Callable[[], list[str]]
    get_all_tools: Callable[[], list[dict[str, Any]]]
    set_active_tools: Callable[[list[str]], None]
    refresh_tools: Callable[[], None]
    get_commands: Callable[[], list[SlashCommandInfo]]
    set_model: Callable[[Model[Any]], Awaitable[bool]]
    get_thinking_level: Callable[[], ThinkingLevel]
    set_thinking_level: Callable[[ThinkingLevel], None]


@dataclass
class ExtensionContextActions:
    get_model: Callable[[], Model[Any] | None]
    is_idle: Callable[[], bool]
    get_signal: Callable[[], Any]
    abort: Callable[[], None]
    has_pending_messages: Callable[[], bool]
    shutdown: Callable[[], None]
    get_context_usage: Callable[[], ContextUsage | None]
    compact: Callable[[CompactOptions | None], None]
    get_system_prompt: Callable[[], str]
    get_system_prompt_options: Callable[[], dict[str, Any]] | None = None


@dataclass
class ExtensionCommandContextActions:
    wait_for_idle: Callable[[], Awaitable[None]]
    new_session: Callable[[dict[str, Any] | None], Awaitable[dict[str, bool]]]
    fork: Callable[[str, dict[str, Any] | None], Awaitable[dict[str, bool]]]
    navigate_tree: Callable[[str, dict[str, Any] | None], Awaitable[dict[str, bool]]]
    switch_session: Callable[[str, dict[str, Any] | None], Awaitable[dict[str, bool]]]
    reload: Callable[[], Awaitable[None]]


def define_tool(tool: ToolDefinition) -> ToolDefinition:
    return tool
