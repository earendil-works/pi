"""Agent harness types and utilities."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generic, Literal, TypeVar, Union, TypedDict

from pi_mono.ai.types import (
    ImageContent,
    Model,
    TextContent,
    Transport,
)
from pi_mono.agent.types import (
    AgentEvent,
    AgentMessage,
    AgentTool,
    QueueMode,
    ThinkingLevel,
)
from pi_mono.utils.abort_signals import AbortSignal


# =============================================================================
# Result Type (Functional Error Handling)
# =============================================================================

TValue = TypeVar("TValue")
TError = TypeVar("TError")
TMetadata = TypeVar("TMetadata", bound="SessionMetadata")
TCreateOptions = TypeVar("TCreateOptions", bound="SessionCreateOptions")
TListOptions = TypeVar("TListOptions")
TSkill = TypeVar("TSkill", bound="Skill")
TPromptTemplate = TypeVar("TPromptTemplate", bound="PromptTemplate")
TTool = TypeVar("TTool", bound="AgentTool")


def ok(value: TValue) -> Result[TValue, Any]:
    """Create a successful Result."""
    return Result(True, value=value)


def err(error: TError) -> Result[Any, TError]:
    """Create a failed Result."""
    return Result(False, error=error)


def ok_result(value: TValue) -> Result[TValue, Any]:
    """Create a successful Result."""
    return Result(True, value=value)


def err_result(error: TError) -> Result[Any, TError]:
    """Create a failed Result."""
    return Result(False, error=error)


def get_or_throw(result: Result[TValue, TError]) -> TValue:
    """Return the success value or throw the failure error."""
    if not result.ok:
        if isinstance(result.error, Exception):
            raise result.error
        raise RuntimeError(str(result.error))
    return result.value


def get_or_undefined(result: Result[TValue, TError]) -> TValue | None:
    """Return the success value or None."""
    return result.value if result.ok else None


class Result(Generic[TValue, TError]):
    """Result of a fallible operation. Expected failures are returned as ok=False instead of thrown."""

    def __init__(self, ok: bool, value: TValue | None = None, error: TError | None = None):
        self._ok = ok
        self._value = value
        self._error = error

    @property
    def ok(self) -> bool:
        return self._ok

    @property
    def value(self) -> TValue:
        if not self._ok:
            raise RuntimeError("Cannot access value of failed result")
        return self._value

    @property
    def error(self) -> TError:
        if self._ok:
            raise RuntimeError("Cannot access error of successful result")
        return self._error

    @classmethod
    def ok_result(cls, value: TValue) -> "Result[TValue, TError]":
        return cls(True, value=value)

    @classmethod
    def err_result(cls, error: TError) -> "Result[TValue, TError]":
        return cls(False, error=error)

    def get_or_throw(self) -> TValue:
        """Return the success value or throw the failure error."""
        if not self._ok:
            raise self._error
        return self._value

    def get_or_undefined(self) -> TValue | None:
        """Return the success value or None. Only object values allowed to avoid truthiness bugs."""
        return self._value if self._ok else None


def to_error(error: Any) -> Exception:
    """Normalize unknown thrown values into Error instances."""
    if isinstance(error, Exception):
        return error
    if isinstance(error, str):
        return Exception(error)
    try:
        return Exception(json.dumps(error))
    except Exception:
        return Exception(str(error))


toError = to_error


# =============================================================================
# Skills & Prompt Templates
# =============================================================================


@dataclass
class Skill:
    """Skill loaded from a SKILL.md file or provided by an application."""

    name: str
    description: str
    content: str
    file_path: str
    disable_model_invocation: bool = False


@dataclass
class PromptTemplate:
    """Prompt template that can be formatted into a prompt for explicit invocation."""

    name: str
    content: str
    description: str | None = None


SkillDiagnosticCode = Literal[
    "file_info_failed",
    "list_failed",
    "read_failed",
    "parse_failed",
    "invalid_metadata",
]


@dataclass
class SkillDiagnostic:
    """Warning produced while loading skills."""

    type: Literal["warning"]
    code: SkillDiagnosticCode
    message: str
    path: str


PromptTemplateDiagnosticCode = Literal[
    "file_info_failed",
    "list_failed",
    "read_failed",
    "parse_failed",
    "invalid_metadata",
]


@dataclass
class PromptTemplateDiagnostic:
    """Warning produced while loading prompt templates."""

    type: Literal["warning"]
    code: PromptTemplateDiagnosticCode
    message: str
    path: str


class AgentHarnessResources(Generic[TSkill, TPromptTemplate]):
    """Resources made available to explicit invocation methods and system-prompt callbacks."""

    def __init__(
        self,
        prompt_templates: list[TPromptTemplate] | None = None,
        skills: list[TSkill] | None = None,
    ):
        self.prompt_templates = prompt_templates or []
        self.skills = skills or []


@dataclass
class AgentHarnessTurnState(Generic[TSkill, TPromptTemplate, TTool]):
    """Turn state for the agent harness."""

    messages: list[AgentMessage]
    resources: AgentHarnessResources[TSkill, TPromptTemplate]
    stream_options: dict
    session_id: str
    system_prompt: str
    model: Model[Any]
    thinking_level: str
    tools: list[TTool]
    active_tools: list[TTool]


# =============================================================================
# Stream Options
# =============================================================================


class AgentHarnessStreamOptions:
    """Curated provider request options owned by the harness and snapshotted per turn."""

    def __init__(
        self,
        transport: Transport | None = None,
        timeout_ms: int | None = None,
        max_retries: int | None = None,
        max_retry_delay_ms: int | None = None,
        headers: dict[str, str] | None = None,
        metadata: Any = None,
        cache_retention: str | None = None,
    ):
        self.transport = transport
        self.timeout_ms = timeout_ms
        self.max_retries = max_retries
        self.max_retry_delay_ms = max_retry_delay_ms
        self.headers = headers
        self.metadata = metadata
        self.cache_retention = cache_retention


class AgentHarnessStreamOptionsPatch:
    """Per-request stream option patch returned by provider hooks."""

    def __init__(
        self,
        transport: Transport | None = None,
        timeout_ms: int | None = None,
        max_retries: int | None = None,
        max_retry_delay_ms: int | None = None,
        headers: dict[str, str | None] | None = None,
        metadata: dict[str, Any | None] | None = None,
        cache_retention: str | None = None,
    ):
        self.transport = transport
        self.timeout_ms = timeout_ms
        self.max_retries = max_retries
        self.max_retry_delay_ms = max_retry_delay_ms
        self.headers = headers
        self.metadata = metadata
        self.cache_retention = cache_retention


class AgentLoopConfig:
    """Configuration for the agent loop."""

    def __init__(
        self,
        model: Model[Any],
        convert_to_llm: Callable[[list[AgentMessage]], list[Any]],
        transform_context: (
            Callable[[list[AgentMessage]], Awaitable[list[AgentMessage]]] | None
        ) = None,
        get_api_key: Callable[[str], Awaitable[str | None] | str | None] | None = None,
        should_stop_after_turn: Callable[[Any], Awaitable[bool] | bool] | None = None,
        prepare_next_turn: Callable[[Any], Awaitable[dict | None] | dict | None] | None = None,
        get_steering_messages: Callable[[], Awaitable[list[AgentMessage]]] | None = None,
        get_follow_up_messages: Callable[[], Awaitable[list[AgentMessage]]] | None = None,
        tool_execution: str = "sequential",
        reasoning: str | None = None,
        signal: AbortSignal | None = None,
        before_tool_call: Callable[[Any, Any], Awaitable[Any] | Any] | None = None,
        after_tool_call: Callable[[Any, Any, Any, bool], Awaitable[Any] | Any] | None = None,
        prepare_next_turn_fn: Callable[[Any], Awaitable[dict | None] | dict | None] | None = None,
        get_steering_messages_fn: Callable[[], Awaitable[list[AgentMessage]]] | None = None,
        get_follow_up_messages_fn: Callable[[], Awaitable[list[AgentMessage]]] | None = None,
        **kwargs,
    ):
        self.model = model
        self.reasoning = reasoning
        self.convert_to_llm = convert_to_llm
        self.transform_context = transform_context
        self.get_api_key = get_api_key
        self.should_stop_after_turn = should_stop_after_turn
        self.prepare_next_turn = prepare_next_turn
        self.get_steering_messages = get_steering_messages
        self.get_follow_up_messages = get_follow_up_messages
        self.tool_execution = tool_execution
        self.signal = signal
        self.before_tool_call = before_tool_call
        self.after_tool_call = after_tool_call


# Stream function type for provider streaming
StreamFn = Callable[[Callable[[str], Any], AbortSignal | None], Awaitable[None]]


def get_harness_option(
    options: dict[str, Any],
    snake_key: str,
    camel_key: str,
    default: Any = None,
) -> Any:
    """Read a harness option using either snake_case or camelCase keys."""
    if camel_key in options:
        return options[camel_key]
    if snake_key in options:
        return options[snake_key]
    return default


def tool_name(tool: Any) -> str:
    """Return a tool name from either a dict-like or attribute-based tool object."""
    if isinstance(tool, dict):
        return str(tool["name"])
    return str(tool.name)


def normalize_stream_options_input(
    stream_options: AgentHarnessStreamOptions | dict[str, Any] | None,
) -> AgentHarnessStreamOptions | None:
    """Normalize stream options from an object or plain dict."""
    if stream_options is None:
        return None
    if isinstance(stream_options, AgentHarnessStreamOptions):
        return stream_options
    if isinstance(stream_options, dict):
        return AgentHarnessStreamOptions(
            transport=stream_options.get("transport"),
            timeout_ms=stream_options.get("timeoutMs", stream_options.get("timeout_ms")),
            max_retries=stream_options.get("maxRetries", stream_options.get("max_retries")),
            max_retry_delay_ms=stream_options.get(
                "maxRetryDelayMs", stream_options.get("max_retry_delay_ms")
            ),
            headers=stream_options.get("headers"),
            metadata=stream_options.get("metadata"),
            cache_retention=stream_options.get(
                "cacheRetention", stream_options.get("cache_retention")
            ),
        )
    raise TypeError(f"Unsupported stream options type: {type(stream_options)!r}")


def stream_options_to_dict(options: AgentHarnessStreamOptions) -> dict[str, Any]:
    """Convert stream options to the camelCase dict shape used by harness turn state."""
    return {
        "transport": options.transport,
        "timeoutMs": options.timeout_ms,
        "maxRetries": options.max_retries,
        "maxRetryDelayMs": options.max_retry_delay_ms,
        "headers": dict(options.headers) if options.headers else None,
        "metadata": (
            dict(options.metadata) if isinstance(options.metadata, dict) else options.metadata
        ),
        "cacheRetention": options.cache_retention,
    }


def apply_stream_options_patch(
    base: AgentHarnessStreamOptions,
    patch: AgentHarnessStreamOptionsPatch | dict[str, Any] | None,
) -> AgentHarnessStreamOptions:
    """Apply a partial stream-options patch onto a cloned base."""
    result = clone_stream_options(base)
    if patch is None:
        return result

    patch_dict = patch if isinstance(patch, dict) else patch.__dict__
    if "transport" in patch_dict:
        result.transport = patch_dict["transport"]
    if "timeoutMs" in patch_dict or "timeout_ms" in patch_dict:
        result.timeout_ms = patch_dict.get("timeoutMs", patch_dict.get("timeout_ms"))
    if "maxRetries" in patch_dict or "max_retries" in patch_dict:
        result.max_retries = patch_dict.get("maxRetries", patch_dict.get("max_retries"))
    if "maxRetryDelayMs" in patch_dict or "max_retry_delay_ms" in patch_dict:
        result.max_retry_delay_ms = patch_dict.get(
            "maxRetryDelayMs", patch_dict.get("max_retry_delay_ms")
        )
    if "cacheRetention" in patch_dict or "cache_retention" in patch_dict:
        result.cache_retention = patch_dict.get("cacheRetention", patch_dict.get("cache_retention"))

    if "headers" in patch_dict:
        headers = patch_dict["headers"]
        if headers is None:
            result.headers = None
        else:
            merged = dict(result.headers or {})
            for key, value in headers.items():
                if value is None:
                    merged.pop(key, None)
                else:
                    merged[key] = value
            result.headers = merged or None

    if "metadata" in patch_dict:
        metadata = patch_dict["metadata"]
        if metadata is None:
            result.metadata = None
        else:
            merged = dict(result.metadata or {}) if isinstance(result.metadata, dict) else {}
            for key, value in metadata.items():
                if value is None:
                    merged.pop(key, None)
                else:
                    merged[key] = value
            result.metadata = merged or None

    return result


def clone_stream_options(
    stream_options: AgentHarnessStreamOptions | dict[str, Any] | None = None,
) -> AgentHarnessStreamOptions:
    """Clone stream options, creating a new object with copied headers and metadata."""
    normalized = normalize_stream_options_input(stream_options)
    if normalized is None:
        return AgentHarnessStreamOptions()
    return AgentHarnessStreamOptions(
        transport=normalized.transport,
        timeout_ms=normalized.timeout_ms,
        max_retries=normalized.max_retries,
        max_retry_delay_ms=normalized.max_retry_delay_ms,
        headers=dict(normalized.headers) if normalized.headers else None,
        metadata=(
            dict(normalized.metadata)
            if isinstance(normalized.metadata, dict)
            else normalized.metadata
        ),
        cache_retention=normalized.cache_retention,
    )


def merge_headers(*headers: dict[str, str] | None) -> dict[str, str] | None:
    """Merge multiple header dictionaries."""
    merged: dict[str, str] = {}
    has_headers = False
    for entry in headers:
        if not entry:
            continue
        merged.update(entry)
        has_headers = True
    return merged if has_headers else None


def to_error(error: Any) -> Exception:
    """Normalize unknown thrown values into Exception instances."""
    if isinstance(error, Exception):
        return error
    if isinstance(error, str):
        return Exception(error)
    try:
        import json

        return Exception(json.dumps(error))
    except Exception:
        return Exception(str(error))


def normalize_harness_error(error: Any, fallback_code: str = "unknown") -> AgentHarnessError:
    """Normalize an error into an AgentHarnessError."""
    from pi_mono.agent.harness.types import AgentHarnessError

    if isinstance(error, AgentHarnessError):
        return error
    cause = to_error(error)
    # Check for specific error types (if they exist)
    if hasattr(cause, "__class__") and "SessionError" in str(type(cause)):
        return AgentHarnessError("session", str(cause), cause)
    if hasattr(cause, "__class__") and "CompactionError" in str(type(cause)):
        return AgentHarnessError("compaction", str(cause), cause)
    if hasattr(cause, "__class__") and "BranchSummaryError" in str(type(cause)):
        return AgentHarnessError("branch_summary", str(cause), cause)
    return AgentHarnessError(fallback_code, str(cause), cause)


def normalize_hook_error(error: Any) -> AgentHarnessError:
    """Normalize a hook error into an AgentHarnessError with 'hook' code."""
    return normalize_harness_error(error, "hook")


# =============================================================================
# File System
# =============================================================================

FileKind = Literal["file", "directory", "symlink"]

FileErrorCode = Literal[
    "aborted",
    "not_found",
    "permission_denied",
    "not_directory",
    "is_directory",
    "invalid",
    "not_supported",
    "unknown",
]


class FileError(Exception):
    """Error returned by FileSystem file operations."""

    def __init__(
        self,
        code: FileErrorCode,
        message: str,
        path: str | None = None,
        cause: Exception | None = None,
    ):
        super().__init__(message, cause)
        self.name = "FileError"
        self.code = code
        self.message = message
        self.path = path


class FileInfo:
    """Metadata for one filesystem object."""

    def __init__(
        self,
        name: str,
        path: str,
        kind: FileKind,
        size: int,
        mtime_ms: int,
    ):
        self.name = name
        self.path = path
        self.kind = kind
        self.size = size
        self.mtime_ms = mtime_ms


class ExecutionEnvExecOptions:
    """Options for Shell.exec."""

    def __init__(
        self,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
        abort_signal: AbortSignal | None = None,
        on_stdout: Any = None,  # (chunk: str) -> void
        on_stderr: Any = None,  # (chunk: str) -> void
    ):
        self.cwd = cwd
        self.env = env
        self.timeout = timeout
        self.abort_signal = abort_signal
        self.on_stdout = on_stdout
        self.on_stderr = on_stderr


ExecutionErrorCode = Literal[
    "aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"
]


class ExecutionError(Exception):
    """Error returned by ExecutionEnv.exec."""

    def __init__(self, code: ExecutionErrorCode, message: str, cause: Exception | None = None):
        super().__init__(message, cause)
        self.name = "ExecutionError"
        self.code = code
        self.message = message


class ShellExecResult(TypedDict):
    """Result of a shell execution."""

    stdout: str
    stderr: str
    exitCode: int


# =============================================================================
# Domain-Specific Errors
# =============================================================================

CompactionErrorCode = Literal["aborted", "summarization_failed", "invalid_session", "unknown"]


class CompactionError(Exception):
    def __init__(self, code: CompactionErrorCode, message: str, cause: Exception | None = None):
        super().__init__(message, cause)
        self.name = "CompactionError"
        self.code = code
        self.message = message


BranchSummaryErrorCode = Literal["aborted", "summarization_failed", "invalid_session"]


class BranchSummaryError(Exception):
    def __init__(self, code: BranchSummaryErrorCode, message: str, cause: Exception | None = None):
        super().__init__(message, cause)
        self.name = "BranchSummaryError"
        self.code = code
        self.message = message


SessionErrorCode = Literal[
    "not_found", "invalid_session", "invalid_entry", "invalid_fork_target", "storage", "unknown"
]


class SessionError(Exception):
    def __init__(self, code: SessionErrorCode, message: str, cause: Exception | None = None):
        super().__init__(message, cause)
        self.name = "SessionError"
        self.code = code
        self.message = message


AgentHarnessErrorCode = Literal[
    "busy",
    "invalid_state",
    "invalid_argument",
    "session",
    "hook",
    "auth",
    "compaction",
    "branch_summary",
    "unknown",
]


class AgentHarnessError(Exception):
    """Public AgentHarness failure with a stable top-level classification."""

    def __init__(self, code: AgentHarnessErrorCode, message: str, cause: Exception | None = None):
        super().__init__(message, cause)
        self.name = "AgentHarnessError"
        self.code = code
        self.message = message


# =============================================================================
# File System Interface
# =============================================================================


class FileSystem:
    """Filesystem capability used by the harness."""

    def __init__(self, cwd: str):
        self.cwd = cwd

    async def absolute_path(
        self, path: str, abort_signal: AbortSignal | None = None
    ) -> Result[str, FileError]:
        raise NotImplementedError

    async def join_path(
        self, parts: list[str], abort_signal: AbortSignal | None = None
    ) -> Result[str, FileError]:
        raise NotImplementedError

    async def read_text_file(
        self, path: str, abort_signal: AbortSignal | None = None
    ) -> Result[str, FileError]:
        raise NotImplementedError

    async def read_text_lines(
        self,
        path: str,
        options: dict[str, Any] | None = None,
        abort_signal: AbortSignal | None = None,
    ) -> Result[list[str], FileError]:
        raise NotImplementedError

    async def read_binary_file(
        self, path: str, abort_signal: AbortSignal | None = None
    ) -> Result[bytes, FileError]:
        raise NotImplementedError

    async def write_file(
        self, path: str, content: str | bytes, abort_signal: AbortSignal | None = None
    ) -> Result[None, FileError]:
        raise NotImplementedError

    async def append_file(
        self, path: str, content: str | bytes, abort_signal: AbortSignal | None = None
    ) -> Result[None, FileError]:
        raise NotImplementedError

    async def file_info(
        self, path: str, abort_signal: AbortSignal | None = None
    ) -> Result[FileInfo, FileError]:
        raise NotImplementedError

    async def list_dir(
        self, path: str, abort_signal: AbortSignal | None = None
    ) -> Result[list[FileInfo], FileError]:
        raise NotImplementedError

    async def canonical_path(
        self, path: str, abort_signal: AbortSignal | None = None
    ) -> Result[str, FileError]:
        raise NotImplementedError

    async def exists(
        self, path: str, abort_signal: AbortSignal | None = None
    ) -> Result[bool, FileError]:
        raise NotImplementedError

    async def create_dir(
        self,
        path: str,
        options: dict[str, Any] | None = None,
        abort_signal: AbortSignal | None = None,
    ) -> Result[None, FileError]:
        raise NotImplementedError

    async def remove(
        self,
        path: str,
        options: dict[str, Any] | None = None,
        abort_signal: AbortSignal | None = None,
    ) -> Result[None, FileError]:
        raise NotImplementedError

    async def create_temp_dir(
        self, prefix: str = "tmp-", abort_signal: AbortSignal | None = None
    ) -> Result[str, FileError]:
        raise NotImplementedError

    async def create_temp_file(
        self, options: dict[str, Any] | None = None, abort_signal: AbortSignal | None = None
    ) -> Result[str, FileError]:
        raise NotImplementedError

    async def cleanup(self) -> None:
        raise NotImplementedError


class Shell:
    """Shell execution capability used by the harness."""

    async def exec(
        self, command: str, options: ExecutionEnvExecOptions | None = None
    ) -> Result[dict[str, Any], ExecutionError]:
        raise NotImplementedError

    async def cleanup(self) -> None:
        raise NotImplementedError


class ExecutionEnv(FileSystem, Shell):
    """Filesystem and process execution environment used by the harness."""

    pass


# =============================================================================
# Session Tree Entries
# =============================================================================


@dataclass(kw_only=True)
class SessionTreeEntryBase:
    type: str
    id: str
    parent_id: str | None
    timestamp: str


@dataclass(kw_only=True)
class MessageEntry(SessionTreeEntryBase):
    type: Literal["message"] = "message"
    message: AgentMessage = None  # type: ignore


@dataclass(kw_only=True)
class ThinkingLevelChangeEntry(SessionTreeEntryBase):
    type: Literal["thinking_level_change"] = "thinking_level_change"
    thinking_level: str = ""


@dataclass(kw_only=True)
class ModelChangeEntry(SessionTreeEntryBase):
    type: Literal["model_change"] = "model_change"
    provider: str = ""
    model_id: str = ""


@dataclass(kw_only=True)
class ActiveToolsChangeEntry(SessionTreeEntryBase):
    type: Literal["active_tools_change"] = "active_tools_change"
    active_tool_names: list[str] = None  # type: ignore


@dataclass(kw_only=True)
class CompactionEntry(SessionTreeEntryBase):
    type: Literal["compaction"] = "compaction"
    summary: str = ""
    first_kept_entry_id: str = ""
    tokens_before: int = 0
    details: Any = None
    from_hook: bool = False


@dataclass(kw_only=True)
class BranchSummaryEntry(SessionTreeEntryBase):
    type: Literal["branch_summary"] = "branch_summary"
    from_id: str = ""
    summary: str = ""
    details: Any = None
    from_hook: bool = False


@dataclass(kw_only=True)
class CustomEntry(SessionTreeEntryBase):
    type: Literal["custom"] = "custom"
    custom_type: str = ""
    data: Any = None


@dataclass(kw_only=True)
class CustomMessageEntry(SessionTreeEntryBase):
    type: Literal["custom_message"] = "custom_message"
    custom_type: str = ""
    content: str | list[TextContent | ImageContent] = ""
    details: Any = None
    display: bool = False


@dataclass(kw_only=True)
class LabelEntry(SessionTreeEntryBase):
    type: Literal["label"] = "label"
    target_id: str = ""
    label: str | None = None


@dataclass(kw_only=True)
class SessionInfoEntry(SessionTreeEntryBase):
    type: Literal["session_info"] = "session_info"
    name: str | None = None


@dataclass(kw_only=True)
class LeafEntry(SessionTreeEntryBase):
    type: Literal["leaf"] = "leaf"
    target_id: str | None = None


SessionTreeEntry = Union[
    MessageEntry,
    ThinkingLevelChangeEntry,
    ModelChangeEntry,
    ActiveToolsChangeEntry,
    CompactionEntry,
    BranchSummaryEntry,
    CustomEntry,
    CustomMessageEntry,
    LabelEntry,
    SessionInfoEntry,
    LeafEntry,
]


# =============================================================================
# Session Context & Metadata
# =============================================================================


@dataclass
class SessionContext:
    messages: list[AgentMessage]
    thinking_level: str
    model: dict[str, str] | None  # {provider, modelId}
    active_tool_names: list[str] | None

    @property
    def activeToolNames(self) -> list[str] | None:
        return self.active_tool_names

    @property
    def thinkingLevel(self) -> str:
        return self.thinking_level


@dataclass
class SessionMetadata:
    id: str
    created_at: str


@dataclass
class JsonlSessionMetadata(SessionMetadata):
    cwd: str
    path: str
    parent_session_path: str | None = None


class SessionStorage(Generic[TMetadata]):
    """Session storage interface."""

    async def get_metadata(self) -> TMetadata:
        raise NotImplementedError

    async def get_leaf_id(self) -> str | None:
        raise NotImplementedError

    async def set_leaf_id(self, leaf_id: str | None) -> None:
        raise NotImplementedError

    async def create_entry_id(self) -> str:
        raise NotImplementedError

    async def append_entry(self, entry: SessionTreeEntry) -> None:
        raise NotImplementedError

    async def get_entry(self, id: str) -> SessionTreeEntry | None:
        raise NotImplementedError

    async def find_entries(self, type: str) -> list[SessionTreeEntry]:
        raise NotImplementedError

    async def get_label(self, id: str) -> str | None:
        raise NotImplementedError

    async def get_path_to_root(self, leaf_id: str | None) -> list[SessionTreeEntry]:
        raise NotImplementedError

    async def get_entries(self) -> list[SessionTreeEntry]:
        raise NotImplementedError


class SessionCreateOptions:
    def __init__(self, id: str | None = None):
        self.id = id


class SessionForkOptions:
    def __init__(
        self,
        entry_id: str | None = None,
        position: Literal["before", "at"] | None = None,
        id: str | None = None,
    ):
        self.entry_id = entry_id
        self.position = position
        self.id = id


class SessionRepo(Generic[TMetadata, TCreateOptions, TListOptions]):
    """Session repository interface."""

    async def create(self, options: TCreateOptions) -> Any:  # Session[TMetadata]
        raise NotImplementedError

    async def open(self, metadata: TMetadata) -> Any:  # Session[TMetadata]
        raise NotImplementedError

    async def list(self, options: TListOptions | None = None) -> list[TMetadata]:
        raise NotImplementedError

    async def delete(self, metadata: TMetadata) -> None:
        raise NotImplementedError

    async def fork(
        self, source: TMetadata, options: SessionForkOptions
    ) -> Any:  # Session[TMetadata]
        raise NotImplementedError


class JsonlSessionCreateOptions(SessionCreateOptions):
    def __init__(self, cwd: str, parent_session_path: str | None = None, id: str | None = None):
        super().__init__(id)
        self.cwd = cwd
        self.parent_session_path = parent_session_path


class JsonlSessionListOptions:
    def __init__(self, cwd: str | None = None):
        self.cwd = cwd


# =============================================================================
# Agent Harness Phases & Types
# =============================================================================

AgentHarnessPhase = Literal["idle", "turn", "compaction", "branch_summary", "retry"]


@dataclass
class PendingSessionWrite:
    """Base for pending session writes (id, parentId, timestamp omitted)."""

    type: str
    # ... other fields vary by entry type


# =============================================================================
# Harness Events
# =============================================================================


@dataclass
class QueueUpdateEvent:
    type: Literal["queue_update"] = "queue_update"
    steer: list[AgentMessage] = None  # type: ignore
    follow_up: list[AgentMessage] = None  # type: ignore
    next_turn: list[AgentMessage] = None  # type: ignore


@dataclass
class SavePointEvent:
    type: Literal["save_point"] = "save_point"
    had_pending_mutations: bool = False


@dataclass
class AbortEvent:
    type: Literal["abort"] = "abort"
    cleared_steer: list[AgentMessage] = None  # type: ignore
    cleared_follow_up: list[AgentMessage] = None  # type: ignore


@dataclass
class SettledEvent:
    type: Literal["settled"] = "settled"
    next_turn_count: int = 0


@dataclass
class BeforeAgentStartEvent(
    Generic[TypeVar("TSkill", bound=Skill), TypeVar("TPromptTemplate", bound=PromptTemplate)]
):
    type: Literal["before_agent_start"] = "before_agent_start"
    prompt: str = ""
    images: list[ImageContent] | None = None
    system_prompt: str = ""
    resources: AgentHarnessResources[TSkill, TPromptTemplate] = None  # type: ignore


@dataclass
class ContextEvent:
    type: Literal["context"] = "context"
    messages: list[AgentMessage] = None  # type: ignore


@dataclass
class BeforeProviderRequestEvent:
    type: Literal["before_provider_request"] = "before_provider_request"
    model: Model[Any] = None  # type: ignore
    session_id: str = ""
    stream_options: AgentHarnessStreamOptions = None  # type: ignore


@dataclass
class BeforeProviderPayloadEvent:
    type: Literal["before_provider_payload"] = "before_provider_payload"
    model: Model[Any] = None  # type: ignore
    payload: Any = None


@dataclass
class AfterProviderResponseEvent:
    type: Literal["after_provider_response"] = "after_provider_response"
    status: int = 0
    headers: dict[str, str] = None  # type: ignore


@dataclass
class ToolCallEvent:
    type: Literal["tool_call"] = "tool_call"
    tool_call_id: str = ""
    tool_name: str = ""
    input: dict[str, Any] = None  # type: ignore


@dataclass
class ToolResultEvent:
    type: Literal["tool_result"] = "tool_result"
    tool_call_id: str = ""
    tool_name: str = ""
    input: dict[str, Any] = None  # type: ignore
    content: list[TextContent | ImageContent] = None  # type: ignore
    details: Any = None
    is_error: bool = False


@dataclass
class SessionBeforeCompactEvent:
    type: Literal["session_before_compact"] = "session_before_compact"
    preparation: Any = None  # type: ignore
    branch_entries: list[SessionTreeEntry] = None  # type: ignore
    custom_instructions: str | None = None
    signal: AbortSignal = None  # type: ignore


@dataclass
class SessionCompactEvent:
    type: Literal["session_compact"] = "session_compact"
    compaction_entry: Any = None  # type: ignore
    from_hook: bool = False


@dataclass
class SessionBeforeTreeEvent:
    type: Literal["session_before_tree"] = "session_before_tree"
    preparation: Any = None  # type: ignore
    signal: AbortSignal = None  # type: ignore


@dataclass
class SessionTreeEvent:
    type: Literal["session_tree"] = "session_tree"
    new_leaf_id: str | None = None
    old_leaf_id: str | None = None
    summary_entry: Any | None = None  # type: ignore
    from_hook: bool | None = None


@dataclass
class ModelUpdateEvent:
    type: Literal["model_update"] = "model_update"
    model: Model[Any] = None  # type: ignore
    previous_model: Model[Any] | None = None
    source: Literal["set", "restore"] = "set"


@dataclass
class ThinkingLevelUpdateEvent:
    level: ThinkingLevel
    previous_level: ThinkingLevel
    type: Literal["thinking_level_update"] = "thinking_level_update"


@dataclass
class ToolsUpdateEvent:
    tool_names: list[str]
    previous_tool_names: list[str]
    active_tool_names: list[str]
    previous_active_tool_names: list[str]
    source: Literal["set", "restore"]
    type: Literal["tools_update"] = "tools_update"


@dataclass
class ResourcesUpdateEvent(Generic[TSkill, TPromptTemplate]):
    resources: AgentHarnessResources[TSkill, TPromptTemplate]
    previous_resources: AgentHarnessResources[TSkill, TPromptTemplate]
    type: Literal["resources_update"] = "resources_update"


# Type aliases for events
TSkill = TypeVar("TSkill", bound=Skill)
TPromptTemplate = TypeVar("TPromptTemplate", bound=PromptTemplate)

AgentHarnessOwnEvent = Union[
    QueueUpdateEvent,
    SavePointEvent,
    AbortEvent,
    SettledEvent,
    BeforeAgentStartEvent[TSkill, TPromptTemplate],
    ContextEvent,
    BeforeProviderRequestEvent,
    BeforeProviderPayloadEvent,
    AfterProviderResponseEvent,
    ToolCallEvent,
    ToolResultEvent,
    SessionBeforeCompactEvent,
    SessionCompactEvent,
    SessionBeforeTreeEvent,
    SessionTreeEvent,
    ModelUpdateEvent,
    ThinkingLevelUpdateEvent,
    ResourcesUpdateEvent[TSkill, TPromptTemplate],
    ToolsUpdateEvent,
]

AgentHarnessEvent = Union[AgentEvent, AgentHarnessOwnEvent[TSkill, TPromptTemplate]]


# =============================================================================
# Event Results
# =============================================================================


@dataclass
class BeforeAgentStartResult:
    messages: list[AgentMessage] | None = None
    system_prompt: str | None = None


@dataclass
class ContextResult:
    messages: list[AgentMessage]


@dataclass
class BeforeProviderRequestResult:
    stream_options: AgentHarnessStreamOptionsPatch | None = None


@dataclass
class BeforeProviderPayloadResult:
    payload: Any


@dataclass
class ToolCallResult:
    block: bool | None = None
    reason: str | None = None


@dataclass
class ToolResultPatch:
    content: list[TextContent | ImageContent] | None = None
    details: Any | None = None
    is_error: bool | None = None
    terminate: bool | None = None


@dataclass
class SessionBeforeCompactResult:
    cancel: bool = False
    compaction: Any | None = None  # CompactResult


@dataclass
class SessionBeforeTreeResult:
    cancel: bool = False
    summary: dict[str, Any] | None = None  # {summary, details}
    custom_instructions: str | None = None
    replace_instructions: bool = False
    label: str | None = None


AgentHarnessEventResultMap = dict[str, Any]


# =============================================================================
# Agent Harness Options & Results
# =============================================================================


@dataclass
class AbortResult:
    cleared_steer: list[AgentMessage]
    cleared_follow_up: list[AgentMessage]


@dataclass
class CompactResult:
    summary: str
    first_kept_entry_id: str
    tokens_before: int
    details: Any | None = None


@dataclass
class NavigateTreeResult:
    cancelled: bool
    editor_text: str | None = None
    summary_entry: Any | None = None  # BranchSummaryEntry


@dataclass
class CompactionSettings:
    enabled: bool
    reserve_tokens: int
    keep_recent_tokens: int


DEFAULT_COMPACTION_SETTINGS = CompactionSettings(
    enabled=True,
    reserve_tokens=8192,
    keep_recent_tokens=4096,
)


@dataclass
class CompactionPreparation:
    first_kept_entry_id: str
    messages_to_summarize: list[AgentMessage]
    turn_prefix_messages: list[AgentMessage]
    is_split_turn: bool
    tokens_before: int
    previous_summary: str | None = None
    file_ops: Any = None  # FileOperations
    settings: CompactionSettings = field(default_factory=lambda: DEFAULT_COMPACTION_SETTINGS)


@dataclass
class FileOperations:
    read: set[str] = None  # type: ignore
    written: set[str] = None  # type: ignore
    edited: set[str] = None  # type: ignore


@dataclass
class TreePreparation:
    target_id: str
    old_leaf_id: str | None
    common_ancestor_id: str | None
    entries_to_summarize: list[SessionTreeEntry]
    user_wants_summary: bool
    custom_instructions: str | None = None
    replace_instructions: bool = False
    label: str | None = None


@dataclass
class GenerateBranchSummaryOptions:
    model: Model[Any]
    api_key: str
    headers: dict[str, str] | None = None
    signal: AbortSignal = None  # type: ignore
    custom_instructions: str | None = None
    replace_instructions: bool = False
    reserve_tokens: int | None = None


@dataclass
class BranchSummaryResult:
    summary: str
    read_files: list[str]
    modified_files: list[str]


@dataclass
class AgentHarnessOptions(Generic[TSkill, TPromptTemplate, TTool]):
    env: ExecutionEnv
    session: Any  # Session
    tools: list[TTool] | None = None
    resources: AgentHarnessResources[TSkill, TPromptTemplate] | None = None
    system_prompt: str | Callable[..., str | Any] | None = None
    get_api_key_and_headers: Callable[[Model[Any]], Any] | None = None
    stream_options: AgentHarnessStreamOptions | None = None
    model: Model[Any] = None  # type: ignore
    thinking_level: ThinkingLevel = "off"
    active_tool_names: list[str] | None = None
    steering_mode: QueueMode = "one-at-a-time"
    follow_up_mode: QueueMode = "one-at-a-time"


# Re-export AgentHarness from agent_harness module
__all__ = [
    "Result",
    "ok",
    "err",
    "ok_result",
    "err_result",
    "get_or_throw",
    "get_or_undefined",
    "to_error",
    "toError",
    "ShellExecResult",
    "Skill",
    "SkillDiagnostic",
    "SkillDiagnosticCode",
    "PromptTemplate",
    "PromptTemplateDiagnostic",
    "PromptTemplateDiagnosticCode",
    "AgentHarnessResources",
    "AgentHarnessStreamOptions",
    "AgentHarnessStreamOptionsPatch",
    "FileKind",
    "FileErrorCode",
    "FileError",
    "FileInfo",
    "ExecutionEnvExecOptions",
    "ExecutionErrorCode",
    "ExecutionError",
    "CompactionErrorCode",
    "CompactionError",
    "BranchSummaryErrorCode",
    "BranchSummaryError",
    "SessionErrorCode",
    "SessionError",
    "AgentHarnessErrorCode",
    "AgentHarnessError",
    "FileSystem",
    "Shell",
    "ExecutionEnv",
    "SessionTreeEntryBase",
    "MessageEntry",
    "ThinkingLevelChangeEntry",
    "ModelChangeEntry",
    "ActiveToolsChangeEntry",
    "CompactionEntry",
    "BranchSummaryEntry",
    "CustomEntry",
    "CustomMessageEntry",
    "LabelEntry",
    "SessionInfoEntry",
    "LeafEntry",
    "SessionTreeEntry",
    "SessionContext",
    "SessionMetadata",
    "JsonlSessionMetadata",
    "SessionStorage",
    "SessionCreateOptions",
    "SessionForkOptions",
    "SessionRepo",
    "JsonlSessionCreateOptions",
    "JsonlSessionListOptions",
    "AgentHarnessPhase",
    "PendingSessionWrite",
    "QueueUpdateEvent",
    "SavePointEvent",
    "AbortEvent",
    "SettledEvent",
    "BeforeAgentStartEvent",
    "ContextEvent",
    "BeforeProviderRequestEvent",
    "BeforeProviderPayloadEvent",
    "AfterProviderResponseEvent",
    "ToolCallEvent",
    "ToolResultEvent",
    "SessionBeforeCompactEvent",
    "SessionCompactEvent",
    "SessionBeforeTreeEvent",
    "SessionTreeEvent",
    "ModelUpdateEvent",
    "ThinkingLevelUpdateEvent",
    "ToolsUpdateEvent",
    "ResourcesUpdateEvent",
    "AgentHarnessOwnEvent",
    "AgentHarnessEvent",
    "BeforeAgentStartResult",
    "ContextResult",
    "BeforeProviderRequestResult",
    "BeforeProviderPayloadResult",
    "ToolCallResult",
    "ToolResultPatch",
    "SessionBeforeCompactResult",
    "SessionBeforeTreeResult",
    "AgentHarnessEventResultMap",
    "AbortResult",
    "CompactResult",
    "NavigateTreeResult",
    "CompactionSettings",
    "DEFAULT_COMPACTION_SETTINGS",
    "CompactionPreparation",
    "FileOperations",
    "TreePreparation",
    "GenerateBranchSummaryOptions",
    "BranchSummaryResult",
    "AgentHarnessOptions",
]
