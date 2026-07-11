"""AgentSession - core abstraction for agent lifecycle and session management."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from datetime import datetime
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, TypedDict, cast

from pi_mono.agent.agent import Agent
from pi_mono.agent.harness.compaction.compaction import (
    calculate_context_tokens,
    compact,
    estimate_context_tokens,
    estimate_messages_tokens,
    prepare_compaction,
    should_compact,
)
from pi_mono.agent.harness.compaction.branch_summarization import (
    collect_entries_for_branch_summary_sync,
    generate_branch_summary,
)
from pi_mono.agent.harness.messages import create_user_message
from pi_mono.agent.types import AgentEvent, AgentMessage, AgentTool, ThinkingLevel
from pi_mono.ai.models import clamp_thinking_level, get_supported_thinking_levels, models_are_equal
from pi_mono.ai.types import AssistantMessage, ImageContent, Model
from pi_mono.ai.utils.overflow import is_context_overflow
from pi_mono.ai.utils.retry import is_retryable_assistant_error
from pi_mono.core.session_cwd import assert_session_cwd_exists
from pi_mono.core.defaults import DEFAULT_THINKING_LEVEL
from pi_mono.coding_agent.core.bash_executor import (
    BashExecutorOptions,
    BashResult,
    execute_bash_with_operations,
)
from pi_mono.coding_agent.core.tools.bash import LocalBashOperations
from pi_mono.core.event_bus import EventBusController, create_event_bus
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager, get_latest_compaction_entry
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.coding_agent.core.auth_guidance import (
    format_no_api_key_found_message,
    format_no_model_selected_message,
)
from pi_mono.coding_agent.core.resource_loader import ResourceLoader
from pi_mono.coding_agent.core.prompt_templates import expand_prompt_template
from pi_mono.coding_agent.core.skills import expand_skill_command
from pi_mono.coding_agent.core.system_prompt import build_system_prompt
from pi_mono.coding_agent.core.extensions import (
    ExtensionActions,
    ExtensionCommandContextActions,
    ExtensionContextActions,
    ExtensionRunner,
    LoadExtensionsResult,
    collect_configured_extension_paths,
    discover_and_load_extensions,
    emit_session_shutdown_event,
)
from pi_mono.coding_agent.core.extensions.loader import create_extension_runtime
from pi_mono.coding_agent.core.extensions.types import ContextUsage, ExtensionError
from pi_mono.agent.types import (
    AfterToolCallContext,
    AfterToolCallResult,
    BeforeToolCallContext,
    BeforeToolCallResult,
)
from pi_mono.coding_agent.core.extensions.wrapper import wrap_registered_tools
from pi_mono.coding_agent.core.tools import ALL_TOOL_NAMES, ToolName, create_tool
from pi_mono.config import get_agent_dir
from pi_mono.utils.paths import resolve_path  # used by AgentSessionRuntime
from pi_mono.utils.abort_signals import AbortController, AbortSignal

CompactionReason = Literal["manual", "overflow", "threshold"]

_STALE_EXTENSION_CTX_MESSAGE = (
    "This extension ctx is stale after session replacement or reload. "
    "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), "
    "ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, "
    "move post-replacement work into withSession and use the ctx passed to withSession. "
    "For reload, do not use the old ctx after await ctx.reload()."
)


SteeringMode = Literal["all", "one-at-a-time"]
FollowUpMode = Literal["all", "one-at-a-time"]


class ModelCycleResult(TypedDict):
    model: Model[Any]
    thinkingLevel: ThinkingLevel
    isScoped: bool


class SessionStats(TypedDict, total=False):
    sessionFile: str | None
    sessionId: str
    userMessages: int
    assistantMessages: int
    toolCalls: int
    toolResults: int
    totalMessages: int
    tokens: dict[str, int]
    cost: float


_DEFAULT_TOOL_SNIPPETS: dict[str, str] = {
    "read": "Read file contents",
    "bash": "Execute shell commands",
    "edit": "Edit files with search/replace",
    "write": "Write or overwrite files",
    "grep": "Search file contents",
    "find": "Find files by pattern",
    "ls": "List directory contents",
}


class AgentSessionEventQueueUpdate(TypedDict):
    type: Literal["queue_update"]
    steering: list[str]
    followUp: list[str]


class AgentSessionEventSessionInfoChanged(TypedDict):
    type: Literal["session_info_changed"]
    name: str | None


class AgentSessionEventThinkingLevelChanged(TypedDict):
    type: Literal["thinking_level_changed"]
    level: ThinkingLevel


class AgentSessionEventCompactionStart(TypedDict):
    type: Literal["compaction_start"]
    reason: CompactionReason


class AgentSessionEventCompactionEnd(TypedDict):
    type: Literal["compaction_end"]
    reason: CompactionReason
    result: Any | None
    aborted: bool
    willRetry: bool
    errorMessage: str | None


class AgentSessionEventAutoRetryStart(TypedDict):
    type: Literal["auto_retry_start"]
    attempt: int
    maxAttempts: int
    delayMs: int
    errorMessage: str


class AgentSessionEventAutoRetryEnd(TypedDict):
    type: Literal["auto_retry_end"]
    success: bool
    attempt: int
    finalError: str | None


class AgentSessionEventAgentSettled(TypedDict):
    type: Literal["agent_settled"]


class AgentSessionEventEntryAppended(TypedDict):
    type: Literal["entry_appended"]
    entry: dict[str, Any]


AgentSessionEvent = (
    AgentEvent
    | AgentSessionEventQueueUpdate
    | AgentSessionEventSessionInfoChanged
    | AgentSessionEventThinkingLevelChanged
    | AgentSessionEventCompactionStart
    | AgentSessionEventCompactionEnd
    | AgentSessionEventAutoRetryStart
    | AgentSessionEventAutoRetryEnd
    | AgentSessionEventAgentSettled
    | AgentSessionEventEntryAppended
)

AgentSessionEventListener = Callable[[AgentSessionEvent], None]

_SKILL_BLOCK_RE = re.compile(
    r'^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n</skill>(?:\n\n([\s\S]+))?$'
)


class ParsedSkillBlock(TypedDict):
    name: str
    location: str
    content: str
    userMessage: str | None


def parse_skill_block(text: str) -> ParsedSkillBlock | None:
    match = _SKILL_BLOCK_RE.match(text)
    if not match:
        return None
    user_message = match.group(4)
    return {
        "name": match.group(1),
        "location": match.group(2),
        "content": match.group(3),
        "userMessage": user_message.strip() if user_message else None,
    }


@dataclass
class PromptOptions:
    expand_templates: bool = True
    images: list[ImageContent] | None = None
    streaming_behavior: Literal["steer", "followUp"] | None = None
    source: Literal["interactive", "rpc", "extension"] = "interactive"
    preflight_result: Callable[[bool], None] | None = None


@dataclass
class AgentSessionConfig:
    agent: Agent
    session_manager: SessionManager
    settings_manager: SettingsManager
    cwd: str
    model_registry: ModelRegistry
    resource_loader: ResourceLoader
    scoped_models: list[dict[str, Any]] | None = None
    initial_active_tool_names: list[str] | None = None
    allowed_tool_names: list[str] | None = None
    excluded_tool_names: list[str] | None = None
    system_prompt: str | None = None
    extension_paths: list[str] | None = None
    no_extensions: bool = False
    extension_runner_ref: list[ExtensionRunner | None] | None = None


def _default_active_tools() -> list[ToolName]:
    return ["read", "bash", "edit", "write"]


def _resolve_tools(
    cwd: str,
    *,
    initial_active_tool_names: list[str] | None = None,
    allowed_tool_names: list[str] | None = None,
    excluded_tool_names: list[str] | None = None,
) -> list[AgentTool]:
    if initial_active_tool_names is None:
        active = _default_active_tools()
    else:
        active = list(initial_active_tool_names)
    if allowed_tool_names is not None:
        active = [name for name in active if name in allowed_tool_names]
    if excluded_tool_names:
        active = [name for name in active if name not in excluded_tool_names]
    return [create_tool(name, cwd) for name in active]  # type: ignore[arg-type]


class AgentSession:
    """Shared session abstraction for interactive, print, and rpc modes."""

    def __init__(self, config: AgentSessionConfig) -> None:
        self._config = config
        self._event_bus: EventBusController = create_event_bus()
        self._listeners: list[AgentSessionEventListener] = []
        self._disposed = False
        self._agent_listener: Callable[[], None] | None = None
        self._scoped_models = list(config.scoped_models or [])
        self._resource_loader = config.resource_loader
        self._steering_messages: list[str] = []
        self._follow_up_messages: list[str] = []
        self._compaction_abort_controller: AbortController | None = None
        self._branch_summary_abort_controller: AbortController | None = None
        self._bash_abort_controller: AbortController | None = None
        self.agent = config.agent
        self.session_manager = config.session_manager
        self.settings_manager = config.settings_manager
        self.cwd = config.cwd
        self.model_registry = config.model_registry
        self._extension_paths = list(config.extension_paths or [])
        self._no_extensions = config.no_extensions
        self._extension_load_result: LoadExtensionsResult | None = None
        self._extension_runner: ExtensionRunner | None = None
        self._extension_error_unsubscribe: Callable[[], None] | None = None
        self._extension_mode: str = "print"
        self._session_start_reason: str = "startup"
        self._session_start_previous_file: str | None = None
        self._last_assistant_message: AssistantMessage | None = None
        self._retry_attempt = 0
        self._retry_abort_controller: AbortController | None = None
        self._overflow_recovery_attempted = False
        self._auto_compaction_abort_controller: AbortController | None = None
        self._base_system_prompt = ""
        self._base_system_prompt_options: dict[str, Any] = {"cwd": config.cwd}
        self._extension_runner_ref = config.extension_runner_ref
        self._turn_index = 0
        self._pending_next_turn_messages: list[AgentMessage] = []
        self._extension_shutdown_handler: Callable[[], None] | None = None
        self._extension_abort_handler: Callable[[], None] | None = None
        self._agent_tool_hooks_installed = False
        self._allowed_tool_names = (
            set(config.allowed_tool_names) if config.allowed_tool_names is not None else None
        )
        self._excluded_tool_names = set(config.excluded_tool_names or [])
        self._tool_registry: dict[str, AgentTool] = {}
        self._tool_prompt_snippets: dict[str, str] = {}
        self._is_agent_run_active = False
        self._idle_wait_future: asyncio.Future[None] | None = None

        tools = _resolve_tools(
            config.cwd,
            initial_active_tool_names=config.initial_active_tool_names,
            allowed_tool_names=config.allowed_tool_names,
            excluded_tool_names=config.excluded_tool_names,
        )
        self.agent.state.tools = tools
        for tool in tools:
            self._tool_registry[tool.name] = tool
            if tool.name in _DEFAULT_TOOL_SNIPPETS:
                self._tool_prompt_snippets[tool.name] = _DEFAULT_TOOL_SNIPPETS[tool.name]
        self._refresh_system_prompt(custom_prompt=config.system_prompt)

        self._agent_listener = self.agent.subscribe(self._handle_agent_event_with_signal)

    @property
    def state(self) -> Any:
        return self.agent.state

    @property
    def model(self) -> Model[Any] | None:
        return self.agent.state.model

    @property
    def thinking_level(self) -> ThinkingLevel:
        return self.agent.state.thinkingLevel  # type: ignore[return-value]

    @property
    def is_streaming(self) -> bool:
        return self._is_agent_run_active

    @property
    def is_idle(self) -> bool:
        return not self._is_agent_run_active

    @property
    def system_prompt(self) -> str:
        return self.agent.state.systemPrompt

    def get_active_tool_names(self) -> list[str]:
        return [tool.name for tool in self.agent.state.tools]

    def get_all_tools(self) -> list[dict[str, str]]:
        return [{"name": name} for name in sorted(self._tool_registry.keys())]

    def _is_allowed_tool(self, name: str) -> bool:
        if self._allowed_tool_names is not None and name not in self._allowed_tool_names:
            return False
        return name not in self._excluded_tool_names

    @property
    def messages(self) -> list[AgentMessage]:
        return self.agent.state.messages

    @property
    def resource_loader(self) -> ResourceLoader:
        return self._resource_loader

    @property
    def session_file(self) -> str | None:
        return self.session_manager.get_session_file()

    @property
    def session_id(self) -> str:
        return self.session_manager.get_session_id()

    @property
    def steering_mode(self) -> str:
        return self.agent.steeringMode

    @property
    def follow_up_mode(self) -> str:
        return self.agent.followUpMode

    @property
    def pending_message_count(self) -> int:
        return len(self._steering_messages) + len(self._follow_up_messages)

    @property
    def is_compacting(self) -> bool:
        return (
            self._auto_compaction_abort_controller is not None
            or self._compaction_abort_controller is not None
            or self._branch_summary_abort_controller is not None
        )

    @property
    def session_name(self) -> str | None:
        return self.session_manager.get_session_name()

    @property
    def auto_compaction_enabled(self) -> bool:
        return self.settings_manager.get_compaction_enabled()

    @property
    def is_retrying(self) -> bool:
        return self._retry_abort_controller is not None

    @property
    def retry_attempt(self) -> int:
        return self._retry_attempt

    def subscribe(self, listener: AgentSessionEventListener) -> Callable[[], None]:
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    def _emit(self, event: AgentSessionEvent) -> None:
        for listener in list(self._listeners):
            listener(event)
        self._event_bus.emit("session", event)

    def _emit_queue_update(self) -> None:
        self._emit(
            {
                "type": "queue_update",
                "steering": list(self._steering_messages),
                "followUp": list(self._follow_up_messages),
            }
        )

    def _get_idle_wait_future(self) -> asyncio.Future[None]:
        loop = asyncio.get_running_loop()
        if self._idle_wait_future is None or self._idle_wait_future.done():
            self._idle_wait_future = loop.create_future()
        return self._idle_wait_future

    def _resolve_idle_wait_if_idle(self) -> None:
        if self._is_agent_run_active or self._idle_wait_future is None:
            return
        if not self._idle_wait_future.done():
            self._idle_wait_future.set_result(None)
        self._idle_wait_future = None

    async def _emit_agent_settled(self) -> None:
        self._is_agent_run_active = False
        try:
            runner = self._extension_runner
            if runner is not None:
                await runner.emit({"type": "agent_settled"})
            self._emit({"type": "agent_settled"})
        finally:
            self._resolve_idle_wait_if_idle()

    async def _handle_agent_event_with_signal(self, event: AgentEvent, _signal: AbortSignal) -> None:
        await self._handle_agent_event_async(event)

    async def _handle_agent_event_async(self, event: AgentEvent) -> None:
        event_to_emit = event
        if self._extension_runner is not None:
            event_to_emit = await self._apply_extension_event_hooks(event)

        event_type = event_to_emit.get("type")
        if event_type == "message_end":
            message = event_to_emit.get("message")
            if message and message.get("role") in ("user", "assistant", "toolResult"):
                self._persist_message(message)
                self._remove_delivered_queue_message(message)
            elif message and message.get("role") == "custom":
                custom_type = message.get("customType")
                if custom_type:
                    append_custom = getattr(
                        self.session_manager, "append_custom_message_entry", None
                    )
                    if callable(append_custom):
                        append_custom(
                            custom_type,
                            message.get("content"),
                            message.get("display"),
                            message.get("details"),
                        )

        if event_type == "agent_end":
            payload = cast(AgentEvent, dict(event_to_emit))
            payload["willRetry"] = self._will_retry_after_agent_end(event_to_emit)  # type: ignore[typeddict-unknown-key]
            self._emit(payload)  # type: ignore[arg-type]
        else:
            self._emit(event_to_emit)  # type: ignore[arg-type]

        if event_type == "message_end":
            message = event_to_emit.get("message")
            if message and message.get("role") == "assistant":
                self._last_assistant_message = cast(AssistantMessage, message)
                stop_reason = message.get("stopReason")
                if stop_reason != "error" and self._retry_attempt > 0:
                    self._emit(
                        {
                            "type": "auto_retry_end",
                            "success": True,
                            "attempt": self._retry_attempt,
                            "finalError": None,
                        }
                    )
                    self._retry_attempt = 0

    async def _apply_extension_event_hooks(self, event: AgentEvent) -> AgentEvent:
        runner = self._extension_runner
        if runner is None:
            return event
        await self._emit_extension_event(event)
        if event.get("type") != "message_end":
            return event
        message = event.get("message")
        if message is None:
            return event
        messages = self.agent.state.messages
        for index, current in enumerate(messages):
            if current is message or (
                current.get("timestamp") == message.get("timestamp")
                and current.get("role") == message.get("role")
            ):
                return {**event, "message": messages[index]}
        return event

    def _remove_delivered_queue_message(self, message: AgentMessage) -> None:
        content = message.get("content")
        if not isinstance(content, list):
            return
        text_parts = [part.get("text", "") for part in content if part.get("type") == "text"]
        message_text = "".join(text_parts)
        if message_text in self._steering_messages:
            self._steering_messages.remove(message_text)
            self._emit_queue_update()
        elif message_text in self._follow_up_messages:
            self._follow_up_messages.remove(message_text)
            self._emit_queue_update()

    def _persist_message(self, message: AgentMessage) -> None:
        append = getattr(self.session_manager, "append_message", None)
        if callable(append):
            append(message)

    def _refresh_system_prompt(self, *, custom_prompt: str | None = None) -> None:
        loader = self._resource_loader
        agents_files = loader.get_agents_files().get("agentsFiles", [])
        skills = loader.get_skills().get("skills", [])
        append_parts = loader.get_append_system_prompt()
        selected_tool_names = [tool.name for tool in self.agent.state.tools]
        tool_snippets = {
            name: snippet
            for name, snippet in self._tool_prompt_snippets.items()
            if name in selected_tool_names
        }
        prompt = build_system_prompt(
            custom_prompt=custom_prompt or loader.get_system_prompt(),
            selected_tools=selected_tool_names,
            tool_snippets=tool_snippets,
            append_system_prompt="\n\n".join(append_parts) if append_parts else None,
            cwd=self.cwd,
            context_files=agents_files,
            skills=skills,
        )
        self._base_system_prompt = prompt
        self._base_system_prompt_options = {"cwd": self.cwd}
        self.agent.state.systemPrompt = prompt

    @property
    def prompt_templates(self) -> list[Any]:
        return self._resource_loader.get_prompts().get("prompts", [])

    def set_thinking_level(self, level: ThinkingLevel) -> None:
        effective_level = (
            clamp_thinking_level(self.model, level) if self.model else "off"  # type: ignore[assignment]
        )
        previous_level = self.agent.state.thinkingLevel
        self.agent.state.thinkingLevel = effective_level
        if effective_level != previous_level:
            self.session_manager.append_thinking_level_change(effective_level)
            self.settings_manager.set_default_thinking_level(effective_level)
            self._emit({"type": "thinking_level_changed", "level": effective_level})
            runner = self._extension_runner
            if runner is not None:
                asyncio.create_task(
                    runner.emit(
                        {
                            "type": "thinking_level_select",
                            "level": effective_level,
                            "previousLevel": previous_level,
                        }
                    )
                )

    async def _emit_model_select(
        self,
        next_model: Model[Any],
        previous_model: Model[Any] | None,
        source: Literal["set", "cycle", "restore"],
    ) -> None:
        if models_are_equal(previous_model, next_model):
            return
        runner = self._extension_runner
        if runner is None:
            return
        await runner.emit(
            {
                "type": "model_select",
                "model": next_model,
                "previousModel": previous_model,
                "source": source,
            }
        )

    async def set_model(self, model: Model[Any]) -> None:
        if not self.model_registry.has_configured_auth(model):
            raise RuntimeError(f"No API key for {model['provider']}/{model['id']}")
        previous_model = self.model
        thinking_level = self._get_thinking_level_for_model_switch()
        self.agent.state.model = model
        self.session_manager.append_model_change(model["provider"], model["id"])
        self.settings_manager.set_default_model_and_provider(model["provider"], model["id"])
        self.set_thinking_level(thinking_level)
        await self._emit_model_select(model, previous_model, "set")

    async def cycle_model(
        self, direction: Literal["forward", "backward"] = "forward"
    ) -> ModelCycleResult | None:
        if self._scoped_models:
            return await self._cycle_scoped_model(direction)
        return await self._cycle_available_model(direction)

    async def _cycle_scoped_model(
        self, direction: Literal["forward", "backward"]
    ) -> ModelCycleResult | None:
        scoped_models = [
            item
            for item in self._scoped_models
            if self.model_registry.has_configured_auth(item["model"])
        ]
        if len(scoped_models) <= 1:
            return None

        current_model = self.model
        current_index = next(
            (
                index
                for index, item in enumerate(scoped_models)
                if models_are_equal(item["model"], current_model)
            ),
            0,
        )
        length = len(scoped_models)
        next_index = (
            (current_index + 1) % length
            if direction == "forward"
            else (current_index - 1 + length) % length
        )
        next_item = scoped_models[next_index]
        thinking_level = self._get_thinking_level_for_model_switch(next_item.get("thinkingLevel"))
        self.agent.state.model = next_item["model"]
        self.session_manager.append_model_change(
            next_item["model"]["provider"], next_item["model"]["id"]
        )
        self.settings_manager.set_default_model_and_provider(
            next_item["model"]["provider"], next_item["model"]["id"]
        )
        self.set_thinking_level(thinking_level)
        await self._emit_model_select(next_item["model"], current_model, "cycle")
        return {
            "model": next_item["model"],
            "thinkingLevel": self.thinking_level,
            "isScoped": True,
        }

    async def _cycle_available_model(
        self, direction: Literal["forward", "backward"]
    ) -> ModelCycleResult | None:
        available_models = self.model_registry.get_available()
        if len(available_models) <= 1:
            return None

        current_model = self.model
        current_index = next(
            (
                index
                for index, model in enumerate(available_models)
                if models_are_equal(model, current_model)
            ),
            0,
        )
        length = len(available_models)
        next_index = (
            (current_index + 1) % length
            if direction == "forward"
            else (current_index - 1 + length) % length
        )
        next_model = available_models[next_index]
        thinking_level = self._get_thinking_level_for_model_switch()
        self.agent.state.model = next_model
        self.session_manager.append_model_change(next_model["provider"], next_model["id"])
        self.settings_manager.set_default_model_and_provider(
            next_model["provider"], next_model["id"]
        )
        self.set_thinking_level(thinking_level)
        await self._emit_model_select(next_model, current_model, "cycle")
        return {
            "model": next_model,
            "thinkingLevel": self.thinking_level,
            "isScoped": False,
        }

    def supports_thinking(self) -> bool:
        return bool(self.model and self.model.get("reasoning"))

    def get_available_thinking_levels(self) -> list[ThinkingLevel]:
        if not self.model:
            return ["off", "minimal", "low", "medium", "high", "xhigh", "max"]  # type: ignore[list-item]
        return get_supported_thinking_levels(self.model)  # type: ignore[return-value]

    def _get_thinking_level_for_model_switch(
        self, explicit_level: ThinkingLevel | None = None
    ) -> ThinkingLevel:
        if explicit_level is not None:
            return explicit_level
        if not self.supports_thinking():
            return self.settings_manager.get_default_thinking_level() or DEFAULT_THINKING_LEVEL  # type: ignore[return-value]
        return self.thinking_level

    def cycle_thinking_level(self) -> ThinkingLevel | None:
        if not self.supports_thinking():
            return None
        levels = self.get_available_thinking_levels()
        current_index = levels.index(self.thinking_level) if self.thinking_level in levels else 0
        next_index = (current_index + 1) % len(levels)
        next_level = levels[next_index]
        self.set_thinking_level(next_level)
        return next_level

    def set_steering_mode(self, mode: SteeringMode) -> None:
        self.agent.steeringMode = mode
        self.settings_manager.set_steering_mode(mode)

    def set_follow_up_mode(self, mode: FollowUpMode) -> None:
        self.agent.followUpMode = mode
        self.settings_manager.set_follow_up_mode(mode)

    def set_auto_compaction(self, enabled: bool) -> None:
        self.settings_manager.set_compaction_enabled(enabled)

    def set_auto_retry(self, enabled: bool) -> None:
        self.settings_manager.set_retry_enabled(enabled)

    def get_user_messages_for_forking(self) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        for entry in self.session_manager.get_entries():
            if entry.get("type") != "message":
                continue
            message = entry.get("message", {})
            if message.get("role") != "user":
                continue
            text = _extract_user_message_text(message.get("content"))
            if text:
                result.append({"entryId": str(entry["id"]), "text": text})
        return result

    def get_session_stats(self) -> SessionStats:
        user_messages = sum(1 for message in self.messages if message.get("role") == "user")
        assistant_messages = sum(
            1 for message in self.messages if message.get("role") == "assistant"
        )
        tool_results = sum(1 for message in self.messages if message.get("role") == "toolResult")
        tool_calls = 0
        total_input = 0
        total_output = 0
        total_cache_read = 0
        total_cache_write = 0
        total_cost = 0.0

        for message in self.messages:
            if message.get("role") != "assistant":
                continue
            content = message.get("content", [])
            if isinstance(content, list):
                tool_calls += sum(1 for part in content if part.get("type") == "toolCall")
            usage = message.get("usage") or {}
            total_input += int(usage.get("input", 0) or 0)
            total_output += int(usage.get("output", 0) or 0)
            total_cache_read += int(usage.get("cacheRead", 0) or 0)
            total_cache_write += int(usage.get("cacheWrite", 0) or 0)
            cost = usage.get("cost") or {}
            total_cost += float(cost.get("total", 0) or 0)

        return {
            "sessionFile": self.session_file,
            "sessionId": self.session_id,
            "userMessages": user_messages,
            "assistantMessages": assistant_messages,
            "toolCalls": tool_calls,
            "toolResults": tool_results,
            "totalMessages": len(self.messages),
            "tokens": {
                "input": total_input,
                "output": total_output,
                "cacheRead": total_cache_read,
                "cacheWrite": total_cache_write,
                "total": total_input + total_output + total_cache_read + total_cache_write,
            },
            "cost": total_cost,
        }

    def get_last_assistant_text(self) -> str | None:
        for message in reversed(self.messages):
            if message.get("role") != "assistant":
                continue
            if message.get("stopReason") == "aborted" and not message.get("content"):
                continue
            text_parts: list[str] = []
            content = message.get("content", [])
            if isinstance(content, list):
                for part in content:
                    if part.get("type") == "text":
                        text_parts.append(str(part.get("text", "")))
            text = "".join(text_parts).strip()
            if text:
                return text
        return None

    @property
    def scoped_models(self) -> list[dict[str, Any]]:
        return list(self._scoped_models)

    def set_scoped_models(self, scoped_models: list[dict[str, Any]]) -> None:
        self._scoped_models = list(scoped_models)

    @property
    def is_bash_running(self) -> bool:
        return self._bash_abort_controller is not None

    async def execute_bash(
        self,
        command: str,
        on_chunk: Callable[[str], None] | None = None,
        *,
        exclude_from_context: bool = False,
        operations: LocalBashOperations | None = None,
    ) -> BashResult:
        self._bash_abort_controller = AbortController()
        prefix = self.settings_manager.get_shell_command_prefix()
        resolved_command = f"{prefix}\n{command}" if prefix else command
        bash_operations = operations or LocalBashOperations()

        try:
            result = await execute_bash_with_operations(
                resolved_command,
                self.session_manager.get_cwd(),
                bash_operations,
                BashExecutorOptions(
                    on_chunk=on_chunk,
                    signal=self._bash_abort_controller.signal,
                ),
            )
            self.record_bash_result(command, result, exclude_from_context=exclude_from_context)
            return result
        finally:
            self._bash_abort_controller = None

    def record_bash_result(
        self,
        command: str,
        result: BashResult,
        *,
        exclude_from_context: bool = False,
    ) -> None:
        bash_message: AgentMessage = {
            "role": "bashExecution",
            "command": command,
            "output": result.output,
            "exitCode": result.exit_code,
            "cancelled": result.cancelled,
            "truncated": result.truncated,
            "fullOutputPath": result.full_output_path,
            "timestamp": int(time.time() * 1000),
            "excludeFromContext": exclude_from_context,
        }
        self.agent.state.messages.append(bash_message)
        append = getattr(self.session_manager, "append_message", None)
        if callable(append):
            append(bash_message)

    def abort_bash(self) -> None:
        if self._bash_abort_controller is not None:
            self._bash_abort_controller.abort()

    async def wait_for_idle(self) -> None:
        if self.is_idle:
            return
        await self._get_idle_wait_future()

    async def abort(self) -> None:
        self.agent.abort()
        await self.wait_for_idle()

    async def steer(self, text: str, images: list[ImageContent] | None = None) -> None:
        if text.startswith("/"):
            self._throw_if_extension_command(text)
        expanded_text = self._expand_skill_command(text)
        expanded_text = expand_prompt_template(expanded_text, self.prompt_templates)
        await self._queue_steer(expanded_text, images)

    async def follow_up(self, text: str, images: list[ImageContent] | None = None) -> None:
        if text.startswith("/"):
            self._throw_if_extension_command(text)
        expanded_text = self._expand_skill_command(text)
        expanded_text = expand_prompt_template(expanded_text, self.prompt_templates)
        await self._queue_follow_up(expanded_text, images)

    async def _queue_steer(
        self, text: str, images: list[ImageContent] | None = None
    ) -> None:
        self._steering_messages.append(text)
        self._emit_queue_update()
        self.agent.steer(create_user_message(text, images))

    async def _queue_follow_up(
        self, text: str, images: list[ImageContent] | None = None
    ) -> None:
        self._follow_up_messages.append(text)
        self._emit_queue_update()
        self.agent.followUp(create_user_message(text, images))

    def get_steering_messages(self) -> list[str]:
        return list(self._steering_messages)

    def get_follow_up_messages(self) -> list[str]:
        return list(self._follow_up_messages)

    def clear_queue(self) -> dict[str, list[str]]:
        steering = list(self._steering_messages)
        follow_up = list(self._follow_up_messages)
        self._steering_messages.clear()
        self._follow_up_messages.clear()
        self.agent.clearAllQueues()
        self._emit_queue_update()
        return {"steering": steering, "followUp": follow_up}

    def set_session_name(self, name: str) -> None:
        self.session_manager.append_session_info(name)
        event = {
            "type": "session_info_changed",
            "name": self.session_manager.get_session_name(),
        }
        self._emit(event)
        runner = self._extension_runner
        if runner is not None and runner.has_handlers("session_info_changed"):
            asyncio.create_task(runner.emit(event))

    async def navigate_tree(
        self,
        target_id: str,
        *,
        summarize: bool = False,
    ) -> dict[str, Any]:
        old_leaf_id = self.session_manager.get_leaf_id()
        if target_id == old_leaf_id:
            return {"cancelled": False}

        target_entry = self.session_manager.get_entry(target_id)
        if not target_entry:
            raise RuntimeError(f"Entry {target_id} not found")

        preparation: dict[str, Any] = {
            "targetId": target_id,
            "oldLeafId": old_leaf_id,
            "commonAncestorId": None,
            "entriesToSummarize": [],
            "userWantsSummary": summarize,
            "customInstructions": None,
            "replaceInstructions": False,
            "label": None,
        }

        self._branch_summary_abort_controller = AbortController()
        try:
            runner = self._extension_runner
            if runner is not None and runner.has_handlers("session_before_tree"):
                before_result = await runner.emit(
                    {
                        "type": "session_before_tree",
                        "preparation": preparation,
                        "signal": None,
                    }
                )
                if before_result and before_result.get("cancel"):
                    return {"cancelled": True}

            if summarize:
                collected = collect_entries_for_branch_summary_sync(
                    self.session_manager, old_leaf_id, target_id
                )
                entries = collected["entries"]
                if entries:
                    model = self.model
                    if not model:
                        raise RuntimeError("No model set for branch summary")
                    auth = await self.model_registry.get_api_key_and_headers(model)
                    if not auth.get("ok"):
                        raise RuntimeError(
                            auth.get("error")
                            or format_no_api_key_found_message(model.get("provider", ""))
                        )
                    branch_summary = await generate_branch_summary(
                        entries,
                        {
                            "model": model,
                            "apiKey": auth.get("apiKey") or "",
                            "headers": auth.get("headers"),
                        },
                    )
                    if not branch_summary.ok:
                        raise RuntimeError(str(branch_summary.error))

                    if (
                        target_entry.get("type") == "message"
                        and target_entry.get("message", {}).get("role") == "user"
                    ):
                        new_leaf_id = target_entry.get("parentId")
                        editor_text = _extract_user_message_text(
                            target_entry.get("message", {}).get("content")
                        )
                    else:
                        new_leaf_id = target_id
                        editor_text = None

                    self.session_manager.branch_with_summary(
                        new_leaf_id,
                        branch_summary.value["summary"],
                        {
                            "readFiles": branch_summary.value["readFiles"],
                            "modifiedFiles": branch_summary.value["modifiedFiles"],
                        },
                    )
                else:
                    if (
                        target_entry.get("type") == "message"
                        and target_entry.get("message", {}).get("role") == "user"
                    ):
                        new_leaf_id = target_entry.get("parentId")
                        editor_text = _extract_user_message_text(
                            target_entry.get("message", {}).get("content")
                        )
                    else:
                        new_leaf_id = target_id
                        editor_text = None
                    if new_leaf_id:
                        self.session_manager.branch(new_leaf_id)
                    else:
                        self.session_manager.reset_leaf()
            else:
                if (
                    target_entry.get("type") == "message"
                    and target_entry.get("message", {}).get("role") == "user"
                ):
                    new_leaf_id = target_entry.get("parentId")
                    editor_text = _extract_user_message_text(
                        target_entry.get("message", {}).get("content")
                    )
                else:
                    new_leaf_id = target_id
                    editor_text = None

                if new_leaf_id:
                    self.session_manager.branch(new_leaf_id)
                else:
                    self.session_manager.reset_leaf()

            context = self.session_manager.build_session_context()
            self.agent.state.messages = list(context.get("messages", []))

            if runner is not None and runner.has_handlers("session_tree"):
                await runner.emit(
                    {
                        "type": "session_tree",
                        "newLeafId": self.session_manager.get_leaf_id(),
                        "oldLeafId": old_leaf_id,
                    }
                )

            result: dict[str, Any] = {"cancelled": False}
            if editor_text is not None:
                result["editorText"] = editor_text
            return result
        finally:
            self._branch_summary_abort_controller = None

    async def compact(self, custom_instructions: str | None = None) -> dict[str, Any]:
        await self.abort()
        self._compaction_abort_controller = AbortController()
        self._emit({"type": "compaction_start", "reason": "manual"})
        aborted = False
        error_message: str | None = None
        compaction_result: dict[str, Any] | None = None

        try:
            if not self.model:
                raise RuntimeError(format_no_model_selected_message())

            auth = await self.model_registry.get_api_key_and_headers(self.model)
            if not auth.get("ok"):
                raise RuntimeError(
                    format_no_api_key_found_message(self.model.get("provider", "unknown"))
                )

            path_entries = self.session_manager.get_branch()
            settings = self.settings_manager.get_compaction_settings()
            preparation_result = prepare_compaction(path_entries, settings)
            if not preparation_result.ok:
                raise preparation_result.error
            preparation = preparation_result.value
            if not preparation:
                last_entry = path_entries[-1] if path_entries else None
                if last_entry and last_entry.get("type") == "compaction":
                    raise RuntimeError("Already compacted")
                raise RuntimeError("Nothing to compact (session too small)")

            if self._compaction_abort_controller.signal.aborted:
                aborted = True
                raise RuntimeError("Compaction cancelled")

            extension_compaction: dict[str, Any] | None = None
            from_extension = False
            runner = self._extension_runner
            if runner is not None and runner.has_handlers("session_before_compact"):
                before_result = await runner.emit(
                    {
                        "type": "session_before_compact",
                        "preparation": preparation,
                        "branchEntries": path_entries,
                        "customInstructions": custom_instructions,
                        "signal": self._compaction_abort_controller.signal,
                    }
                )
                if before_result and before_result.get("cancel"):
                    raise RuntimeError("Compaction cancelled")
                if before_result and before_result.get("compaction"):
                    extension_compaction = before_result["compaction"]
                    from_extension = True

            if extension_compaction:
                summary = str(extension_compaction["summary"])
                first_kept_entry_id = str(extension_compaction["firstKeptEntryId"])
                tokens_before = int(extension_compaction["tokensBefore"])
                details = extension_compaction.get("details")
            else:
                compact_result = await compact(
                    preparation,
                    self.model,
                    auth.get("apiKey") or "",
                    auth.get("headers"),
                    custom_instructions,
                    self._compaction_abort_controller.signal,
                    self.thinking_level,
                )
                if not compact_result.ok:
                    raise compact_result.error

                result = compact_result.value
                summary = result["summary"]
                first_kept_entry_id = result["firstKeptEntryId"]
                tokens_before = result["tokensBefore"]
                details = result.get("details")

            if self._compaction_abort_controller.signal.aborted:
                aborted = True
                raise RuntimeError("Compaction cancelled")

            self.session_manager.append_compaction(
                summary,
                first_kept_entry_id,
                tokens_before,
                details,
                from_extension,
            )
            session_context = self.session_manager.build_session_context()
            self.agent.state.messages = list(session_context.get("messages", []))
            estimated_tokens_after = estimate_messages_tokens(self.agent.state.messages)
            compaction_result = {
                "summary": summary,
                "firstKeptEntryId": first_kept_entry_id,
                "tokensBefore": tokens_before,
                "estimatedTokensAfter": estimated_tokens_after,
                "details": details,
            }

            if runner is not None and runner.has_handlers("session_compact"):
                saved_compaction = next(
                    (
                        entry
                        for entry in reversed(self.session_manager.get_entries())
                        if entry.get("type") == "compaction" and entry.get("summary") == summary
                    ),
                    None,
                )
                if saved_compaction is not None:
                    await runner.emit(
                        {
                            "type": "session_compact",
                            "compactionEntry": saved_compaction,
                            "fromExtension": from_extension,
                        }
                    )

            return compaction_result
        except Exception as error:
            error_message = str(error)
            if "cancelled" in error_message.lower():
                aborted = True
            raise
        finally:
            self._emit(
                {
                    "type": "compaction_end",
                    "reason": "manual",
                    "result": compaction_result,
                    "aborted": aborted,
                    "willRetry": False,
                    "errorMessage": error_message,
                }
            )
            self._compaction_abort_controller = None

    def _expand_skill_command(self, text: str) -> str:
        skills = self._resource_loader.get_skills().get("skills", [])

        def emit_error(path: str, error: str) -> None:
            runner = self._extension_runner
            if runner is None:
                return
            runner.emit_error(
                ExtensionError(
                    extension_path=path,
                    event="skill_expansion",
                    error=error,
                )
            )

        return expand_skill_command(text, skills, emit_error=emit_error)

    def _find_last_assistant_message(self) -> AssistantMessage | None:
        for message in reversed(self.agent.state.messages):
            if message.get("role") == "assistant":
                return cast(AssistantMessage, message)
        return None

    def _throw_if_extension_command(self, text: str) -> None:
        if not text.startswith("/"):
            return
        runner = self._extension_runner
        if runner is None:
            return
        space_index = text.find(" ")
        command_name = text[1:space_index] if space_index != -1 else text[1:]
        command = runner.get_command(command_name)
        if command is not None:
            raise RuntimeError(
                f'Extension command "/{command_name}" cannot be queued. '
                "Use prompt() or execute the command when not streaming."
            )

    async def try_execute_extension_command(self, text: str) -> bool:
        if not text.startswith("/"):
            return False
        runner = self._extension_runner
        if runner is None:
            return False
        space_index = text.find(" ")
        command_name = text[1:space_index] if space_index != -1 else text[1:]
        args = text[space_index + 1 :] if space_index != -1 else ""
        command = runner.get_command(command_name)
        if command is None:
            return False
        ctx = runner.create_command_context()
        try:
            await command.handler(args, ctx)
        except Exception as error:
            runner.emit_error(
                ExtensionError(
                    extension_path=f"command:{command_name}",
                    event="command",
                    error=str(error),
                )
            )
        return True

    async def _emit_extension_event(self, event: AgentEvent) -> None:
        runner = self._extension_runner
        if runner is None:
            return
        event_type = event.get("type")
        if event_type == "agent_start":
            self._turn_index = 0
            await runner.emit({"type": "agent_start"})
        elif event_type == "agent_end":
            await runner.emit({"type": "agent_end", "messages": event.get("messages", [])})
        elif event_type == "turn_start":
            await runner.emit(
                {
                    "type": "turn_start",
                    "turnIndex": self._turn_index,
                    "timestamp": int(time.time() * 1000),
                }
            )
        elif event_type == "turn_end":
            await runner.emit(
                {
                    "type": "turn_end",
                    "turnIndex": self._turn_index,
                    "message": event.get("message"),
                    "toolResults": event.get("toolResults", []),
                }
            )
            self._turn_index += 1
        elif event_type == "message_start":
            await runner.emit({"type": "message_start", "message": event.get("message")})
        elif event_type == "message_update":
            await runner.emit(
                {
                    "type": "message_update",
                    "message": event.get("message"),
                    "assistantMessageEvent": event.get("assistantMessageEvent"),
                }
            )
        elif event_type == "message_end":
            message = event.get("message")
            if message is not None:
                replacement = await runner.emit_message_end(
                    {"type": "message_end", "message": message}
                )
                if replacement:
                    # Untyped extension handlers can return messages with null/missing content;
                    # normalize so it never enters agent state or session history.
                    role = replacement.get("role")
                    if (
                        role in ("user", "assistant", "toolResult", "custom")
                        and replacement.get("content") is None
                    ):
                        replacement = {**replacement, "content": []}
                    self._set_message_in_place(message, replacement)
        elif event_type == "tool_execution_start":
            await runner.emit(
                {
                    "type": "tool_execution_start",
                    "toolCallId": event.get("toolCallId"),
                    "toolName": event.get("toolName"),
                    "args": event.get("args"),
                }
            )
        elif event_type == "tool_execution_update":
            await runner.emit(
                {
                    "type": "tool_execution_update",
                    "toolCallId": event.get("toolCallId"),
                    "toolName": event.get("toolName"),
                    "args": event.get("args"),
                    "partialResult": event.get("partialResult"),
                }
            )
        elif event_type == "tool_execution_end":
            await runner.emit(
                {
                    "type": "tool_execution_end",
                    "toolCallId": event.get("toolCallId"),
                    "toolName": event.get("toolName"),
                    "result": event.get("result"),
                    "isError": event.get("isError"),
                }
            )

    def _set_message_in_place(self, original: AgentMessage, replacement: AgentMessage) -> None:
        messages = self.agent.state.messages
        for index, message in enumerate(messages):
            if message is original or (
                message.get("timestamp") == original.get("timestamp")
                and message.get("role") == original.get("role")
            ):
                messages[index] = replacement
                return

    def _replace_message_in_place(self, original: AgentMessage, replacement: AgentMessage) -> None:
        self._set_message_in_place(original, replacement)
        self._emit({"type": "message_update", "message": replacement})

    def _install_agent_tool_hooks(self) -> None:
        async def before_tool_call(
            context: BeforeToolCallContext, _signal: AbortSignal | None
        ) -> BeforeToolCallResult | None:
            runner = self._extension_runner
            if runner is None or not runner.has_handlers("tool_call"):
                return None
            tool_call = context["toolCall"]
            try:
                result = await runner.emit_tool_call(
                    {
                        "type": "tool_call",
                        "toolName": tool_call.get("name"),
                        "toolCallId": tool_call.get("id"),
                        "input": context["args"],
                    }
                )
                if result and result.get("block"):
                    return {
                        "block": True,
                        "reason": result.get("reason", "Tool execution was blocked"),
                    }
            except Exception as error:
                raise RuntimeError(f"Extension failed, blocking execution: {error}") from error
            return None

        async def after_tool_call(
            context: AfterToolCallContext, _signal: AbortSignal | None
        ) -> AfterToolCallResult | None:
            runner = self._extension_runner
            if runner is None or not runner.has_handlers("tool_result"):
                return None
            tool_call = context["toolCall"]
            result = context["result"]
            hook_result = await runner.emit_tool_result(
                {
                    "type": "tool_result",
                    "toolName": tool_call.get("name"),
                    "toolCallId": tool_call.get("id"),
                    "input": context["args"],
                    "content": result.get("content"),
                    "details": result.get("details"),
                    "isError": context["isError"],
                }
            )
            if not hook_result:
                return None
            return {
                "content": hook_result.get("content", result.get("content")),
                "details": hook_result.get("details", result.get("details")),
                "isError": hook_result.get("isError", context["isError"]),
            }

        self.agent.beforeToolCall = before_tool_call
        self.agent.afterToolCall = after_tool_call
        self._agent_tool_hooks_installed = True

    def set_extension_shutdown_handler(self, handler: Callable[[], None] | None) -> None:
        self._extension_shutdown_handler = handler

    def set_extension_abort_handler(self, handler: Callable[[], None] | None) -> None:
        self._extension_abort_handler = handler

    def get_context_usage(self) -> ContextUsage | None:
        model = self.model
        if not model:
            return None
        context_window = int(model.get("contextWindow", 0) or 0)
        if context_window <= 0:
            return None

        branch_entries = self.session_manager.get_branch()
        latest_compaction = get_latest_compaction_entry(branch_entries)
        if latest_compaction is not None:
            compaction_index = branch_entries.index(latest_compaction)
            has_post_compaction_usage = False
            for entry in reversed(branch_entries[compaction_index + 1 :]):
                if entry.get("type") != "message":
                    continue
                message = entry.get("message", {})
                if message.get("role") != "assistant":
                    continue
                stop_reason = message.get("stopReason")
                if stop_reason in ("aborted", "error"):
                    continue
                usage = message.get("usage")
                if usage and calculate_context_tokens(usage) > 0:
                    has_post_compaction_usage = True
                    break
            if not has_post_compaction_usage:
                return {"tokens": None, "contextWindow": context_window, "percent": None}

        estimate = estimate_context_tokens(self.agent.state.messages)
        percent = (estimate.tokens / context_window) * 100
        return {
            "tokens": estimate.tokens,
            "contextWindow": context_window,
            "percent": percent,
        }

    async def send_custom_message(
        self,
        message: dict[str, Any],
        options: dict[str, Any] | None = None,
    ) -> None:
        opts = options or {}
        app_message: AgentMessage = {
            "role": "custom",
            "customType": message["customType"],
            # Untyped extensions can pass null/missing content; normalize at ingestion.
            "content": message.get("content") if message.get("content") is not None else [],
            "display": message.get("display", True),
            "details": message.get("details"),
            "timestamp": int(time.time() * 1000),
        }
        deliver_as = opts.get("deliverAs")
        if deliver_as == "nextTurn":
            self._pending_next_turn_messages.append(app_message)
            return
        if self.is_streaming:
            if deliver_as == "followUp":
                self.agent.followUp(app_message)
            else:
                self.agent.steer(app_message)
            return
        if opts.get("triggerTurn"):
            await self._run_agent_prompt(app_message)
            return
        self.agent.state.messages.append(app_message)
        self.session_manager.append_custom_message_entry(
            str(message["customType"]),
            message["content"],
            bool(message.get("display", True)),
            message.get("details"),
        )
        self._emit({"type": "message_start", "message": app_message})
        self._emit({"type": "message_end", "message": app_message})

    async def send_user_message(
        self,
        content: str | list[dict[str, Any]],
        options: dict[str, Any] | None = None,
    ) -> None:
        opts = options or {}
        text: str
        images: list[ImageContent] | None
        if isinstance(content, str):
            text = content
            images = None
        else:
            text_parts: list[str] = []
            images = []
            for part in content:
                if part.get("type") == "text":
                    text_parts.append(str(part.get("text", "")))
                elif part.get("type") == "image":
                    images.append(cast(ImageContent, part))
            text = "\n".join(text_parts)
            if not images:
                images = None
        await self.prompt(
            text,
            PromptOptions(
                expand_templates=False,
                images=images,
                streaming_behavior=opts.get("deliverAs"),
                source="extension",
            ),
        )

    def create_replaced_session_context(self) -> Any:
        runner = self._extension_runner
        if runner is None:
            raise RuntimeError("Extension runner not initialized")
        base = runner.create_command_context()
        session = self

        class ReplacedSessionContext:
            def __init__(self, wrapped: Any) -> None:
                self._wrapped = wrapped

            def __getattr__(self, name: str) -> Any:
                return getattr(self._wrapped, name)

            async def send_user_message(
                self,
                content: str | list[dict[str, Any]],
                options: dict[str, Any] | None = None,
            ) -> None:
                await session.send_user_message(content, options)

            async def send_message(
                self, message: dict[str, Any], options: dict[str, Any] | None = None
            ) -> None:
                await session.send_custom_message(message, options)

        return ReplacedSessionContext(base)

    def _extension_runtime_error(self, event: str, error: Exception) -> None:
        runner = self._extension_runner
        if runner is None:
            return
        runner.emit_error(
            ExtensionError(
                extension_path="<runtime>",
                event=event,
                error=str(error),
            )
        )

    def _refresh_tool_registry(self) -> None:
        previous_active = [tool.name for tool in self.agent.state.tools]
        previous_registry_names = set(self._tool_registry.keys())

        registry: dict[str, AgentTool] = {}
        snippets: dict[str, str] = dict(_DEFAULT_TOOL_SNIPPETS)

        for name in ALL_TOOL_NAMES:
            if not self._is_allowed_tool(name):
                continue
            registry[name] = create_tool(name, self.cwd)  # type: ignore[arg-type]

        runner = self._extension_runner
        if runner is not None:
            registered_tools = [
                tool
                for tool in runner.get_all_registered_tools()
                if self._is_allowed_tool(tool.definition.name)
            ]
            for wrapped in wrap_registered_tools(registered_tools, runner):
                registry[wrapped.name] = wrapped
            for registered in registered_tools:
                snippet = registered.definition.prompt_snippet
                if snippet:
                    snippets[registered.definition.name] = snippet

        next_active = [name for name in previous_active if name in registry]
        if self._allowed_tool_names is not None:
            for name in registry:
                if name in self._allowed_tool_names and name not in next_active:
                    next_active.append(name)
        else:
            extension_names: set[str] = set()
            if runner is not None:
                extension_names = {
                    registered.definition.name for registered in runner.get_all_registered_tools()
                }
            for name in registry:
                if (
                    name in extension_names
                    and name not in previous_registry_names
                    and name not in next_active
                ):
                    next_active.append(name)

        self._tool_registry = registry
        self._tool_prompt_snippets = snippets
        self.agent.state.tools = [registry[name] for name in next_active if name in registry]
        self._refresh_system_prompt()

    async def export_to_html(
        self, output_path: str | None = None, *, theme_name: str | None = None
    ) -> str:
        from pi_mono.coding_agent.core.export_html.export_html import export_session_to_html
        from pi_mono.coding_agent.core.export_html.tool_renderer import create_tool_html_renderer

        configured_theme = self.settings_manager.get_theme()
        resolved_theme = theme_name
        if resolved_theme is None and configured_theme:
            from pi_mono.coding_agent.modes.interactive.theme.theme import THEMES_DIR

            if (THEMES_DIR / f"{configured_theme}.json").exists():
                resolved_theme = configured_theme

        tool_renderer = create_tool_html_renderer(
            cwd=self.session_manager.get_cwd(),
            get_tool_definition=self._get_tool_definition_for_export,
        )
        return export_session_to_html(
            self,
            output_path=output_path,
            theme_name=resolved_theme,
            tool_renderer=tool_renderer,
        )

    def _get_tool_definition_for_export(self, name: str) -> Any | None:
        runner = self._extension_runner
        if runner is None:
            return None
        for registered in runner.get_all_registered_tools():
            if registered.definition.name == name:
                return registered.definition
        return None

    def abort_retry(self) -> None:
        if self._retry_abort_controller is not None:
            self._retry_abort_controller.abort()

    def _is_retryable_error(self, message: AssistantMessage) -> bool:
        if message.get("stopReason") != "error" or not message.get("errorMessage"):
            return False
        context_window = (self.model or {}).get("contextWindow", 0)
        if is_context_overflow(message, context_window):
            return False
        return is_retryable_assistant_error(message)

    def _will_retry_after_agent_end(self, event: AgentEvent) -> bool:
        settings = self.settings_manager.get_retry_settings()
        if not settings.get("enabled") or self._retry_attempt >= int(settings.get("maxRetries", 3)):
            return False
        messages = event.get("messages", [])
        for message in reversed(messages):
            if message.get("role") == "assistant":
                return self._is_retryable_error(cast(AssistantMessage, message))
        return False

    async def _abortable_sleep(self, delay_ms: int, signal: AbortSignal) -> None:
        if signal.aborted:
            raise RuntimeError("Retry cancelled")
        done = asyncio.Event()

        def on_abort() -> None:
            done.set()

        signal.add_event_listener("abort", on_abort)
        try:
            try:
                await asyncio.wait_for(done.wait(), timeout=delay_ms / 1000)
            except TimeoutError:
                return
            if signal.aborted:
                raise RuntimeError("Retry cancelled")
        finally:
            signal.remove_event_listener("abort", on_abort)

    async def _prepare_retry(self, message: AssistantMessage) -> bool:
        settings = self.settings_manager.get_retry_settings()
        if not settings.get("enabled"):
            return False

        self._retry_attempt += 1
        max_retries = int(settings.get("maxRetries", 3))
        if self._retry_attempt > max_retries:
            self._retry_attempt -= 1
            return False

        delay_ms = int(settings.get("baseDelayMs", 2000)) * (2 ** (self._retry_attempt - 1))
        self._emit(
            {
                "type": "auto_retry_start",
                "attempt": self._retry_attempt,
                "maxAttempts": max_retries,
                "delayMs": delay_ms,
                "errorMessage": str(message.get("errorMessage") or "Unknown error"),
            }
        )

        messages = self.agent.state.messages
        if messages and messages[-1].get("role") == "assistant":
            self.agent.state.messages = messages[:-1]

        self._retry_abort_controller = AbortController()
        try:
            await self._abortable_sleep(delay_ms, self._retry_abort_controller.signal)
        except RuntimeError:
            attempt = self._retry_attempt
            self._retry_attempt = 0
            self._emit(
                {
                    "type": "auto_retry_end",
                    "success": False,
                    "attempt": attempt,
                    "finalError": "Retry cancelled",
                }
            )
            return False
        finally:
            self._retry_abort_controller = None

        return True

    async def _handle_post_agent_run(self) -> bool:
        message = self._last_assistant_message
        self._last_assistant_message = None
        if message is not None:
            if self._is_retryable_error(message) and await self._prepare_retry(message):
                return True

            if message.get("stopReason") == "error" and self._retry_attempt > 0:
                self._emit(
                    {
                        "type": "auto_retry_end",
                        "success": False,
                        "attempt": self._retry_attempt,
                        "finalError": str(message.get("errorMessage") or "Unknown error"),
                    }
                )
                self._retry_attempt = 0

            if await self._check_compaction(cast(AssistantMessage, message)):
                return True

        return self.agent.hasQueuedMessages()

    async def _check_compaction(
        self, assistant_message: AssistantMessage, *, skip_aborted_check: bool = True
    ) -> bool:
        settings = self.settings_manager.get_compaction_settings()
        if not settings.get("enabled"):
            return False
        if skip_aborted_check and assistant_message.get("stopReason") == "aborted":
            return False

        context_window = int((self.model or {}).get("contextWindow", 0) or 0)
        same_model = (
            self.model is not None
            and assistant_message.get("provider") == self.model.get("provider")
            and assistant_message.get("model") == self.model.get("id")
        )
        compaction_entry = get_latest_compaction_entry(self.session_manager.get_branch())
        assistant_timestamp = assistant_message.get("timestamp")
        if compaction_entry is not None and assistant_timestamp is not None:
            try:
                compaction_ts = datetime.fromisoformat(
                    str(compaction_entry.get("timestamp", "")).replace("Z", "+00:00")
                ).timestamp()
                if assistant_timestamp <= compaction_ts * 1000:
                    return False
            except ValueError:
                pass

        if same_model and is_context_overflow(assistant_message, context_window):
            will_retry = assistant_message.get("stopReason") != "stop"
            if not will_retry:
                return await self._run_auto_compaction("overflow", False)
            if self._overflow_recovery_attempted:
                self._emit(
                    {
                        "type": "compaction_end",
                        "reason": "overflow",
                        "result": None,
                        "aborted": False,
                        "willRetry": False,
                        "errorMessage": (
                            "Context overflow recovery failed after one compact-and-retry "
                            "attempt. Try reducing context or switching to a larger-context model."
                        ),
                    }
                )
                return False
            self._overflow_recovery_attempted = True
            messages = self.agent.state.messages
            if messages and messages[-1].get("role") == "assistant":
                self.agent.state.messages = messages[:-1]
            return await self._run_auto_compaction("overflow", will_retry)

        usage = assistant_message.get("usage")
        direct_context_tokens = calculate_context_tokens(usage) if usage else 0
        if assistant_message.get("stopReason") == "error" or direct_context_tokens == 0:
            estimate = estimate_context_tokens(self.agent.state.messages)
            if estimate.last_usage_index is None:
                return False
            usage_msg = self.agent.state.messages[estimate.last_usage_index]
            if (
                compaction_entry is not None
                and usage_msg.get("role") == "assistant"
                and usage_msg.get("timestamp") is not None
                and usage_msg.get("timestamp")
                <= datetime.fromisoformat(
                    str(compaction_entry.get("timestamp", "")).replace("Z", "+00:00")
                ).timestamp()
                * 1000
            ):
                return False
            context_tokens = estimate.tokens
        else:
            context_tokens = direct_context_tokens

        if should_compact(context_tokens, context_window, settings):
            return await self._run_auto_compaction("threshold", False)
        return False

    async def _run_auto_compaction(self, reason: CompactionReason, will_retry: bool) -> bool:
        if not self.model:
            return False
        auth = await self.model_registry.get_api_key_and_headers(self.model)
        if not auth.get("ok") or not auth.get("apiKey"):
            return False

        path_entries = self.session_manager.get_branch()
        settings = self.settings_manager.get_compaction_settings()
        preparation_result = prepare_compaction(path_entries, settings)
        if not preparation_result.ok or not preparation_result.value:
            return False
        preparation = preparation_result.value

        self._emit({"type": "compaction_start", "reason": reason})
        self._auto_compaction_abort_controller = AbortController()
        compaction_result: dict[str, Any] | None = None
        aborted = False
        error_message: str | None = None
        try:
            compact_result = await compact(
                preparation,
                self.model,
                auth.get("apiKey") or "",
                auth.get("headers"),
                None,
                self._auto_compaction_abort_controller.signal,
                self.thinking_level,
            )
            if not compact_result.ok:
                raise compact_result.error
            result = compact_result.value
            self.session_manager.append_compaction(
                result["summary"],
                result["firstKeptEntryId"],
                result["tokensBefore"],
                result.get("details"),
                False,
            )
            session_context = self.session_manager.build_session_context()
            self.agent.state.messages = list(session_context.get("messages", []))
            estimated_tokens_after = estimate_messages_tokens(self.agent.state.messages)
            compaction_result = {
                **result,
                "estimatedTokensAfter": estimated_tokens_after,
            }
            return will_retry
        except Exception as error:
            error_message = str(error)
            if "cancelled" in error_message.lower():
                aborted = True
            return False
        finally:
            self._emit(
                {
                    "type": "compaction_end",
                    "reason": reason,
                    "result": compaction_result,
                    "aborted": aborted,
                    "willRetry": will_retry and compaction_result is not None,
                    "errorMessage": error_message,
                }
            )
            self._auto_compaction_abort_controller = None

    async def _run_agent_prompt(
        self,
        input_val: str | AgentMessage | list[AgentMessage],
        *,
        images: list[ImageContent] | None = None,
    ) -> None:
        if isinstance(input_val, list):
            messages = input_val
        elif isinstance(input_val, dict):
            messages = [input_val]
        else:
            user_content: list[Any] = [{"type": "text", "text": input_val}]
            if images:
                user_content.extend(images)
            messages = [
                {
                    "role": "user",
                    "content": user_content,
                    "timestamp": int(time.time() * 1000),
                }
            ]
            messages.extend(self._pending_next_turn_messages)
            self._pending_next_turn_messages = []

        self._is_agent_run_active = True
        try:
            await self.agent.prompt(messages if len(messages) > 1 else messages[0])
            while await self._handle_post_agent_run():
                await self.agent.continue_run()
        finally:
            await self._emit_agent_settled()

    async def prompt(self, text: str, options: PromptOptions | None = None) -> None:
        opts = options or PromptOptions()
        preflight_result = opts.preflight_result
        messages: list[AgentMessage] | None = None

        try:
            if opts.expand_templates and text.startswith("/"):
                if await self.try_execute_extension_command(text):
                    preflight_result and preflight_result(True)
                    return

            current_text = text
            current_images = opts.images
            runner = self._extension_runner
            if runner is not None and runner.has_handlers("input"):
                input_result = await runner.emit_input(
                    current_text,
                    current_images,
                    opts.source,
                    opts.streaming_behavior if self.is_streaming else None,
                )
                if input_result.get("action") == "handled":
                    preflight_result and preflight_result(True)
                    return
                if input_result.get("action") == "transform":
                    current_text = input_result.get("text", current_text)
                    current_images = input_result.get("images", current_images)

            expanded_text = current_text
            if opts.expand_templates:
                expanded_text = self._expand_skill_command(expanded_text)
                expanded_text = expand_prompt_template(expanded_text, self.prompt_templates)
                if expanded_text.startswith("/") and await self.try_execute_extension_command(
                    expanded_text
                ):
                    preflight_result and preflight_result(True)
                    return

            if not self.model or self.model.get("id") in (None, "unknown"):
                raise RuntimeError(format_no_model_selected_message())

            if self.is_streaming:
                if not opts.streaming_behavior:
                    raise RuntimeError(
                        "Agent is already processing. Specify streaming_behavior "
                        "('steer' or 'followUp') to queue the message."
                    )
                if opts.streaming_behavior == "followUp":
                    await self._queue_follow_up(expanded_text, current_images)
                else:
                    await self._queue_steer(expanded_text, current_images)
                preflight_result and preflight_result(True)
                return

            if not self.model_registry.has_configured_auth(self.model):
                provider = self.model.get("provider", "unknown")
                if self.model_registry.is_using_oauth(self.model):
                    raise RuntimeError(
                        f'Authentication failed for "{provider}". '
                        "Credentials may have expired or network is unavailable. "
                        f"Run '/login {provider}' to re-authenticate."
                    )
                raise RuntimeError(format_no_api_key_found_message(provider))

            last_assistant = self._find_last_assistant_message()
            if last_assistant and await self._check_compaction(
                last_assistant, skip_aborted_check=False
            ):
                # Compaction already ran; the user's new prompt is sent below.
                # Do not continue the agent here (matches TS).
                pass

            user_content: list[Any] = [{"type": "text", "text": expanded_text}]
            if current_images:
                user_content.extend(current_images)
            messages = [
                {
                    "role": "user",
                    "content": user_content,
                    "timestamp": int(time.time() * 1000),
                }
            ]
            messages.extend(self._pending_next_turn_messages)
            self._pending_next_turn_messages = []

            if runner is not None:
                hook_result = await runner.emit_before_agent_start(
                    expanded_text,
                    current_images,
                    self._base_system_prompt,
                    self._base_system_prompt_options,
                )
                if hook_result:
                    for msg in hook_result.get("messages") or []:
                        messages.append(
                            {
                                "role": "custom",
                                "customType": msg["customType"],
                                # Untyped extensions can pass null/missing content; normalize at ingestion.
                                "content": msg.get("content")
                                if msg.get("content") is not None
                                else [],
                                "display": msg.get("display", True),
                                "details": msg.get("details"),
                                "timestamp": int(time.time() * 1000),
                            }
                        )
                    if hook_result.get("systemPrompt") is not None:
                        self.agent.state.systemPrompt = hook_result["systemPrompt"]
                    else:
                        self.agent.state.systemPrompt = self._base_system_prompt
                else:
                    self.agent.state.systemPrompt = self._base_system_prompt
            else:
                self.agent.state.systemPrompt = self._base_system_prompt
        except Exception:
            if preflight_result is not None:
                preflight_result(False)
            raise

        if messages is None:
            return

        if preflight_result is not None:
            preflight_result(True)
        await self._run_agent_prompt(messages)

    @property
    def extension_runner(self) -> ExtensionRunner | None:
        return self._extension_runner

    async def _ensure_extension_runner(self) -> ExtensionRunner:
        if self._extension_runner is not None:
            return self._extension_runner

        if self._no_extensions:
            runtime = create_extension_runtime()
            self._extension_load_result = LoadExtensionsResult(
                extensions=[], errors=[], runtime=runtime
            )
        else:
            if self._extension_paths:
                extension_paths = await collect_configured_extension_paths(
                    self.cwd,
                    str(get_agent_dir()),
                    self.settings_manager,
                    self._extension_paths,
                )
                self._extension_load_result = await discover_and_load_extensions(
                    extension_paths,
                    self.cwd,
                    str(get_agent_dir()),
                )
            else:
                self._extension_load_result = self._resource_loader.get_extensions()
                if (
                    not self._extension_load_result.extensions
                    and not self._extension_load_result.errors
                ):
                    extension_paths = await collect_configured_extension_paths(
                        self.cwd,
                        str(get_agent_dir()),
                        self.settings_manager,
                    )
                    self._extension_load_result = await discover_and_load_extensions(
                        extension_paths,
                        self.cwd,
                        str(get_agent_dir()),
                    )

        load_result = self._extension_load_result
        self._extension_runner = ExtensionRunner(
            load_result.extensions,
            load_result.runtime,
            self.cwd,
            self.session_manager,
            self.model_registry,
        )
        if self._extension_runner_ref is not None:
            self._extension_runner_ref[0] = self._extension_runner
        return self._extension_runner

    def _build_extension_actions(self) -> ExtensionActions:
        def get_active_tools() -> list[str]:
            return self.get_active_tool_names()

        def set_active_tools(tool_names: list[str]) -> None:
            registry = self._tool_registry
            self.agent.state.tools = [registry[name] for name in tool_names if name in registry]
            self._refresh_system_prompt()

        def refresh_tools() -> None:
            self._refresh_tool_registry()

        def get_commands() -> list[dict[str, Any]]:
            runner = self._extension_runner
            if runner is None:
                return []
            return [
                {
                    "name": command.invocation_name,
                    "description": command.description,
                    "source": "extension",
                }
                for command in runner.get_registered_commands()
            ]

        return ExtensionActions(
            send_message=lambda message, options=None: asyncio.create_task(
                self._send_custom_message_safe(message, options)
            ),
            send_user_message=lambda content, options=None: asyncio.create_task(
                self._send_user_message_safe(content, options)
            ),
            append_entry=self._append_entry_from_extension,
            set_session_name=self.set_session_name,
            get_session_name=lambda: self.session_manager.get_session_name(),
            set_label=lambda entry_id, label: self.session_manager.append_label_change(
                entry_id, label
            ),
            get_active_tools=get_active_tools,
            get_all_tools=lambda: [tool["name"] for tool in self.get_all_tools()],
            set_active_tools=set_active_tools,
            refresh_tools=refresh_tools,
            get_commands=get_commands,
            set_model=self._set_model_from_extension,
            get_thinking_level=lambda: self.thinking_level,
            set_thinking_level=self.set_thinking_level,
        )

    async def _send_custom_message_safe(
        self, message: dict[str, Any], options: dict[str, Any] | None
    ) -> None:
        try:
            await self.send_custom_message(message, options)
        except Exception as error:
            self._extension_runtime_error("send_message", error)

    def _append_entry_from_extension(self, custom_type: str, data: Any = None) -> None:
        entry_id = self.session_manager.append_custom_entry(custom_type, data)
        entry = self.session_manager.get_entry(entry_id)
        if entry is not None:
            self._emit({"type": "entry_appended", "entry": entry})

    async def _send_user_message_safe(
        self, content: str | list[dict[str, Any]], options: dict[str, Any] | None
    ) -> None:
        try:
            await self.send_user_message(content, options)
        except Exception as error:
            self._extension_runtime_error("send_user_message", error)

    async def _set_model_from_extension(self, model: Model[Any]) -> bool:
        await self.set_model(model)
        return True

    def _build_extension_context_actions(self) -> ExtensionContextActions:
        def compact(options: Any = None) -> None:
            opts = options or {}

            async def run_compact() -> None:
                try:
                    result = await self.compact(opts.get("customInstructions"))
                    on_complete = opts.get("onComplete")
                    if callable(on_complete):
                        on_complete(result)
                except Exception as error:
                    on_error = opts.get("onError")
                    if callable(on_error):
                        on_error(error)

            asyncio.create_task(run_compact())

        def abort() -> None:
            if self._extension_abort_handler is not None:
                self._extension_abort_handler()
                return
            asyncio.create_task(self.abort())

        return ExtensionContextActions(
            get_model=lambda: self.model,
            is_idle=lambda: self.is_idle,
            get_signal=lambda: self.agent.signal,
            abort=abort,
            has_pending_messages=lambda: self.pending_message_count > 0,
            shutdown=lambda: (
                self._extension_shutdown_handler() if self._extension_shutdown_handler else None
            ),
            get_context_usage=self.get_context_usage,
            compact=compact,
            get_system_prompt=lambda: self.system_prompt,
            get_system_prompt_options=lambda: self._base_system_prompt_options,
        )

    async def bind_extensions(self, **kwargs: Any) -> None:
        mode = kwargs.get("mode", "print")
        ui_context = kwargs.get("ui_context")
        command_context_actions = kwargs.get("command_context_actions")
        on_error = kwargs.get("on_error")
        shutdown_handler = kwargs.get("shutdown_handler")
        abort_handler = kwargs.get("abort_handler")
        extension_paths = kwargs.get("extension_paths")
        no_extensions = kwargs.get("no_extensions")

        if shutdown_handler is not None:
            self.set_extension_shutdown_handler(shutdown_handler)
        if abort_handler is not None:
            self.set_extension_abort_handler(abort_handler)

        if extension_paths is not None:
            self._extension_paths = list(extension_paths)
        if no_extensions is not None:
            self._no_extensions = bool(no_extensions)

        runner = await self._ensure_extension_runner()
        if not self._agent_tool_hooks_installed:
            self._install_agent_tool_hooks()
        runner.bind_core(self._build_extension_actions(), self._build_extension_context_actions())
        runner.set_ui_context(ui_context, mode)
        self._extension_mode = mode

        if command_context_actions is not None:
            if isinstance(command_context_actions, ExtensionCommandContextActions):
                runner.bind_command_context(command_context_actions)
            else:
                runner.bind_command_context(
                    ExtensionCommandContextActions(
                        wait_for_idle=command_context_actions.get("waitForIdle", _async_noop),
                        new_session=command_context_actions.get(
                            "newSession", _async_cancelled_false
                        ),
                        fork=command_context_actions.get("fork", _async_cancelled_false_entry),
                        navigate_tree=command_context_actions.get(
                            "navigateTree", _async_cancelled_false_entry
                        ),
                        switch_session=command_context_actions.get(
                            "switchSession", _async_cancelled_false_entry
                        ),
                        reload=command_context_actions.get("reload", _async_noop),
                    )
                )
        else:
            runner.bind_command_context(None)

        if self._extension_error_unsubscribe is not None:
            self._extension_error_unsubscribe()
            self._extension_error_unsubscribe = None
        if on_error is not None:
            self._extension_error_unsubscribe = runner.on_error(on_error)

        session_start_event: dict[str, Any] = {
            "type": "session_start",
            "reason": self._session_start_reason,
        }
        if self._session_start_previous_file:
            session_start_event["previousSessionFile"] = self._session_start_previous_file
        await runner.emit(session_start_event)
        self._refresh_tool_registry()
        await runner.emit_resources_discover(self.cwd, "startup")

    async def reload(self) -> None:
        runner = self._extension_runner
        if runner is not None:
            await emit_session_shutdown_event(
                runner, {"type": "session_shutdown", "reason": "reload"}
            )
        await self._resource_loader.reload()
        self._refresh_system_prompt()
        context = self.session_manager.build_session_context()
        self.agent.state.messages = list(context.get("messages", []))

    def dispose_for_replacement(self) -> None:
        if self._disposed:
            return
        try:
            self.abort_retry()
            if self._compaction_abort_controller is not None:
                self._compaction_abort_controller.abort()
            self.agent.abort()
        except Exception:
            pass
        runner = self._extension_runner
        if runner is not None:
            runner.invalidate(_STALE_EXTENSION_CTX_MESSAGE)
        if self._extension_error_unsubscribe is not None:
            self._extension_error_unsubscribe()
            self._extension_error_unsubscribe = None
        if self._agent_listener is not None:
            self._agent_listener()
            self._agent_listener = None
        self._listeners.clear()
        self._event_bus.clear()
        self._disposed = True

    def dispose(self) -> None:
        if self._disposed:
            return
        runner = self._extension_runner
        if runner is not None:
            asyncio.create_task(
                emit_session_shutdown_event(runner, {"type": "session_shutdown", "reason": "quit"})
            )
        self._disposed = True
        if self._extension_error_unsubscribe is not None:
            self._extension_error_unsubscribe()
            self._extension_error_unsubscribe = None
        if self._agent_listener is not None:
            self._agent_listener()
            self._agent_listener = None
        self._listeners.clear()
        self._event_bus.clear()


async def _async_noop(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _async_cancelled_false(*_args: Any, **_kwargs: Any) -> dict[str, bool]:
    return {"cancelled": False}


async def _async_cancelled_false_entry(_entry: str, *_args: Any, **_kwargs: Any) -> dict[str, bool]:
    return {"cancelled": False}


def _extract_user_message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


CreateAgentSessionRuntimeResult = tuple[AgentSession, Any, list[dict[str, str]], str | None]
CreateAgentSessionRuntimeFactory = Callable[
    ...,
    Awaitable[CreateAgentSessionRuntimeResult],
]


class SessionImportFileNotFoundError(FileNotFoundError):
    def __init__(self, path: str) -> None:
        super().__init__(f"Session import file not found: {path}")
        self.path = path


@dataclass
class AgentSessionRuntime:
    session: AgentSession
    services: Any
    diagnostics: list[dict[str, str]]
    model_fallback_message: str | None = None
    _create_runtime: CreateAgentSessionRuntimeFactory | None = None
    _rebind_session: Callable[[], Awaitable[None]] | None = None
    _before_session_invalidate: Callable[[], None] | None = None

    def set_rebind_session(self, handler: Callable[[], Awaitable[None]]) -> None:
        self._rebind_session = handler

    def set_before_session_invalidate(self, handler: Callable[[], None] | None) -> None:
        self._before_session_invalidate = handler

    async def dispose(self) -> None:
        self.session.dispose()

    async def _emit_before_switch(
        self, reason: Literal["new", "resume"], target_session_file: str | None = None
    ) -> bool:
        runner = getattr(self.session, "extension_runner", None)
        if runner is None or not runner.has_handlers("session_before_switch"):
            return False
        result = await runner.emit(
            {
                "type": "session_before_switch",
                "reason": reason,
                "targetSessionFile": target_session_file,
            }
        )
        return bool(result and result.get("cancel"))

    async def _emit_before_fork(self, entry_id: str, position: Literal["before", "at"]) -> bool:
        runner = getattr(self.session, "extension_runner", None)
        if runner is None or not runner.has_handlers("session_before_fork"):
            return False
        result = await runner.emit(
            {
                "type": "session_before_fork",
                "entryId": entry_id,
                "position": position,
            }
        )
        return bool(result and result.get("cancel"))

    async def _teardown_current(
        self, reason: Literal["new", "resume", "fork"], target_session_file: str | None = None
    ) -> None:
        runner = getattr(self.session, "extension_runner", None)
        if runner is not None:
            shutdown_event: dict[str, Any] = {
                "type": "session_shutdown",
                "reason": reason,
            }
            if target_session_file:
                shutdown_event["targetSessionFile"] = target_session_file
            await emit_session_shutdown_event(runner, shutdown_event)  # type: ignore[arg-type]
        if self._before_session_invalidate is not None:
            self._before_session_invalidate()
        dispose_for_replacement = getattr(self.session, "dispose_for_replacement", None)
        if dispose_for_replacement is not None:
            dispose_for_replacement()

    async def _apply_runtime(
        self,
        session_manager: SessionManager,
        *,
        reason: str,
        previous_session_file: str | None,
    ) -> None:
        if self._create_runtime is not None:
            agent_dir = getattr(self.services, "agent_dir", None) or str(get_agent_dir())
            session, services, diagnostics, model_fallback_message = await self._create_runtime(
                cwd=session_manager.get_cwd(),
                agent_dir=agent_dir,
                session_manager=session_manager,
                session_start_event={
                    "type": "session_start",
                    "reason": reason,
                    "previousSessionFile": previous_session_file,
                },
            )
            self.session = session
            self.services = services
            self.diagnostics = diagnostics
            self.model_fallback_message = model_fallback_message
        else:
            self.session._session_start_reason = reason
            self.session._session_start_previous_file = previous_session_file
            self.session.session_manager = session_manager
            self.session._disposed = False
            await self.session.reload()

    async def _finish_replacement(
        self, with_session: Callable[[Any], Awaitable[None]] | None = None
    ) -> None:
        if self._rebind_session is not None:
            result = self._rebind_session()
            if hasattr(result, "__await__"):
                await result
        if with_session is not None:
            await with_session(self.session.create_replaced_session_context())

    async def new_session(self, options: dict[str, Any] | None = None) -> dict[str, bool]:
        if await self._emit_before_switch("new"):
            return {"cancelled": True}

        opts = options or {}
        with_session = opts.get("withSession") or opts.get("with_session")

        previous_session_file = self.session.session_file
        session_dir = self.session.session_manager.get_session_dir()
        if self.session.session_manager.is_persisted():
            session_manager = SessionManager.create(self.session.cwd, session_dir)
        else:
            session_manager = SessionManager.in_memory(self.session.cwd)
        if opts.get("parentSession"):
            session_manager.new_session({"parentSession": opts["parentSession"]})

        await self._teardown_current("new", session_manager.get_session_file())
        await self._apply_runtime(
            session_manager,
            reason="new",
            previous_session_file=previous_session_file,
        )
        await self._finish_replacement(with_session)
        return {"cancelled": False}

    async def fork(
        self,
        entry_id: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {}
        with_session = opts.get("withSession") or opts.get("with_session")
        position = opts.get("position", "before")
        if await self._emit_before_fork(entry_id, position):
            return {"cancelled": True}

        selected_entry = self.session.session_manager.get_entry(entry_id)
        if not selected_entry:
            raise RuntimeError("Invalid entry ID for forking")

        selected_text: str | None = None
        if position == "at":
            target_leaf_id = selected_entry.get("id")
        else:
            if (
                selected_entry.get("type") != "message"
                or selected_entry.get("message", {}).get("role") != "user"
            ):
                raise RuntimeError("Invalid entry ID for forking")
            target_leaf_id = selected_entry.get("parentId")
            selected_text = _extract_user_message_text(
                selected_entry.get("message", {}).get("content")
            )

        previous_session_file = self.session.session_file
        session_manager = self.session.session_manager

        if session_manager.is_persisted():
            current_session_file = session_manager.get_session_file()
            if not current_session_file:
                raise RuntimeError("Persisted session is missing a session file")
            session_dir = session_manager.get_session_dir()
            if not target_leaf_id:
                new_session_manager = SessionManager.create(self.session.cwd, session_dir)
                new_session_manager.new_session({"parentSession": current_session_file})
                await self._teardown_current("fork", new_session_manager.get_session_file())
                await self._apply_runtime(
                    new_session_manager,
                    reason="fork",
                    previous_session_file=previous_session_file,
                )
            else:
                branched_manager = SessionManager.open(current_session_file, session_dir)
                forked_session_path = branched_manager.create_branched_session(str(target_leaf_id))
                if not forked_session_path:
                    raise RuntimeError("Failed to create forked session")
                await self._teardown_current("fork", branched_manager.get_session_file())
                await self._apply_runtime(
                    branched_manager,
                    reason="fork",
                    previous_session_file=previous_session_file,
                )
        else:
            if not target_leaf_id:
                session_manager.new_session({"parentSession": self.session.session_file})
            else:
                session_manager.create_branched_session(str(target_leaf_id))
            await self._teardown_current("fork", session_manager.get_session_file())
            await self._apply_runtime(
                session_manager,
                reason="fork",
                previous_session_file=previous_session_file,
            )

        await self._finish_replacement(with_session)
        return {"cancelled": False, "selectedText": selected_text}

    async def switch_session(
        self,
        session_path: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, bool]:
        opts = options or {}
        with_session = opts.get("withSession") or opts.get("with_session")
        resolved_path = resolve_path(session_path)
        if await self._emit_before_switch("resume", resolved_path):
            return {"cancelled": True}

        previous_session_file = self.session.session_file
        cwd_override = opts.get("cwdOverride")
        session_manager = SessionManager.open(resolved_path, None, cwd_override)
        assert_session_cwd_exists(session_manager, self.session.cwd)
        await self._teardown_current("resume", session_manager.get_session_file())
        await self._apply_runtime(
            session_manager,
            reason="resume",
            previous_session_file=previous_session_file,
        )
        await self._finish_replacement(with_session)
        return {"cancelled": False}

    async def import_from_jsonl(
        self,
        input_path: str,
        cwd_override: str | None = None,
    ) -> dict[str, bool]:
        resolved_path = resolve_path(input_path)
        if not os.path.exists(resolved_path):
            raise SessionImportFileNotFoundError(resolved_path)

        session_dir = self.session.session_manager.get_session_dir()
        if session_dir:
            os.makedirs(session_dir, exist_ok=True)

        destination_path = os.path.join(session_dir or "", os.path.basename(resolved_path))
        if await self._emit_before_switch("resume", destination_path):
            return {"cancelled": True}

        previous_session_file = self.session.session_file
        if os.path.abspath(destination_path) != os.path.abspath(resolved_path):
            shutil.copy2(resolved_path, destination_path)
        else:
            destination_path = resolved_path

        session_manager = SessionManager.open(destination_path, session_dir, cwd_override)
        assert_session_cwd_exists(session_manager, self.session.cwd)
        await self._teardown_current("resume", session_manager.get_session_file())
        await self._apply_runtime(
            session_manager,
            reason="resume",
            previous_session_file=previous_session_file,
        )
        await self._finish_replacement()
        return {"cancelled": False}
