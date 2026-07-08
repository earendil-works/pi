"""Extension runner - executes extensions and manages their lifecycle."""

from __future__ import annotations

import copy
from typing import Any, Callable, Literal

from pi_mono.agent.types import AgentMessage
from pi_mono.ai.types import ImageContent, Model
from pi_mono.coding_agent.core.extensions.types import (
    CompactOptions,
    ContextUsage,
    Extension,
    ExtensionActions,
    ExtensionCommandContext,
    ExtensionCommandContextActions,
    ExtensionContext,
    ExtensionContextActions,
    ExtensionError,
    ExtensionFlag,
    ExtensionMode,
    ExtensionRuntime,
    ExtensionShortcut,
    ExtensionUIContext,
    InputEventResult,
    ProviderConfig,
    RegisteredCommand,
    RegisteredTool,
    ResolvedCommand,
    ResourcesDiscoverEvent,
    SessionShutdownEvent,
    ToolCallEventResult,
    ToolResultEventResult,
    UserBashEventResult,
)
from pi_mono.coding_agent.core.keybindings import DEFAULT_APP_KEYBINDINGS
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager

RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = {
    "app.interrupt",
    "app.clear",
    "app.exit",
    "app.suspend",
    "app.thinking.cycle",
    "app.model.cycleForward",
    "app.model.cycleBackward",
    "app.model.select",
    "app.tools.expand",
    "app.thinking.toggle",
    "app.editor.external",
    "app.message.followUp",
    "tui.input.submit",
    "tui.select.confirm",
    "tui.select.cancel",
    "tui.input.copy",
    "tui.editor.deleteToLineEnd",
}

ExtensionErrorListener = Callable[[ExtensionError], None]


class _NoOpUIContext:
    async def select(
        self, _title: str, _options: list[str], _opts: dict[str, Any] | None = None
    ) -> None:
        return None

    async def confirm(
        self, _title: str, _message: str, _opts: dict[str, Any] | None = None
    ) -> bool:
        return False

    async def input(
        self,
        _title: str,
        _placeholder: str | None = None,
        _opts: dict[str, Any] | None = None,
    ) -> None:
        return None

    def notify(self, _message: str, _type: str | None = None) -> None:
        return None


NO_OP_UI_CONTEXT = _NoOpUIContext()


def _build_builtin_keybindings(
    resolved_keybindings: dict[str, str | list[str]],
) -> dict[str, dict[str, Any]]:
    builtin_keybindings: dict[str, dict[str, Any]] = {}
    for keybinding, keys in resolved_keybindings.items():
        if keys is None:
            continue
        key_list = keys if isinstance(keys, list) else [keys]
        restrict_override = keybinding in RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS
        for key in key_list:
            normalized_key = key.lower()
            existing = builtin_keybindings.get(normalized_key)
            if existing and existing.get("restrictOverride") and not restrict_override:
                continue
            builtin_keybindings[normalized_key] = {
                "keybinding": keybinding,
                "restrictOverride": restrict_override,
            }
    return builtin_keybindings


async def emit_session_shutdown_event(
    extension_runner: "ExtensionRunner", event: SessionShutdownEvent
) -> bool:
    if extension_runner.has_handlers("session_shutdown"):
        await extension_runner.emit(event)
        return True
    return False


class ExtensionRunner:
    def __init__(
        self,
        extensions: list[Extension],
        runtime: ExtensionRuntime,
        cwd: str,
        session_manager: SessionManager,
        model_registry: ModelRegistry,
    ) -> None:
        self._extensions = extensions
        self._runtime = runtime
        self._ui_context: ExtensionUIContext = NO_OP_UI_CONTEXT
        self._mode: ExtensionMode = "print"
        self._cwd = cwd
        self._session_manager = session_manager
        self._model_registry = model_registry
        self._error_listeners: set[ExtensionErrorListener] = set()
        self._get_model: Callable[[], Model[Any] | None] = lambda: None
        self._is_idle_fn: Callable[[], bool] = lambda: True
        self._get_signal_fn: Callable[[], Any] = lambda: None
        self._wait_for_idle_fn: Callable[[], Any] = _async_noop
        self._abort_fn: Callable[[], None] = lambda: None
        self._has_pending_messages_fn: Callable[[], bool] = lambda: False
        self._get_context_usage_fn: Callable[[], ContextUsage | None] = lambda: None
        self._compact_fn: Callable[[CompactOptions | None], None] = lambda *_a: None
        self._get_system_prompt_fn: Callable[[], str] = lambda: ""
        self._get_system_prompt_options_fn: Callable[[], dict[str, Any]] = lambda: {"cwd": cwd}
        self._new_session_handler: Callable[[dict[str, Any] | None], Any] = _async_cancelled_false
        self._fork_handler: Callable[[str, dict[str, Any] | None], Any] = (
            _async_cancelled_false_entry
        )
        self._navigate_tree_handler: Callable[[str, dict[str, Any] | None], Any] = (
            _async_cancelled_false_entry
        )
        self._switch_session_handler: Callable[[str, dict[str, Any] | None], Any] = (
            _async_cancelled_false_entry
        )
        self._reload_handler: Callable[[], Any] = _async_noop
        self._shutdown_handler: Callable[[], None] = lambda: None
        self._shortcut_diagnostics: list[dict[str, str]] = []
        self._command_diagnostics: list[dict[str, str]] = []
        self._stale_message: str | None = None

    def bind_core(
        self,
        actions: ExtensionActions,
        context_actions: ExtensionContextActions,
        provider_actions: dict[str, Callable[..., None]] | None = None,
    ) -> None:
        self._runtime.send_message = actions.send_message
        self._runtime.send_user_message = actions.send_user_message
        self._runtime.append_entry = actions.append_entry
        self._runtime.set_session_name = actions.set_session_name
        self._runtime.get_session_name = actions.get_session_name
        self._runtime.set_label = actions.set_label
        self._runtime.get_active_tools = actions.get_active_tools
        self._runtime.get_all_tools = actions.get_all_tools
        self._runtime.set_active_tools = actions.set_active_tools
        self._runtime.refresh_tools = actions.refresh_tools
        self._runtime.get_commands = actions.get_commands
        self._runtime.set_model = actions.set_model
        self._runtime.get_thinking_level = actions.get_thinking_level
        self._runtime.set_thinking_level = actions.set_thinking_level

        self._get_model = context_actions.get_model
        self._is_idle_fn = context_actions.is_idle
        self._get_signal_fn = context_actions.get_signal
        self._abort_fn = context_actions.abort
        self._has_pending_messages_fn = context_actions.has_pending_messages
        self._shutdown_handler = context_actions.shutdown
        self._get_context_usage_fn = context_actions.get_context_usage
        self._compact_fn = context_actions.compact
        self._get_system_prompt_fn = context_actions.get_system_prompt
        if context_actions.get_system_prompt_options is not None:
            self._get_system_prompt_options_fn = context_actions.get_system_prompt_options

        for item in self._runtime.pending_provider_registrations:
            try:
                if provider_actions and provider_actions.get("registerProvider"):
                    provider_actions["registerProvider"](item["name"], item["config"])
                else:
                    self._model_registry.register_provider(item["name"], item["config"])
            except Exception as err:
                self.emit_error(
                    ExtensionError(
                        extension_path=item.get("extensionPath", "<unknown>"),
                        event="register_provider",
                        error=str(err),
                    )
                )
        self._runtime.pending_provider_registrations = []

        def register_provider(
            name: str, config: ProviderConfig, extension_path: str = "<unknown>"
        ) -> None:
            del extension_path
            if provider_actions and provider_actions.get("registerProvider"):
                provider_actions["registerProvider"](name, config)
            else:
                self._model_registry.register_provider(name, config)

        def unregister_provider(name: str, extension_path: str | None = None) -> None:
            del extension_path
            if provider_actions and provider_actions.get("unregisterProvider"):
                provider_actions["unregisterProvider"](name)
            else:
                self._model_registry.unregister_provider(name)

        self._runtime.register_provider = register_provider
        self._runtime.unregister_provider = unregister_provider

    def bind_command_context(self, actions: ExtensionCommandContextActions | None = None) -> None:
        if actions is not None:
            self._wait_for_idle_fn = actions.wait_for_idle
            self._new_session_handler = actions.new_session
            self._fork_handler = actions.fork
            self._navigate_tree_handler = actions.navigate_tree
            self._switch_session_handler = actions.switch_session
            self._reload_handler = actions.reload
            return
        self._wait_for_idle_fn = _async_noop
        self._new_session_handler = _async_cancelled_false
        self._fork_handler = _async_cancelled_false_entry
        self._navigate_tree_handler = _async_cancelled_false_entry
        self._switch_session_handler = _async_cancelled_false_entry
        self._reload_handler = _async_noop

    def set_ui_context(
        self,
        ui_context: ExtensionUIContext | None = None,
        mode: ExtensionMode = "print",
    ) -> None:
        self._ui_context = ui_context or NO_OP_UI_CONTEXT
        self._mode = mode

    def get_ui_context(self) -> ExtensionUIContext:
        return self._ui_context

    def has_ui(self) -> bool:
        return self._ui_context is not NO_OP_UI_CONTEXT

    def get_extension_paths(self) -> list[str]:
        return [extension.path for extension in self._extensions]

    def get_all_registered_tools(self) -> list[RegisteredTool]:
        tools_by_name: dict[str, RegisteredTool] = {}
        for extension in self._extensions:
            for tool in extension.tools.values():
                if tool.definition.name not in tools_by_name:
                    tools_by_name[tool.definition.name] = tool
        return list(tools_by_name.values())

    def get_tool_definition(self, tool_name: str) -> Any | None:
        for extension in self._extensions:
            tool = extension.tools.get(tool_name)
            if tool is not None:
                return tool.definition
        return None

    def get_flags(self) -> dict[str, ExtensionFlag]:
        all_flags: dict[str, ExtensionFlag] = {}
        for extension in self._extensions:
            for name, flag in extension.flags.items():
                if name not in all_flags:
                    all_flags[name] = flag
        return all_flags

    def set_flag_value(self, name: str, value: bool | str) -> None:
        self._runtime.flag_values[name] = value

    def get_flag_values(self) -> dict[str, bool | str]:
        return dict(self._runtime.flag_values)

    def get_shortcuts(
        self, resolved_keybindings: dict[str, str | list[str]]
    ) -> dict[str, ExtensionShortcut]:
        self._shortcut_diagnostics = []
        builtin_keybindings = _build_builtin_keybindings(resolved_keybindings)
        extension_shortcuts: dict[str, ExtensionShortcut] = {}

        def add_diagnostic(message: str, extension_path: str) -> None:
            self._shortcut_diagnostics.append(
                {"type": "warning", "message": message, "path": extension_path}
            )

        for extension in self._extensions:
            for key, shortcut in extension.shortcuts.items():
                normalized_key = key.lower()
                built_in = builtin_keybindings.get(normalized_key)
                if built_in and built_in.get("restrictOverride"):
                    add_diagnostic(
                        f"Extension shortcut '{key}' from {shortcut.extension_path} conflicts with built-in shortcut. Skipping.",
                        shortcut.extension_path,
                    )
                    continue
                extension_shortcuts[normalized_key] = shortcut
        return extension_shortcuts

    def get_shortcut_diagnostics(self) -> list[dict[str, str]]:
        return self._shortcut_diagnostics

    def invalidate(self, message: str | None = None) -> None:
        if self._stale_message is None:
            self._stale_message = (
                message or "This extension ctx is stale after session replacement or reload."
            )
            self._runtime.invalidate(self._stale_message)

    def _assert_active(self) -> None:
        if self._stale_message:
            raise RuntimeError(self._stale_message)

    def on_error(self, listener: ExtensionErrorListener) -> Callable[[], None]:
        self._error_listeners.add(listener)

        def unsubscribe() -> None:
            self._error_listeners.discard(listener)

        return unsubscribe

    def emit_error(self, error: ExtensionError) -> None:
        for listener in self._error_listeners:
            listener(error)

    def has_handlers(self, event_type: str) -> bool:
        for extension in self._extensions:
            handlers = extension.handlers.get(event_type)
            if handlers:
                return True
        return False

    def get_message_renderer(self, custom_type: str) -> Any | None:
        for extension in self._extensions:
            renderer = extension.message_renderers.get(custom_type)
            if renderer is not None:
                return renderer
        return None

    def _resolve_registered_commands(self) -> list[ResolvedCommand]:
        commands: list[RegisteredCommand] = []
        counts: dict[str, int] = {}
        for extension in self._extensions:
            for command in extension.commands.values():
                commands.append(command)
                counts[command.name] = counts.get(command.name, 0) + 1

        seen: dict[str, int] = {}
        taken_invocation_names: set[str] = set()
        resolved: list[ResolvedCommand] = []
        for command in commands:
            occurrence = seen.get(command.name, 0) + 1
            seen[command.name] = occurrence
            invocation_name = (
                f"{command.name}:{occurrence}" if counts.get(command.name, 0) > 1 else command.name
            )
            if invocation_name in taken_invocation_names:
                suffix = occurrence
                while invocation_name in taken_invocation_names:
                    suffix += 1
                    invocation_name = f"{command.name}:{suffix}"
            taken_invocation_names.add(invocation_name)
            resolved.append(
                ResolvedCommand(
                    name=command.name,
                    source_info=command.source_info,
                    handler=command.handler,
                    description=command.description,
                    invocation_name=invocation_name,
                )
            )
        return resolved

    def get_registered_commands(self) -> list[ResolvedCommand]:
        self._command_diagnostics = []
        return self._resolve_registered_commands()

    def get_command(self, name: str) -> ResolvedCommand | None:
        return next(
            (cmd for cmd in self._resolve_registered_commands() if cmd.invocation_name == name),
            None,
        )

    def shutdown(self) -> None:
        self._shutdown_handler()

    def create_context(self) -> ExtensionContext:
        runner = self

        class _Context:
            @property
            def ui(self) -> ExtensionUIContext:
                runner._assert_active()
                return runner._ui_context

            @property
            def mode(self) -> ExtensionMode:
                runner._assert_active()
                return runner._mode

            @property
            def has_ui(self) -> bool:
                runner._assert_active()
                return runner.has_ui()

            @property
            def cwd(self) -> str:
                runner._assert_active()
                return runner._cwd

            @property
            def session_manager(self) -> SessionManager:
                runner._assert_active()
                return runner._session_manager

            @property
            def model_registry(self) -> ModelRegistry:
                runner._assert_active()
                return runner._model_registry

            @property
            def model(self) -> Model[Any] | None:
                runner._assert_active()
                return runner._get_model()

            def is_idle(self) -> bool:
                runner._assert_active()
                return runner._is_idle_fn()

            @property
            def signal(self) -> Any:
                runner._assert_active()
                return runner._get_signal_fn()

            def abort(self) -> None:
                runner._assert_active()
                runner._abort_fn()

            def has_pending_messages(self) -> bool:
                runner._assert_active()
                return runner._has_pending_messages_fn()

            def shutdown(self) -> None:
                runner._assert_active()
                runner._shutdown_handler()

            def get_context_usage(self) -> ContextUsage | None:
                runner._assert_active()
                return runner._get_context_usage_fn()

            def compact(self, options: CompactOptions | None = None) -> None:
                runner._assert_active()
                runner._compact_fn(options)

            def get_system_prompt(self) -> str:
                runner._assert_active()
                return runner._get_system_prompt_fn()

        return _Context()  # type: ignore[return-value]

    def create_command_context(self) -> ExtensionCommandContext:
        context = self.create_context()

        class _CommandContext:
            ui = property(lambda self: context.ui)
            mode = property(lambda self: context.mode)
            has_ui = property(lambda self: context.has_ui)
            cwd = property(lambda self: context.cwd)
            session_manager = property(lambda self: context.session_manager)
            model_registry = property(lambda self: context.model_registry)
            model = property(lambda self: context.model)
            signal = property(lambda self: context.signal)

            def is_idle(self) -> bool:
                return context.is_idle()

            def abort(self) -> None:
                context.abort()

            def has_pending_messages(self) -> bool:
                return context.has_pending_messages()

            def shutdown(self) -> None:
                context.shutdown()

            def get_context_usage(self) -> ContextUsage | None:
                return context.get_context_usage()

            def compact(self, options: CompactOptions | None = None) -> None:
                context.compact(options)

            def get_system_prompt(self) -> str:
                return context.get_system_prompt()

            def get_system_prompt_options(self) -> dict[str, Any]:
                self._assert_active()
                return self._runner._get_system_prompt_options_fn()

            async def wait_for_idle(self) -> None:
                self._assert_active()
                await self._runner._wait_for_idle_fn()

            async def new_session(self, options: dict[str, Any] | None = None) -> dict[str, bool]:
                self._assert_active()
                return await self._runner._new_session_handler(options)

            async def fork(
                self, entry_id: str, options: dict[str, Any] | None = None
            ) -> dict[str, bool]:
                self._assert_active()
                return await self._runner._fork_handler(entry_id, options)

            async def navigate_tree(
                self, target_id: str, options: dict[str, Any] | None = None
            ) -> dict[str, bool]:
                self._assert_active()
                return await self._runner._navigate_tree_handler(target_id, options)

            async def switch_session(
                self, session_path: str, options: dict[str, Any] | None = None
            ) -> dict[str, bool]:
                self._assert_active()
                return await self._runner._switch_session_handler(session_path, options)

            async def reload(self) -> None:
                self._assert_active()
                await self._runner._reload_handler()

            def _assert_active(self) -> None:
                self._runner._assert_active()

            def __init__(self, runner: ExtensionRunner) -> None:
                self._runner = runner

        return _CommandContext(self)  # type: ignore[return-value]

    async def emit(self, event: dict[str, Any]) -> dict[str, Any] | None:
        ctx = self.create_context()
        result: dict[str, Any] | None = None
        event_type = event.get("type")
        if not isinstance(event_type, str):
            return None

        for extension in self._extensions:
            handlers = extension.handlers.get(event_type, [])
            for handler in handlers:
                try:
                    handler_result = handler(event, ctx)
                    if hasattr(handler_result, "__await__"):
                        handler_result = await handler_result
                    if event_type.startswith("session_before_") and handler_result:
                        result = handler_result
                        if result.get("cancel"):
                            return result
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event=event_type,
                            error=str(err),
                        )
                    )
        return result

    async def emit_message_end(self, event: dict[str, Any]) -> AgentMessage | None:
        ctx = self.create_context()
        current_message = event["message"]
        modified = False
        for extension in self._extensions:
            for handler in extension.handlers.get("message_end", []):
                try:
                    current_event = {**event, "message": current_message}
                    handler_result = await _maybe_await(handler(current_event, ctx))
                    if not handler_result or not handler_result.get("message"):
                        continue
                    replacement = handler_result["message"]
                    if replacement.get("role") != current_message.get("role"):
                        self.emit_error(
                            ExtensionError(
                                extension_path=extension.path,
                                event="message_end",
                                error="message_end handlers must return a message with the same role",
                            )
                        )
                        continue
                    current_message = replacement
                    modified = True
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="message_end",
                            error=str(err),
                        )
                    )
        return current_message if modified else None

    async def emit_tool_result(self, event: dict[str, Any]) -> ToolResultEventResult | None:
        ctx = self.create_context()
        current_event = dict(event)
        modified = False
        for extension in self._extensions:
            for handler in extension.handlers.get("tool_result", []):
                try:
                    handler_result = await _maybe_await(handler(current_event, ctx))
                    if not handler_result:
                        continue
                    if handler_result.get("content") is not None:
                        current_event["content"] = handler_result["content"]
                        modified = True
                    if handler_result.get("details") is not None:
                        current_event["details"] = handler_result["details"]
                        modified = True
                    if handler_result.get("isError") is not None:
                        current_event["isError"] = handler_result["isError"]
                        modified = True
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="tool_result",
                            error=str(err),
                        )
                    )
        if not modified:
            return None
        return {
            "content": current_event.get("content"),
            "details": current_event.get("details"),
            "isError": current_event.get("isError"),
        }

    async def emit_tool_call(self, event: dict[str, Any]) -> ToolCallEventResult | None:
        ctx = self.create_context()
        result: ToolCallEventResult | None = None
        for extension in self._extensions:
            for handler in extension.handlers.get("tool_call", []):
                handler_result = await _maybe_await(handler(event, ctx))
                if handler_result:
                    result = handler_result
                    if result.get("block"):
                        return result
        return result

    async def emit_user_bash(self, event: dict[str, Any]) -> UserBashEventResult | None:
        ctx = self.create_context()
        for extension in self._extensions:
            for handler in extension.handlers.get("user_bash", []):
                try:
                    handler_result = await _maybe_await(handler(event, ctx))
                    if handler_result:
                        return handler_result
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="user_bash",
                            error=str(err),
                        )
                    )
        return None

    async def emit_context(self, messages: list[AgentMessage]) -> list[AgentMessage]:
        ctx = self.create_context()
        current_messages = copy.deepcopy(messages)
        for extension in self._extensions:
            for handler in extension.handlers.get("context", []):
                try:
                    event = {"type": "context", "messages": current_messages}
                    handler_result = await _maybe_await(handler(event, ctx))
                    if handler_result and handler_result.get("messages"):
                        current_messages = handler_result["messages"]
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="context",
                            error=str(err),
                        )
                    )
        return current_messages

    async def emit_before_provider_request(self, payload: Any) -> Any:
        ctx = self.create_context()
        current_payload = payload
        for extension in self._extensions:
            for handler in extension.handlers.get("before_provider_request", []):
                try:
                    event = {"type": "before_provider_request", "payload": current_payload}
                    handler_result = await _maybe_await(handler(event, ctx))
                    if handler_result is not None:
                        current_payload = handler_result
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="before_provider_request",
                            error=str(err),
                        )
                    )
        return current_payload

    async def emit_before_agent_start(
        self,
        prompt: str,
        images: list[ImageContent] | None,
        system_prompt: str,
        system_prompt_options: dict[str, Any],
    ) -> dict[str, Any] | None:
        current_system_prompt = system_prompt
        ctx = self.create_context()
        messages: list[dict[str, Any]] = []
        system_prompt_modified = False
        for extension in self._extensions:
            for handler in extension.handlers.get("before_agent_start", []):
                try:
                    event = {
                        "type": "before_agent_start",
                        "prompt": prompt,
                        "images": images,
                        "systemPrompt": current_system_prompt,
                        "systemPromptOptions": system_prompt_options,
                    }
                    handler_result = await _maybe_await(handler(event, ctx))
                    if handler_result:
                        if handler_result.get("message"):
                            messages.append(handler_result["message"])
                        if handler_result.get("systemPrompt") is not None:
                            current_system_prompt = handler_result["systemPrompt"]
                            system_prompt_modified = True
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="before_agent_start",
                            error=str(err),
                        )
                    )
        if messages or system_prompt_modified:
            return {
                "messages": messages or None,
                "systemPrompt": current_system_prompt if system_prompt_modified else None,
            }
        return None

    async def emit_resources_discover(
        self,
        cwd: str,
        reason: Literal["startup", "reload"],
    ) -> dict[str, list[dict[str, str]]]:
        ctx = self.create_context()
        skill_paths: list[dict[str, str]] = []
        prompt_paths: list[dict[str, str]] = []
        theme_paths: list[dict[str, str]] = []
        for extension in self._extensions:
            for handler in extension.handlers.get("resources_discover", []):
                try:
                    event: ResourcesDiscoverEvent = {
                        "type": "resources_discover",
                        "cwd": cwd,
                        "reason": reason,
                    }
                    handler_result = await _maybe_await(handler(event, ctx))
                    if handler_result:
                        for path in handler_result.get("skillPaths", []) or []:
                            skill_paths.append({"path": path, "extensionPath": extension.path})
                        for path in handler_result.get("promptPaths", []) or []:
                            prompt_paths.append({"path": path, "extensionPath": extension.path})
                        for path in handler_result.get("themePaths", []) or []:
                            theme_paths.append({"path": path, "extensionPath": extension.path})
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="resources_discover",
                            error=str(err),
                        )
                    )
        return {"skillPaths": skill_paths, "promptPaths": prompt_paths, "themePaths": theme_paths}

    async def emit_input(
        self,
        text: str,
        images: list[ImageContent] | None,
        source: str,
        streaming_behavior: str | None = None,
    ) -> InputEventResult:
        ctx = self.create_context()
        current_text = text
        current_images = images
        for extension in self._extensions:
            for handler in extension.handlers.get("input", []):
                try:
                    event = {
                        "type": "input",
                        "text": current_text,
                        "images": current_images,
                        "source": source,
                        "streamingBehavior": streaming_behavior,
                    }
                    result = await _maybe_await(handler(event, ctx))
                    if result and result.get("action") == "handled":
                        return result
                    if result and result.get("action") == "transform":
                        current_text = result.get("text", current_text)
                        current_images = result.get("images", current_images)
                except Exception as err:
                    self.emit_error(
                        ExtensionError(
                            extension_path=extension.path,
                            event="input",
                            error=str(err),
                        )
                    )
        if current_text != text or current_images is not images:
            return {"action": "transform", "text": current_text, "images": current_images}
        return {"action": "continue"}

    def get_default_keybindings(self) -> dict[str, str | list[str]]:
        resolved: dict[str, str | list[str]] = {}
        for key, definition in DEFAULT_APP_KEYBINDINGS.items():
            keys = definition.default_keys
            resolved[key] = keys if isinstance(keys, list) else keys
        return resolved


async def _async_noop(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _async_cancelled_false(*_args: Any, **_kwargs: Any) -> dict[str, bool]:
    return {"cancelled": False}


async def _async_cancelled_false_entry(_entry: str, *_args: Any, **_kwargs: Any) -> dict[str, bool]:
    return {"cancelled": False}


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value
