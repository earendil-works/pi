"""RPC mode: headless JSON stdin/stdout protocol.

Ported from packages/coding-agent/src/modes/rpc/rpc-mode.ts.
"""

from __future__ import annotations

import asyncio
import json
import signal
import sys
import uuid
from typing import Any, Awaitable, Callable, Literal

from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime, PromptOptions
from pi_mono.coding_agent.core.extensions.types import ExtensionUIContext
from pi_mono.coding_agent.core.source_info import SourceInfo
from pi_mono.coding_agent.modes.rpc.jsonl import JsonlLineReader, serialize_json_line
from pi_mono.coding_agent.modes.rpc.rpc_types import (
    RpcCommand,
    RpcExtensionUIRequest,
    RpcExtensionUIResponse,
    RpcResponse,
    RpcSessionState,
    RpcSlashCommand,
)
from pi_mono.core.output_guard import (
    flush_raw_stdout,
    take_over_stdout,
    wait_for_raw_stdout_backpressure,
    write_raw_stdout,
)
from pi_mono.utils.shell import kill_tracked_detached_children


def parse_rpc_command(line: str) -> RpcCommand:
    parsed = json.loads(line)
    if not isinstance(parsed, dict):
        raise ValueError("RPC command must be a JSON object")
    if "type" not in parsed:
        raise ValueError("RPC command missing type field")
    return parsed  # type: ignore[return-value]


def build_success_response(
    command_id: str | None,
    command: str,
    data: Any | None = None,
) -> RpcResponse:
    response: RpcResponse = {
        "id": command_id,
        "type": "response",
        "command": command,
        "success": True,
    }
    if data is not None:
        response["data"] = data  # type: ignore[index]
    return response


def build_error_response(command_id: str | None, command: str, message: str) -> RpcResponse:
    return {
        "id": command_id,
        "type": "response",
        "command": command,
        "success": False,
        "error": message,
    }


def build_session_state(session) -> RpcSessionState:
    return {
        "model": session.model,
        "thinkingLevel": session.thinking_level,
        "isStreaming": session.is_streaming,
        "isCompacting": session.is_compacting,
        "steeringMode": session.steering_mode,
        "followUpMode": session.follow_up_mode,
        "sessionFile": session.session_file,
        "sessionId": session.session_id,
        "sessionName": session.session_name,
        "autoCompactionEnabled": session.auto_compaction_enabled,
        "messageCount": len(session.messages),
        "pendingMessageCount": session.pending_message_count,
    }


PendingExtensionResolver = Callable[[RpcExtensionUIResponse], None]


class RpcExtensionUIContext:
    """Extension UI context that emits extension_ui_request over RPC stdout."""

    def __init__(
        self,
        output: Callable[[dict[str, Any]], None],
        pending_requests: dict[str, PendingExtensionResolver],
    ) -> None:
        self._output = output
        self._pending_requests = pending_requests

    def _emit_request(self, request: RpcExtensionUIRequest) -> None:
        self._output(dict(request))

    def _create_dialog_promise(
        self,
        request: dict[str, Any],
        default_value: Any,
        parse_response: Callable[[RpcExtensionUIResponse], Any],
        opts: dict[str, Any] | None = None,
    ) -> Awaitable[Any]:
        async def _dialog() -> Any:
            signal = opts.get("signal") if opts else None
            if signal is not None and getattr(signal, "aborted", False):
                return default_value

            request_id = str(uuid.uuid4())
            loop = asyncio.get_running_loop()
            future: asyncio.Future[Any] = loop.create_future()

            def resolve_response(response: RpcExtensionUIResponse) -> None:
                if not future.done():
                    future.set_result(parse_response(response))

            self._pending_requests[request_id] = resolve_response
            self._emit_request({"type": "extension_ui_request", "id": request_id, **request})

            timeout_ms = opts.get("timeout") if opts else None
            if timeout_ms is not None:
                try:
                    return await asyncio.wait_for(future, timeout_ms / 1000)
                except TimeoutError:
                    self._pending_requests.pop(request_id, None)
                    return default_value
            return await future

        return _dialog()

    async def select(
        self, title: str, options: list[str], opts: dict[str, Any] | None = None
    ) -> str | None:
        return await self._create_dialog_promise(
            {
                "method": "select",
                "title": title,
                "options": options,
                "timeout": opts.get("timeout") if opts else None,
            },
            None,
            lambda response: None if response.get("cancelled") else response.get("value"),
            opts,
        )

    async def confirm(self, title: str, message: str, opts: dict[str, Any] | None = None) -> bool:
        return bool(
            await self._create_dialog_promise(
                {
                    "method": "confirm",
                    "title": title,
                    "message": message,
                    "timeout": opts.get("timeout") if opts else None,
                },
                False,
                lambda response: (
                    False if response.get("cancelled") else bool(response.get("confirmed"))
                ),
                opts,
            )
        )

    async def input(
        self,
        title: str,
        placeholder: str | None = None,
        opts: dict[str, Any] | None = None,
    ) -> str | None:
        return await self._create_dialog_promise(
            {
                "method": "input",
                "title": title,
                "placeholder": placeholder,
                "timeout": opts.get("timeout") if opts else None,
            },
            None,
            lambda response: None if response.get("cancelled") else response.get("value"),
            opts,
        )

    def notify(self, message: str, type: Literal["info", "warning", "error"] | None = None) -> None:
        self._emit_request(
            {
                "type": "extension_ui_request",
                "id": str(uuid.uuid4()),
                "method": "notify",
                "message": message,
                "notifyType": type,
            }
        )

    def set_status(self, key: str, text: str | None) -> None:
        self._emit_request(
            {
                "type": "extension_ui_request",
                "id": str(uuid.uuid4()),
                "method": "setStatus",
                "statusKey": key,
                "statusText": text,
            }
        )

    def set_widget(
        self,
        key: str,
        content: list[str] | None,
        options: dict[str, Any] | None = None,
    ) -> None:
        if content is None or isinstance(content, list):
            self._emit_request(
                {
                    "type": "extension_ui_request",
                    "id": str(uuid.uuid4()),
                    "method": "setWidget",
                    "widgetKey": key,
                    "widgetLines": content,
                    "widgetPlacement": options.get("placement") if options else None,
                }
            )

    def set_title(self, title: str) -> None:
        self._emit_request(
            {
                "type": "extension_ui_request",
                "id": str(uuid.uuid4()),
                "method": "setTitle",
                "title": title,
            }
        )

    def set_editor_text(self, text: str) -> None:
        self._emit_request(
            {
                "type": "extension_ui_request",
                "id": str(uuid.uuid4()),
                "method": "set_editor_text",
                "text": text,
            }
        )

    async def editor(self, title: str, prefill: str | None = None) -> str | None:
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str | None] = loop.create_future()

        def resolve_response(response: RpcExtensionUIResponse) -> None:
            if future.done():
                return
            if response.get("cancelled"):
                future.set_result(None)
            elif "value" in response:
                future.set_result(str(response["value"]))
            else:
                future.set_result(None)

        self._pending_requests[request_id] = resolve_response
        self._emit_request(
            {
                "type": "extension_ui_request",
                "id": request_id,
                "method": "editor",
                "title": title,
                "prefill": prefill,
            }
        )
        return await future

    def on_terminal_input(self, _handler: Any) -> Callable[[], None]:
        return lambda: None

    def set_working_message(self, _message: str) -> None:
        return None

    def set_working_visible(self, _visible: bool) -> None:
        return None

    def set_working_indicator(self, _visible: bool) -> None:
        return None

    def set_hidden_thinking_label(self, _label: str | None) -> None:
        return None

    def set_footer(self, _lines: list[str] | None) -> None:
        return None

    def set_header(self, _lines: list[str] | None) -> None:
        return None

    def paste_to_editor(self, text: str) -> None:
        self.set_editor_text(text)

    def get_editor_text(self) -> str:
        return ""

    async def custom(self, _request: dict[str, Any]) -> Any:
        return None

    def add_autocomplete_provider(self, _provider: Any) -> Callable[[], None]:
        return lambda: None

    def set_editor_component(self, _component: Any) -> None:
        return None

    def get_editor_component(self) -> Any:
        return None

    def get_tools_expanded(self) -> bool:
        return False

    def set_tools_expanded(self, _expanded: bool) -> None:
        return None


def _source_info_to_rpc(source_info: SourceInfo | dict[str, Any] | None) -> dict[str, Any]:
    if source_info is None:
        return {}
    if isinstance(source_info, SourceInfo):
        payload: dict[str, Any] = {
            "path": source_info.path,
            "source": source_info.source,
            "scope": source_info.scope,
            "origin": source_info.origin,
        }
        if source_info.base_dir is not None:
            payload["baseDir"] = source_info.base_dir
        return payload
    return dict(source_info)


def build_prompt_template_commands(session) -> list[RpcSlashCommand]:
    commands: list[RpcSlashCommand] = []
    for template in session.prompt_templates:
        name = template["name"] if isinstance(template, dict) else template.name
        description = (
            template.get("description", "")
            if isinstance(template, dict)
            else (template.description or "")
        )
        source_info = (
            template.get("sourceInfo")
            if isinstance(template, dict)
            else getattr(template, "source_info", None)
        )
        commands.append(
            {
                "name": name,
                "description": description,
                "source": "prompt",
                "sourceInfo": _source_info_to_rpc(source_info),
            }
        )
    return commands


def build_skill_commands(session) -> list[RpcSlashCommand]:
    commands: list[RpcSlashCommand] = []
    for skill in session.resource_loader.get_skills().get("skills", []):
        name = skill["name"] if isinstance(skill, dict) else skill.name
        description = skill.get("description", "") if isinstance(skill, dict) else skill.description
        source_info = (
            skill.get("sourceInfo")
            if isinstance(skill, dict)
            else getattr(skill, "source_info", None)
        )
        commands.append(
            {
                "name": f"skill:{name}",
                "description": description,
                "source": "skill",
                "sourceInfo": _source_info_to_rpc(source_info),
            }
        )
    return commands


def build_extension_commands(session) -> list[RpcSlashCommand]:
    runner = session.extension_runner
    if runner is None:
        return []
    return [
        {
            "name": command.invocation_name,
            "description": command.description or "",
            "source": "extension",
            "sourceInfo": {
                "scope": command.source_info.get("scope", "extension"),
                "source": command.source_info.get("source", "extension"),
                "path": command.source_info.get("path", ""),
            },
        }
        for command in runner.get_registered_commands()
    ]


class RpcMode:
    """JSONL RPC server over stdin/stdout."""

    def __init__(self, runtime_host: AgentSessionRuntime) -> None:
        self._runtime_host = runtime_host
        self._session = runtime_host.session
        self._unsubscribe = None
        self._unsubscribe_backpressure = None
        self._backpressure_listener = None
        self._shutting_down = False
        self._signal_handlers: list[tuple[int, Any]] = []
        self._pending_extension_requests: dict[str, PendingExtensionResolver] = {}
        self._pending_input_tasks: set[asyncio.Task[Any]] = set()
        self._extension_ui_context = RpcExtensionUIContext(
            self.output, self._pending_extension_requests
        )
        runtime_host.set_rebind_session(self._rebind_session)

    def output(self, obj: dict[str, Any]) -> None:
        write_raw_stdout(serialize_json_line(obj))

    def get_extension_ui_context(self) -> ExtensionUIContext:
        return self._extension_ui_context

    def handle_extension_ui_response(self, response: RpcExtensionUIResponse) -> bool:
        request_id = response.get("id")
        if not isinstance(request_id, str):
            return False
        pending = self._pending_extension_requests.pop(request_id, None)
        if pending is None:
            return False
        pending(response)
        return True

    async def _rebind_session(self) -> None:
        self._session = self._runtime_host.session
        await self._session.bind_extensions(
            ui_context=self._extension_ui_context,
            mode="rpc",
            command_context_actions={
                "waitForIdle": self._wait_for_idle,
                "newSession": self._runtime_host.new_session,
                "fork": self._runtime_host.fork,
                "navigateTree": self._session.navigate_tree,
                "switchSession": self._runtime_host.switch_session,
                "reload": self._session.reload,
            },
            on_error=lambda error: self.output(
                {
                    "type": "extension_error",
                    "extensionPath": error.extension_path,
                    "event": error.event,
                    "error": error.error,
                }
            ),
        )
        if self._unsubscribe is not None:
            self._unsubscribe()
        if self._unsubscribe_backpressure is not None:
            self._unsubscribe_backpressure()

        async def backpressure_listener(_event: object, _signal: object) -> None:
            await wait_for_raw_stdout_backpressure()

        self._backpressure_listener = backpressure_listener
        self._unsubscribe = self._session.subscribe(self.output)
        self._unsubscribe_backpressure = self._session.agent.subscribe(backpressure_listener)

    async def _wait_for_idle(self) -> None:
        while self._session.is_streaming:
            await asyncio.sleep(0.05)

    async def handle_command(self, command: RpcCommand) -> RpcResponse | None:
        command_id = command.get("id")  # type: ignore[union-attr]
        command_type = command.get("type")  # type: ignore[union-attr]

        if command_type == "prompt":
            message = command.get("message")  # type: ignore[union-attr]
            if not isinstance(message, str):
                return build_error_response(command_id, "prompt", "prompt.message must be a string")
            images = command.get("images")  # type: ignore[union-attr]
            streaming_behavior = command.get("streamingBehavior")  # type: ignore[union-attr]
            preflight_succeeded = False

            def preflight_result(success: bool) -> None:
                nonlocal preflight_succeeded
                if success:
                    preflight_succeeded = True
                    self.output(build_success_response(command_id, "prompt"))

            prompt_options = PromptOptions(
                images=images if isinstance(images, list) else None,
                source="rpc",
                preflight_result=preflight_result,
            )
            if streaming_behavior in ("steer", "followUp"):
                prompt_options.streaming_behavior = streaming_behavior  # type: ignore[assignment]

            async def _run_prompt() -> None:
                try:
                    await self._session.prompt(message, prompt_options)
                except Exception as error:
                    if not preflight_succeeded:
                        self.output(build_error_response(command_id, "prompt", str(error)))
                await wait_for_raw_stdout_backpressure()

            asyncio.create_task(_run_prompt())
            return None

        if command_type == "steer":
            message = command.get("message")  # type: ignore[union-attr]
            if not isinstance(message, str):
                return build_error_response(command_id, "steer", "steer.message must be a string")
            images = command.get("images")  # type: ignore[union-attr]
            await self._session.steer(message, images)
            return build_success_response(command_id, "steer")

        if command_type == "follow_up":
            message = command.get("message")  # type: ignore[union-attr]
            if not isinstance(message, str):
                return build_error_response(
                    command_id, "follow_up", "follow_up.message must be a string"
                )
            images = command.get("images")  # type: ignore[union-attr]
            await self._session.follow_up(message, images)
            return build_success_response(command_id, "follow_up")

        if command_type == "abort":
            await self._session.abort()
            return build_success_response(command_id, "abort")

        if command_type == "new_session":
            parent_session = command.get("parentSession")  # type: ignore[union-attr]
            options = {"parentSession": parent_session} if isinstance(parent_session, str) else None
            result = await self._runtime_host.new_session(options)
            if not result.get("cancelled"):
                await self._rebind_session()
            return build_success_response(command_id, "new_session", result)

        if command_type == "get_state":
            return build_success_response(
                command_id, "get_state", build_session_state(self._session)
            )

        if command_type == "set_model":
            provider = command.get("provider")  # type: ignore[union-attr]
            model_id = command.get("modelId")  # type: ignore[union-attr]
            model = self._session.model_registry.find(str(provider), str(model_id))
            if model is None:
                return build_error_response(
                    command_id, "set_model", f"Model not found: {provider}/{model_id}"
                )
            await self._session.set_model(model)
            return build_success_response(command_id, "set_model", model)

        if command_type == "cycle_model":
            result = await self._session.cycle_model()
            response = build_success_response(command_id, "cycle_model")
            response["data"] = result  # type: ignore[index]
            return response

        if command_type == "get_available_models":
            models = self._session.model_registry.get_available()
            return build_success_response(command_id, "get_available_models", {"models": models})

        if command_type == "set_thinking_level":
            level = command.get("level")  # type: ignore[union-attr]
            self._session.set_thinking_level(level)  # type: ignore[arg-type]
            return build_success_response(command_id, "set_thinking_level")

        if command_type == "cycle_thinking_level":
            level = self._session.cycle_thinking_level()
            response = build_success_response(command_id, "cycle_thinking_level")
            response["data"] = None if level is None else {"level": level}  # type: ignore[index]
            return response

        if command_type == "set_steering_mode":
            mode = command.get("mode")  # type: ignore[union-attr]
            self._session.set_steering_mode(mode)  # type: ignore[arg-type]
            return build_success_response(command_id, "set_steering_mode")

        if command_type == "set_follow_up_mode":
            mode = command.get("mode")  # type: ignore[union-attr]
            self._session.set_follow_up_mode(mode)  # type: ignore[arg-type]
            return build_success_response(command_id, "set_follow_up_mode")

        if command_type == "compact":
            custom_instructions = command.get("customInstructions")  # type: ignore[union-attr]
            result = await self._session.compact(custom_instructions)
            return build_success_response(command_id, "compact", result)

        if command_type == "bash":
            bash_command = command.get("command")  # type: ignore[union-attr]
            if not isinstance(bash_command, str):
                return build_error_response(command_id, "bash", "bash.command must be a string")
            exclude_from_context = bool(command.get("excludeFromContext"))  # type: ignore[union-attr]
            result = await self._session.execute_bash(
                bash_command,
                exclude_from_context=exclude_from_context,
            )
            return build_success_response(
                command_id,
                "bash",
                {
                    "output": result.output,
                    "exitCode": result.exit_code,
                    "cancelled": result.cancelled,
                    "truncated": result.truncated,
                    "fullOutputPath": result.full_output_path,
                },
            )

        if command_type == "get_session_stats":
            return build_success_response(
                command_id, "get_session_stats", self._session.get_session_stats()
            )

        if command_type == "get_last_assistant_text":
            text = self._session.get_last_assistant_text()
            return build_success_response(command_id, "get_last_assistant_text", {"text": text})

        if command_type == "set_session_name":
            name = str(command.get("name", "")).strip()  # type: ignore[union-attr]
            if not name:
                return build_error_response(
                    command_id, "set_session_name", "Session name cannot be empty"
                )
            self._session.set_session_name(name)
            return build_success_response(command_id, "set_session_name")

        if command_type == "fork":
            entry_id = command.get("entryId")  # type: ignore[union-attr]
            if not isinstance(entry_id, str):
                return build_error_response(command_id, "fork", "fork.entryId must be a string")
            result = await self._runtime_host.fork(entry_id)
            if not result.get("cancelled"):
                await self._rebind_session()
            return build_success_response(
                command_id,
                "fork",
                {"text": result.get("selectedText"), "cancelled": result.get("cancelled", False)},
            )

        if command_type == "switch_session":
            session_path = command.get("sessionPath")  # type: ignore[union-attr]
            if not isinstance(session_path, str):
                return build_error_response(
                    command_id, "switch_session", "switch_session.sessionPath must be a string"
                )
            result = await self._runtime_host.switch_session(session_path)
            if not result.get("cancelled"):
                await self._rebind_session()
            return build_success_response(command_id, "switch_session", result)

        if command_type == "get_fork_messages":
            messages = self._session.get_user_messages_for_forking()
            return build_success_response(command_id, "get_fork_messages", {"messages": messages})

        if command_type == "get_messages":
            return build_success_response(
                command_id, "get_messages", {"messages": self._session.messages}
            )

        if command_type == "get_commands":
            commands = [
                *build_extension_commands(self._session),
                *build_prompt_template_commands(self._session),
                *build_skill_commands(self._session),
            ]
            return build_success_response(command_id, "get_commands", {"commands": commands})

        if command_type == "export_html":
            output_path = command.get("outputPath")  # type: ignore[union-attr]
            theme_name = command.get("themeName")  # type: ignore[union-attr]
            path = await self._session.export_to_html(
                str(output_path) if isinstance(output_path, str) else None,
                theme_name=str(theme_name) if isinstance(theme_name, str) else None,
            )
            return build_success_response(command_id, "export_html", {"path": path})

        if command_type == "clone":
            leaf_id = self._session.session_manager.get_leaf_id()
            if not leaf_id:
                return build_error_response(
                    command_id,
                    "clone",
                    "Cannot clone session: no current entry selected",
                )
            result = await self._runtime_host.fork(leaf_id, {"position": "at"})
            if not result.get("cancelled"):
                await self._rebind_session()
            return build_success_response(
                command_id,
                "clone",
                {"cancelled": result.get("cancelled", False)},
            )

        if command_type == "abort_bash":
            self._session.abort_bash()
            return build_success_response(command_id, "abort_bash")

        if command_type == "set_auto_compaction":
            enabled = command.get("enabled")  # type: ignore[union-attr]
            self._session.settings_manager.set_compaction_enabled(bool(enabled))
            return build_success_response(command_id, "set_auto_compaction")

        if command_type == "set_auto_retry":
            enabled = command.get("enabled")  # type: ignore[union-attr]
            self._session.set_auto_retry(bool(enabled))
            return build_success_response(command_id, "set_auto_retry")

        if command_type == "abort_retry":
            self._session.abort_retry()
            return build_success_response(command_id, "abort_retry")

        return build_error_response(
            command_id, str(command_type), f"Unknown command: {command_type}"
        )

    async def handle_input_line(self, line: str) -> None:
        try:
            parsed = json.loads(line)
        except Exception as error:
            self.output(build_error_response(None, "parse", f"Failed to parse command: {error}"))
            await wait_for_raw_stdout_backpressure()
            return

        if isinstance(parsed, dict) and parsed.get("type") == "extension_ui_response":
            self.handle_extension_ui_response(parsed)  # type: ignore[arg-type]
            return

        try:
            command = parse_rpc_command(line)
        except Exception as error:
            self.output(build_error_response(None, "parse", f"Failed to parse command: {error}"))
            await wait_for_raw_stdout_backpressure()
            return

        try:
            response = await self.handle_command(command)
            if response is not None:
                self.output(response)
                await wait_for_raw_stdout_backpressure()
        except Exception as error:
            command_id = command.get("id") if isinstance(command, dict) else None
            command_type = command.get("type") if isinstance(command, dict) else "unknown"
            self.output(build_error_response(command_id, str(command_type), str(error)))
            await wait_for_raw_stdout_backpressure()

    def _register_signal_handlers(self) -> None:
        for signum in (signal.SIGTERM, signal.SIGHUP):
            try:
                previous = signal.getsignal(signum)

                def handler(_signum: int, _frame: object | None, _previous: Any = previous) -> None:
                    kill_tracked_detached_children()
                    asyncio.create_task(self.shutdown(_signum))

                signal.signal(signum, handler)
                self._signal_handlers.append((signum, previous))
            except (AttributeError, ValueError, OSError):
                pass

    def _unregister_signal_handlers(self) -> None:
        for signum, previous in self._signal_handlers:
            try:
                signal.signal(signum, previous)
            except (AttributeError, ValueError, OSError):
                pass
        self._signal_handlers.clear()

    async def shutdown(self, signum: int | None = None) -> None:
        if self._shutting_down:
            if signum is not None:
                raise SystemExit(129 if signum == signal.SIGHUP else 143)
            return
        self._shutting_down = True
        self._unregister_signal_handlers()
        kill_tracked_detached_children()
        if self._unsubscribe is not None:
            self._unsubscribe()
        if self._unsubscribe_backpressure is not None:
            self._unsubscribe_backpressure()
        await self._runtime_host.dispose()
        if signum != signal.SIGTERM:
            await flush_raw_stdout()
        if signum is not None:
            raise SystemExit(129 if signum == signal.SIGHUP else 143)

    def _enqueue_input_line(self, line: str) -> None:
        task = asyncio.create_task(self.handle_input_line(line))
        self._pending_input_tasks.add(task)
        task.add_done_callback(self._pending_input_tasks.discard)

    async def run(self) -> None:
        take_over_stdout()
        self._register_signal_handlers()
        await self._rebind_session()

        reader = JsonlLineReader(self._enqueue_input_line)
        await self._stdin_reader_loop(reader)

    async def _stdin_reader_loop(self, reader: JsonlLineReader) -> None:
        while not self._shutting_down:
            chunk = await asyncio.to_thread(sys.stdin.buffer.read, 65536)
            if not chunk:
                reader.flush()
                if self._pending_input_tasks:
                    await asyncio.gather(*list(self._pending_input_tasks), return_exceptions=True)
                await wait_for_raw_stdout_backpressure()
                await self.shutdown()
                return
            reader.feed(chunk.decode("utf-8", errors="replace"))


async def run_rpc_mode(runtime_host: AgentSessionRuntime) -> None:
    mode = RpcMode(runtime_host)
    await mode.run()
