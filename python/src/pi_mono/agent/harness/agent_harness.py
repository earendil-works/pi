"""Agent Harness - Main orchestration class for agent runs."""

from __future__ import annotations

import asyncio
import inspect
import os
from collections.abc import Awaitable, Callable
from typing import Any, Generic

from pi_mono.ai.types import Model
from pi_mono.utils.abort_signals import AbortController, AbortSignal
from pi_mono.agent.harness.compaction.branch_summarization import (
    generate_branch_summary,
    collect_entries_for_branch_summary,
)
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.compaction.compaction import (
    prepare_compaction,
    compact,
    DEFAULT_COMPACTION_SETTINGS,
)
from pi_mono.agent.harness.messages import create_user_message, create_failure_message
from pi_mono.agent.harness.prompt_templates import format_prompt_template_invocation
from pi_mono.agent.harness.skills import format_skill_invocation
from pi_mono.agent.harness.types import (
    AgentEvent,
    AgentHarnessError,
    AgentHarnessEvent,
    AgentHarnessOptions,
    AgentHarnessOwnEvent,
    AgentHarnessPhase,
    AgentHarnessStreamOptions,
    AgentHarnessTurnState,
    AgentLoopConfig,
    AgentMessage,
    NavigateTreeResult,
    PendingSessionWrite,
    QueueMode,
    StreamFn,
    TSkill,
    TPromptTemplate,
    TTool,
    apply_stream_options_patch,
    clone_stream_options,
    get_harness_option,
    merge_headers,
    normalize_harness_error,
    normalize_hook_error,
    stream_options_to_dict,
    tool_name,
)
from pi_mono.agent.types import AgentContext  # Import from main agent types
from pi_mono.agent.agent_loop import run_agent_loop
from pi_mono.ai.stream import stream_simple


SUBSCRIBER_EVENT_TYPE = "*"

AgentHarnessHandler = Callable[[Any, AbortSignal | None], Awaitable[Any] | Any]


def _create_abort_controller() -> AbortController:
    return AbortController()


def _create_abort_signal() -> AbortSignal:
    controller = _create_abort_controller()
    return controller.signal


class AgentHarness(Generic[TSkill, TPromptTemplate, TTool]):
    """Agent Harness - orchestrates agent runs with session management, tools, and hooks."""

    def __init__(
        self,
        options: AgentHarnessOptions[TSkill, TPromptTemplate, TTool],
    ) -> None:
        env = options.get("env")
        if env is None:
            session = options["session"]
            cwd = getattr(session, "cwd", None) or os.getcwd()
            env = LocalExecutionEnv(cwd=cwd)
        self.env = env
        self.session = options["session"]
        self.resources = get_harness_option(options, "resources", "resources", {}) or {}
        self.stream_options = clone_stream_options(
            get_harness_option(options, "stream_options", "streamOptions")
        )
        self.system_prompt = get_harness_option(
            options, "system_prompt", "systemPrompt", "You are a helpful assistant."
        )
        self.get_api_key_and_headers = get_harness_option(
            options, "get_api_key_and_headers", "getApiKeyAndHeaders"
        )
        self.model = options["model"]
        self.thinking_level = get_harness_option(options, "thinking_level", "thinkingLevel", "off")
        self.tools: dict[str, TTool] = {}
        self.active_tool_names: list[str] = []
        self.steering_queue_mode: QueueMode = "one-at-a-time"
        self.follow_up_queue_mode: QueueMode = "one-at-a-time"

        tools_list = get_harness_option(options, "tools", "tools", []) or []
        self.validate_unique_names(
            [tool_name(tool) for tool in tools_list], "Duplicate tool name(s)"
        )
        for tool in tools_list:
            self.tools[tool_name(tool)] = tool

        active_tool_names = get_harness_option(options, "active_tool_names", "activeToolNames")
        self.active_tool_names = (
            list(active_tool_names) if active_tool_names is not None else list(self.tools.keys())
        )
        self.validate_unique_names(self.active_tool_names, "Duplicate active tool name(s)")
        self.validate_tool_names(self.active_tool_names)

        self.steering_queue_mode = get_harness_option(
            options, "steering_mode", "steeringMode", "one-at-a-time"
        )
        self.follow_up_queue_mode = get_harness_option(
            options, "follow_up_mode", "followUpMode", "one-at-a-time"
        )

        # State
        self.phase: AgentHarnessPhase = "idle"
        self.run_abort_controller: AbortController | None = None
        self.run_promise: asyncio.Future[None] | None = None
        self.pending_session_writes: list[PendingSessionWrite] = []
        self.steer_queue: list[AgentMessage] = []
        self.follow_up_queue: list[AgentMessage] = []
        self.next_turn_queue: list[AgentMessage] = []
        self.handlers: dict[str, list[AgentHarnessHandler]] = {}

    # =========================================================================
    # Validation Helpers
    # =========================================================================

    def validate_unique_names(self, names: list[str], message: str) -> None:
        seen = set()
        duplicates = set()
        for name in names:
            if name in seen:
                duplicates.add(name)
            seen.add(name)
        if duplicates:
            raise AgentHarnessError(
                "invalid_argument", f"{message}: {', '.join(sorted(duplicates))}"
            )

    def validate_tool_names(
        self, tool_names: list[str], tools: dict[str, TTool] | None = None
    ) -> None:
        tools = tools or self.tools
        self.validate_unique_names(tool_names, "Duplicate active tool name(s)")
        missing = [name for name in tool_names if name not in tools]
        if missing:
            raise AgentHarnessError("invalid_argument", f"Unknown tool(s): {', '.join(missing)}")

    # =========================================================================
    # Event Emission
    # =========================================================================

    def _get_handlers(self, event_type: str) -> list[AgentHarnessHandler] | None:
        return self.handlers.get(event_type)

    async def _maybe_await_listener(self, result: Any) -> Any:
        if inspect.isawaitable(result):
            return await result
        return result

    async def _emit_own(
        self,
        event: AgentHarnessOwnEvent[TSkill, TPromptTemplate],
        signal: AbortSignal | None = None,
    ) -> None:
        for listener in self._get_handlers(SUBSCRIBER_EVENT_TYPE) or []:
            try:
                await self._maybe_await_listener(listener(event, signal))
            except Exception as e:
                raise normalize_hook_error(e)

    async def _emit_any(
        self, event: AgentHarnessEvent[TSkill, TPromptTemplate], signal: AbortSignal | None = None
    ) -> None:
        for listener in self._get_handlers(SUBSCRIBER_EVENT_TYPE) or []:
            try:
                await self._maybe_await_listener(listener(event, signal))
            except Exception as e:
                raise normalize_hook_error(e)

    async def _emit_hook(
        self,
        event: AgentHarnessOwnEvent[TSkill, TPromptTemplate],
    ) -> Any:
        handlers = self._get_handlers(event["type"])
        if not handlers:
            return None

        last_result = None
        for handler in handlers:
            try:
                result = await self._maybe_await_listener(handler(event))
                if result is not None:
                    last_result = result
            except Exception as e:
                raise normalize_hook_error(e)
        return last_result

    async def _emit_before_provider_request(
        self,
        model: Model[Any],
        session_id: str,
        stream_options: AgentHarnessStreamOptions,
    ) -> AgentHarnessStreamOptions:
        current = clone_stream_options(stream_options)
        handlers = self._get_handlers("before_provider_request")
        if not handlers:
            return current

        for handler in handlers:
            try:
                result = await self._maybe_await_listener(
                    handler(
                        {
                            "type": "before_provider_request",
                            "model": model,
                            "sessionId": session_id,
                            "streamOptions": stream_options_to_dict(clone_stream_options(current)),
                        }
                    )
                )
                if result and result.get("streamOptions"):
                    current = apply_stream_options_patch(current, result["streamOptions"])
            except Exception as e:
                raise normalize_hook_error(e)
        return current

    async def _emit_before_provider_payload(self, model: Model[Any], payload: Any) -> Any:
        current = payload
        handlers = self._get_handlers("before_provider_payload")
        if not handlers:
            return current

        for handler in handlers:
            try:
                result = await self._maybe_await_listener(
                    handler({"type": "before_provider_payload", "model": model, "payload": current})
                )
                if result is not None:
                    current = result.get("payload", current)
            except Exception as e:
                raise normalize_hook_error(e)
        return current

    async def _emit_queue_update(self) -> None:
        await self._emit_own(
            {
                "type": "queue_update",
                "steer": list(self.steer_queue),
                "followUp": list(self.follow_up_queue),
                "nextTurn": list(self.next_turn_queue),
            }
        )

    # =========================================================================
    # Turn State & Context
    # =========================================================================

    def _start_run_promise(self) -> Callable[[], None]:
        loop = asyncio.get_running_loop()
        run_promise = loop.create_future()
        self.run_promise = run_promise

        def finish() -> None:
            self.run_promise = None
            if not run_promise.done():
                run_promise.set_result(None)

        return finish

    async def _create_turn_state(self) -> AgentHarnessTurnState[TSkill, TPromptTemplate, TTool]:
        context = await self.session.build_context()
        resources = self.get_resources()
        session_metadata = await self.session.get_metadata()
        tools = list(self.tools.values())
        active_tools = [self.tools[name] for name in self.active_tool_names if name in self.tools]

        if callable(self.system_prompt):
            system_prompt = await self._maybe_await_listener(
                self.system_prompt(
                    {
                        "env": self.env,
                        "session": self.session,
                        "model": self.model,
                        "thinkingLevel": self.thinking_level,
                        "activeTools": active_tools,
                        "resources": resources,
                    }
                )
            )
        else:
            system_prompt = self.system_prompt or "You are a helpful assistant."

        return {
            "messages": context.messages,
            "resources": resources,
            "streamOptions": stream_options_to_dict(clone_stream_options(self.stream_options)),
            "sessionId": (
                session_metadata["id"]
                if isinstance(session_metadata, dict)
                else session_metadata.id
            ),
            "systemPrompt": system_prompt,
            "model": self.model,
            "thinkingLevel": self.thinking_level,
            "tools": tools,
            "activeTools": active_tools,
        }

    def _create_context(
        self,
        turn_state: dict[str, Any],
        system_prompt: str | None = None,
    ) -> AgentContext:
        return {
            "systemPrompt": system_prompt or turn_state["systemPrompt"],
            "messages": list(turn_state["messages"]),
            "tools": list(turn_state["activeTools"]),
        }

    def _create_stream_fn(
        self,
        get_turn_state: Callable[[], dict[str, Any]],
    ) -> StreamFn:
        async def stream_fn(
            model: Model[Any],
            context: Any,
            stream_options: dict[str, Any] | None = None,
        ) -> Any:
            turn_state = get_turn_state()
            auth = None
            if self.get_api_key_and_headers:
                auth = await self._maybe_await_listener(self.get_api_key_and_headers(model))
            snapshot_options = clone_stream_options(turn_state["streamOptions"])
            snapshot_options.headers = merge_headers(
                snapshot_options.headers,
                auth.get("headers") if auth else None,
            )
            request_options = await self._emit_before_provider_request(
                model,
                turn_state["sessionId"],
                snapshot_options,
            )

            async def on_payload(payload: Any, _request_model: Model[Any] | None = None) -> Any:
                return await self._emit_before_provider_payload(model, payload)

            async def on_response(response: Any, _request_model: Model[Any] | None = None) -> None:
                if isinstance(response, dict):
                    headers = dict(response.get("headers") or {})
                    status = response.get("status", 0)
                else:
                    headers = dict(getattr(response, "headers", {}) or {})
                    status = getattr(response, "status", 0)
                await self._emit_own(
                    {
                        "type": "after_provider_response",
                        "status": status,
                        "headers": headers,
                    },
                    stream_options.get("signal") if isinstance(stream_options, dict) else None,
                )

            return stream_simple(
                model,
                context,
                {
                    "cacheRetention": request_options.cache_retention,
                    "headers": request_options.headers,
                    "maxRetries": request_options.max_retries,
                    "maxRetryDelayMs": request_options.max_retry_delay_ms,
                    "metadata": request_options.metadata,
                    "onPayload": on_payload,
                    "onResponse": on_response,
                    "reasoning": (
                        stream_options.get("reasoning")
                        if isinstance(stream_options, dict)
                        else None
                    ),
                    "signal": (
                        stream_options.get("signal") if isinstance(stream_options, dict) else None
                    ),
                    "sessionId": turn_state["sessionId"],
                    "timeoutMs": request_options.timeout_ms,
                    "transport": request_options.transport,
                    "apiKey": auth.get("apiKey") if auth else None,
                },
            )

        return stream_fn

    async def _drain_queued_messages(
        self, queue: list[AgentMessage], mode: QueueMode
    ) -> list[AgentMessage]:
        messages = queue if mode == "all" else queue[:1]
        if messages:
            queue[: len(messages)] = []
            try:
                await self._emit_queue_update()
                return messages
            except Exception as e:
                queue[:0] = messages
                raise normalize_hook_error(e)
        return messages

    def _create_loop_config(
        self,
        get_turn_state: Callable[[], dict[str, Any]],
        set_turn_state: Callable[[dict[str, Any]], None],
    ) -> AgentLoopConfig:
        turn_state = get_turn_state()

        async def transform_context(
            messages: list[AgentMessage], _signal: AbortSignal | None = None
        ) -> list[AgentMessage]:
            result = await self._emit_hook({"type": "context", "messages": list(messages)})
            if result and result.get("messages"):
                return result["messages"]
            return messages

        async def before_tool_call(context: Any, signal: AbortSignal | None = None) -> Any:
            tool_call = context["toolCall"]
            args = context["args"]
            result = await self._emit_hook(
                {
                    "type": "tool_call",
                    "toolCallId": tool_call.get("id", ""),
                    "toolName": tool_call.get("name", ""),
                    "input": args,
                }
            )
            if not result:
                return None
            return {"block": result.get("block"), "reason": result.get("reason")}

        async def after_tool_call(context: Any, signal: AbortSignal | None = None) -> Any:
            tool_call = context["toolCall"]
            args = context["args"]
            tool_result = context["result"]
            is_error = context["isError"]
            patch = await self._emit_hook(
                {
                    "type": "tool_result",
                    "toolCallId": tool_call.get("id", ""),
                    "toolName": tool_call.get("name", ""),
                    "input": args,
                    "content": tool_result.get("content", []),
                    "details": tool_result.get("details"),
                    "isError": is_error,
                }
            )
            if not patch:
                return None
            return {
                "content": patch.get("content"),
                "details": patch.get("details"),
                "isError": patch.get("isError"),
                "terminate": patch.get("terminate"),
            }

        async def prepare_next_turn(_context: Any = None) -> dict:
            await self._flush_pending_session_writes()
            next_turn_state = await self._create_turn_state()
            set_turn_state(next_turn_state)
            return {
                "context": self._create_context(next_turn_state),
                "model": next_turn_state["model"],
                "thinkingLevel": next_turn_state["thinkingLevel"],
            }

        async def get_steering_messages() -> list:
            return await self._drain_queued_messages(self.steer_queue, self.steering_queue_mode)

        async def get_follow_up_messages() -> list:
            return await self._drain_queued_messages(
                self.follow_up_queue, self.follow_up_queue_mode
            )

        return {
            "model": turn_state["model"],
            "reasoning": (
                None if turn_state["thinkingLevel"] == "off" else turn_state["thinkingLevel"]
            ),
            "convertToLlm": lambda messages: self._convert_to_llm(messages, turn_state),
            "transformContext": transform_context,
            "beforeToolCall": before_tool_call,
            "afterToolCall": after_tool_call,
            "prepareNextTurn": prepare_next_turn,
            "getSteeringMessages": get_steering_messages,
            "getFollowUpMessages": get_follow_up_messages,
            "toolExecution": "sequential",
        }

    def _convert_to_llm(
        self,
        messages: list[AgentMessage],
        turn_state: dict[str, Any],
    ) -> list[Any]:
        # Simplified conversion - in production this would use the proper conversion
        from pi_mono.agent.harness.messages import convert_to_llm

        return convert_to_llm(messages)

    # =========================================================================
    # Session Write Flushing
    # =========================================================================

    async def _flush_pending_session_writes(self) -> None:
        while self.pending_session_writes:
            write = self.pending_session_writes[0]
            if write["type"] == "message":
                await self.session.append_message(write["message"])
            elif write["type"] == "model_change":
                await self.session.append_model_change(write["provider"], write["modelId"])
            elif write["type"] == "thinking_level_change":
                await self.session.append_thinking_level_change(write["thinkingLevel"])
            elif write["type"] == "active_tools_change":
                await self.session.append_active_tools_change(write["activeToolNames"])
            elif write["type"] == "custom":
                await self.session.append_custom_entry(write["customType"], write["data"])
            elif write["type"] == "custom_message":
                await self.session.append_custom_message_entry(
                    write["customType"], write["content"], write["display"], write.get("details")
                )
            elif write["type"] == "label":
                await self.session.append_label(write["targetId"], write["label"])
            elif write["type"] == "session_info":
                await self.session.append_session_name(write["name"] or "")
            elif write["type"] == "leaf":
                await self.session.get_storage().set_leaf_id(write["targetId"])
            self.pending_session_writes.pop(0)

    # =========================================================================
    # Agent Event Handling
    # =========================================================================

    async def _handle_agent_event(
        self, event: AgentEvent, signal: AbortSignal | None = None
    ) -> None:
        if event["type"] == "message_end":
            await self.session.append_message(event["message"])
            await self._emit_any(event, signal)
            return

        if event["type"] == "turn_end":
            event_error = None
            try:
                await self._emit_any(event, signal)
            except Exception as e:
                event_error = e

            had_pending_mutations = len(self.pending_session_writes) > 0
            await self._flush_pending_session_writes()

            if event_error:
                raise event_error

            await self._emit_own(
                {"type": "save_point", "hadPendingMutations": had_pending_mutations}
            )
            return

        if event["type"] == "agent_end":
            await self._flush_pending_session_writes()
            self.phase = "idle"
            await self._emit_any(event, signal)
            await self._emit_own(
                {"type": "settled", "nextTurnCount": len(self.next_turn_queue)},
                signal,
            )
            return

        await self._emit_any(event, signal)

    async def _emit_run_failure(
        self,
        model: Model[Any],
        error: Exception,
        aborted: bool,
        signal: AbortSignal,
    ) -> list[AgentMessage]:
        failure_message = create_failure_message(model, error, aborted)

        await self._handle_agent_event(
            {"type": "message_start", "message": failure_message}, signal
        )
        await self._handle_agent_event({"type": "message_end", "message": failure_message}, signal)
        await self._handle_agent_event(
            {"type": "turn_end", "message": failure_message, "tool_results": []},
            signal,
        )
        await self._handle_agent_event(
            {"type": "agent_end", "messages": [failure_message]},
            signal,
        )
        return [failure_message]

    async def _execute_turn(
        self,
        turn_state: AgentHarnessTurnState[TSkill, TPromptTemplate, TTool],
        text: str,
        options: dict[str, Any] | None = None,
    ) -> Any:
        active_turn_state = turn_state
        messages: list[AgentMessage] = [
            create_user_message(text, options.get("images") if options else None)
        ]

        if self.next_turn_queue:
            queued_messages = self.next_turn_queue[:]
            self.next_turn_queue.clear()
            try:
                await self._emit_queue_update()
            except Exception as e:
                self.next_turn_queue[0:0] = queued_messages
                raise normalize_hook_error(e)
            messages = queued_messages + messages

        before_result = await self._emit_hook(
            {
                "type": "before_agent_start",
                "prompt": text,
                "images": options.get("images") if options else None,
                "systemPrompt": turn_state["systemPrompt"],
                "resources": turn_state["resources"],
            }
        )
        if before_result and before_result.get("messages"):
            messages.extend(before_result["messages"])

        abort_controller = _create_abort_controller()
        turn_state_holder = {"state": active_turn_state}

        def get_turn_state():
            return turn_state_holder["state"]

        def set_turn_state(state):
            turn_state_holder.update(state=state)

        self.run_abort_controller = abort_controller

        async def run_result() -> list[AgentMessage]:
            try:
                return await run_agent_loop(
                    messages,
                    self._create_context(
                        turn_state, before_result.get("systemPrompt") if before_result else None
                    ),
                    self._create_loop_config(get_turn_state, set_turn_state),
                    lambda event: self._handle_agent_event(event, abort_controller.signal),
                    abort_controller.signal,
                    self._create_stream_fn(get_turn_state),
                )
            except Exception as error:
                try:
                    return await self._emit_run_failure(
                        active_turn_state["model"],
                        error,
                        abort_controller.signal.aborted,
                        abort_controller.signal,
                    )
                except Exception:
                    cause = Exception("Agent run failed and failure reporting failed")
                    # Python doesn't have AggregateError, using Exception with multiple causes
                    raise AgentHarnessError("unknown", str(cause), cause)

        try:
            new_messages = await run_result()
            for i in range(len(new_messages) - 1, -1, -1):
                message = new_messages[i]
                if message.get("role") == "assistant":
                    return message
            raise AgentHarnessError(
                "invalid_state", "AgentHarness prompt completed without an assistant message"
            )
        finally:
            try:
                await self._flush_pending_session_writes()
            finally:
                self.run_abort_controller = None

    # =========================================================================
    # Public API
    # =========================================================================

    async def prompt(self, text: str, options: dict[str, Any] | None = None) -> Any:
        if self.phase != "idle":
            raise AgentHarnessError("busy", "AgentHarness is busy")

        self.phase = "turn"
        finish_run_promise = self._start_run_promise()

        try:
            turn_state = await self._create_turn_state()
            return await self._execute_turn(turn_state, text, options)
        except Exception as error:
            self.phase = "idle"
            raise normalize_harness_error(error, "unknown")
        finally:
            finish_run_promise()

    async def skill(self, name: str, additional_instructions: str | None = None) -> Any:
        if self.phase != "idle":
            raise AgentHarnessError("busy", "AgentHarness is busy")

        self.phase = "turn"
        finish_run_promise = self._start_run_promise()

        try:
            turn_state = await self._create_turn_state()
            skill = next(
                (c for c in (turn_state.resources.get("skills") or []) if c.name == name), None
            )
            if not skill:
                raise AgentHarnessError("invalid_argument", f"Unknown skill: {name}")
            return await self._execute_turn(
                turn_state, format_skill_invocation(skill, additional_instructions)
            )
        except Exception as error:
            self.phase = "idle"
            raise normalize_harness_error(error, "unknown")
        finally:
            finish_run_promise()

    async def prompt_from_template(self, name: str, args: list[str] = []) -> Any:
        if self.phase != "idle":
            raise AgentHarnessError("busy", "AgentHarness is busy")

        self.phase = "turn"
        finish_run_promise = self._start_run_promise()

        try:
            turn_state = await self._create_turn_state()
            template = next(
                (
                    c
                    for c in (turn_state.resources.get("promptTemplates") or [])
                    if c["name"] == name
                ),
                None,
            )
            if not template:
                raise AgentHarnessError("invalid_argument", f"Unknown prompt template: {name}")
            return await self._execute_turn(
                turn_state, format_prompt_template_invocation(template, [])
            )
        except Exception as error:
            self.phase = "idle"
            raise normalize_harness_error(error, "unknown")
        finally:
            finish_run_promise()

    async def steer(self, text: str, options: dict | None = None) -> None:
        if self.phase == "idle":
            raise AgentHarnessError("invalid_state", "Cannot steer while idle")
        self.steer_queue.append(
            create_user_message(text, options.get("images") if options else None)
        )
        await self._emit_queue_update()

    async def follow_up(self, text: str, options: dict | None = None) -> None:
        if self.phase == "idle":
            raise AgentHarnessError("invalid_state", "Cannot follow up while idle")
        self.follow_up_queue.append(
            create_user_message(text, options.get("images") if options else None)
        )
        await self._emit_queue_update()

    async def next_turn(self, text: str, options: dict | None = None) -> None:
        self.next_turn_queue.append(
            create_user_message(text, options.get("images") if options else None)
        )
        await self._emit_queue_update()

    async def append_message(self, message: Any) -> None:
        try:
            if self.phase == "idle":
                await self.session.append_message(message)
            else:
                self.pending_session_writes.append({"type": "message", "message": message})
        except Exception as e:
            raise normalize_harness_error(e, "session")

    async def compact(self, custom_instructions: str | None = None) -> dict:
        if self.phase != "idle":
            raise AgentHarnessError("busy", "compact() requires idle harness")

        self.phase = "compaction"
        try:
            model = self.model
            if not model:
                raise AgentHarnessError("invalid_state", "No model set for compaction")

            auth = (
                await self.get_api_key_and_headers(model) if self.get_api_key_and_headers else None
            )
            if not auth:
                raise AgentHarnessError("auth", "No auth available for compaction")

            branch_entries = await self.session.get_branch()
            preparation_result = await prepare_compaction(
                branch_entries, DEFAULT_COMPACTION_SETTINGS
            )
            if not preparation_result["ok"]:
                raise preparation_result["error"]

            preparation = preparation_result["value"]
            if not preparation:
                raise AgentHarnessError("compaction", "Nothing to compact")

            hook_result = await self._emit_hook(
                {
                    "type": "session_before_compact",
                    "preparation": preparation,
                    "branchEntries": branch_entries,
                    "customInstructions": custom_instructions,
                    "signal": _create_abort_signal(),
                }
            )

            if hook_result and hook_result.get("cancel"):
                raise AgentHarnessError("compaction", "Compaction cancelled")

            provided = hook_result.get("compaction") if hook_result else None
            compact_result = (
                {"ok": True, "value": provided}
                if provided
                else await compact(
                    preparation,
                    model,
                    auth.get("apiKey") if auth else "",
                    auth.get("headers") if auth else None,
                    custom_instructions,
                    None,
                    self.thinking_level,
                )
            )

            if not compact_result["ok"]:
                raise compact_result["error"]

            result = compact_result["value"]
            entry_id = await self.session.append_compaction(
                result["summary"],
                result["firstKeptEntryId"],
                result["tokensBefore"],
                result.get("details"),
                provided is not None,
            )

            entry = await self.session.get_entry(entry_id)
            if entry and entry.get("type") == "compaction":
                await self._emit_own(
                    {
                        "type": "session_compact",
                        "compactionEntry": entry,
                        "fromHook": provided is not None,
                    }
                )

            return result
        except Exception as error:
            raise normalize_harness_error(error, "compaction")
        finally:
            self.phase = "idle"

    async def navigate_tree(
        self,
        target_id: str,
        options: dict | None = None,
    ) -> NavigateTreeResult:
        if self.phase != "idle":
            raise AgentHarnessError("busy", "navigateTree() requires idle harness")

        self.phase = "branch_summary"
        try:
            old_leaf_id = await self.session.get_leaf_id()
            if old_leaf_id == target_id:
                return {"cancelled": False}

            target_entry = await self.session.get_entry(target_id)
            if not target_entry:
                raise AgentHarnessError("invalid_argument", f"Entry {target_id} not found")

            result = await collect_entries_for_branch_summary(
                self.session, await self.session.get_leaf_id(), target_id
            )
            entries = result["entries"]
            common_ancestor_id = result["commonAncestorId"]

            preparation = {
                "targetId": target_id,
                "oldLeafId": await self.session.get_leaf_id(),
                "commonAncestorId": common_ancestor_id,
                "entriesToSummarize": entries,
                "userWantsSummary": options.get("summarize", False) if options else False,
                "customInstructions": options.get("customInstructions") if options else None,
                "replaceInstructions": options.get("replaceInstructions") if options else None,
                "label": options.get("label") if options else None,
            }

            signal = _create_abort_signal()
            hook_result = await self._emit_hook(
                {"type": "session_before_tree", "preparation": preparation, "signal": signal}
            )
            if hook_result and hook_result.get("cancel"):
                return {"cancelled": True}

            summary_entry = None
            summary_text = hook_result.get("summary", {}).get("summary") if hook_result else None
            summary_details = hook_result.get("summary", {}).get("details") if hook_result else None

            if not summary_text and options and options.get("summarize") and entries:
                model = self.model
                if not model:
                    raise AgentHarnessError("invalid_state", "No model set for branch summary")

                auth = (
                    await self.get_api_key_and_headers(model)
                    if self.get_api_key_and_headers
                    else None
                )
                if not auth:
                    raise AgentHarnessError("auth", "No auth available for branch summary")

                branch_summary = await generate_branch_summary(
                    entries,
                    {
                        "model": self.model,
                        "apiKey": auth.get("apiKey") if auth else "",
                        "headers": auth.get("headers") if auth else None,
                        "signal": _create_abort_signal(),
                        "customInstructions": (
                            hook_result.get("customInstructions")
                            if hook_result
                            else options.get("customInstructions")
                        ),
                        "replaceInstructions": (
                            hook_result.get("replaceInstructions")
                            if hook_result
                            else options.get("replaceInstructions")
                        ),
                    },
                )

                if not branch_summary["ok"]:
                    if branch_summary["error"].code == "aborted":
                        return {"cancelled": True}
                    raise AgentHarnessError(
                        "branch_summary", branch_summary["error"].message, branch_summary["error"]
                    )

                summary_text = branch_summary["value"]["summary"]
                summary_details = {
                    "readFiles": branch_summary["value"]["readFiles"],
                    "modifiedFiles": branch_summary["value"]["modifiedFiles"],
                }

            editor_text = None
            new_leaf_id = None

            if target_entry := self.session.get_entry(target_id):
                if (
                    target_entry.get("type") == "message"
                    and target_entry.get("message", {}).get("role") == "user"
                ):
                    new_leaf_id = target_entry.get("parentId")
                    content = target_entry.get("message", {}).get("content", "")
                    editor_text = (
                        content
                        if isinstance(content, str)
                        else "".join(c.get("text", "") for c in content if c.get("type") == "text")
                    )
                elif target_entry.get("type") == "custom_message":
                    new_leaf_id = target_entry.get("parentId")
                    content = target_entry.get("content", "")
                    editor_text = (
                        content
                        if isinstance(content, str)
                        else "".join(c.get("text", "") for c in content if c.get("type") == "text")
                    )
                else:
                    new_leaf_id = target_id

            summary_id = await self.session.move_to(
                new_leaf_id,
                (
                    {"summary": summary_text, "details": summary_details, "fromHook": True}
                    if summary_text
                    else None
                ),
            )

            if summary_id:
                entry = await self.session.get_entry(summary_id)
                if entry and entry.get("type") == "branch_summary":
                    summary_entry = entry

            await self._emit_own(
                {
                    "type": "session_tree",
                    "newLeafId": await self.session.get_leaf_id(),
                    "oldLeafId": old_leaf_id,
                    "summaryEntry": summary_entry,
                    "fromHook": True,
                }
            )

            return {"cancelled": False, "editorText": editor_text, "summaryEntry": summary_entry}
        except Exception as error:
            raise normalize_harness_error(error, "branch_summary")
        finally:
            self.phase = "idle"

    def get_model(self) -> Model[Any]:
        return self.model

    async def set_model(self, model: Model[Any]) -> None:
        try:
            previous_model = self.model
            if self.phase == "idle":
                await self.session.append_model_change(model["provider"], model["id"])
            else:
                self.pending_session_writes.append(
                    {
                        "type": "model_change",
                        "provider": model["provider"],
                        "modelId": model["id"],
                    }
                )
            self.model = model
            await self._emit_own(
                {
                    "type": "model_update",
                    "model": model,
                    "previousModel": previous_model,
                    "source": "set",
                }
            )
        except Exception as e:
            raise normalize_harness_error(e, "session")

    def get_thinking_level(self) -> str:
        return self.thinking_level

    async def set_thinking_level(self, level: str) -> None:
        try:
            previous_level = self.thinking_level
            if self.phase == "idle":
                await self.session.append_thinking_level_change(level)
            else:
                self.pending_session_writes.append(
                    {"type": "thinking_level_change", "thinkingLevel": level}
                )
            self.thinking_level = level
            await self._emit_own(
                {"type": "thinking_level_update", "level": level, "previousLevel": previous_level}
            )
        except Exception as e:
            raise normalize_harness_error(e, "session")

    def get_tools(self) -> list:
        return list(self.tools.values())

    async def set_tools(self, tools: list, active_tool_names: list[str] | None = None) -> None:
        try:
            self.validate_unique_names([tool_name(t) for t in tools], "Duplicate tool name(s)")
            next_tools = {tool_name(t): t for t in tools}
            next_active_tool_names = active_tool_names or self.active_tool_names
            self.validate_tool_names(next_active_tool_names, next_tools)

            previous_tool_names = list(self.tools.keys())
            previous_active_tool_names = list(self.active_tool_names)

            if self.phase == "idle":
                await self.session.append_active_tools_change(next_active_tool_names)
            else:
                self.pending_session_writes.append(
                    {"type": "active_tools_change", "activeToolNames": next_active_tool_names}
                )

            self.tools = {tool_name(t): t for t in tools}
            self.active_tool_names = next_active_tool_names

            await self._emit_own(
                {
                    "type": "tools_update",
                    "toolNames": list(self.tools.keys()),
                    "previousToolNames": previous_tool_names,
                    "activeToolNames": list(self.active_tool_names),
                    "previousActiveToolNames": previous_active_tool_names,
                    "source": "set",
                }
            )
        except Exception as e:
            raise normalize_harness_error(e, "invalid_argument")

    def get_active_tools(self) -> list:
        return [self.tools[name] for name in self.active_tool_names if name in self.tools]

    async def set_active_tools(self, tool_names: list[str]) -> None:
        try:
            self.validate_tool_names(tool_names)
            previous_tool_names = list(self.tools.keys())
            previous_active_tool_names = list(self.active_tool_names)

            if self.phase == "idle":
                await self.session.append_active_tools_change(tool_names)
            else:
                self.pending_session_writes.append(
                    {"type": "active_tools_change", "activeToolNames": tool_names}
                )

            self.active_tool_names = tool_names[:]
            await self._emit_own(
                {
                    "type": "tools_update",
                    "toolNames": list(self.tools.keys()),
                    "previousToolNames": previous_tool_names,
                    "activeToolNames": tool_names,
                    "previousActiveToolNames": previous_active_tool_names,
                    "source": "set",
                }
            )
        except Exception as e:
            raise normalize_harness_error(e, "invalid_argument")

    def get_steering_mode(self) -> QueueMode:
        return self.steering_queue_mode

    def set_steering_mode(self, mode: QueueMode) -> None:
        self.steering_queue_mode = mode

    def get_follow_up_mode(self) -> QueueMode:
        return self.follow_up_queue_mode

    def set_follow_up_mode(self, mode: QueueMode) -> None:
        self.follow_up_queue_mode = mode

    def get_resources(self) -> dict:
        return {
            "skills": list(self.resources.get("skills", [])),
            "promptTemplates": list(self.resources.get("promptTemplates", [])),
        }

    async def set_resources(self, resources: dict) -> None:
        previous = self.get_resources()
        self.resources = {
            "skills": list(resources.get("skills", [])),
            "promptTemplates": list(resources.get("promptTemplates", [])),
        }
        await self._emit_own(
            {
                "type": "resources_update",
                "resources": self.get_resources(),
                "previousResources": previous,
            }
        )

    def get_stream_options(self) -> AgentHarnessStreamOptions:
        return clone_stream_options(self.stream_options)

    def set_stream_options(
        self, stream_options: dict[str, Any] | AgentHarnessStreamOptions
    ) -> None:
        self.stream_options = clone_stream_options(stream_options)

    async def abort(self) -> dict:
        cleared_steer = list(self.steer_queue)
        cleared_follow_up = list(self.follow_up_queue)
        self.steer_queue.clear()
        self.follow_up_queue.clear()

        if self.run_abort_controller:
            self.run_abort_controller.abort()

        errors = []
        try:
            await self._emit_queue_update()
        except Exception as e:
            errors.append(e)

        try:
            await self.wait_for_idle()
        except Exception as e:
            errors.append(e)

        try:
            await self._emit_own(
                {
                    "type": "abort",
                    "clearedSteer": cleared_steer,
                    "clearedFollowUp": cleared_follow_up,
                }
            )
        except Exception as e:
            errors.append(e)

        if errors:
            cause = (
                errors[0]
                if len(errors) == 1
                else Exception(f"Abort completed with errors: {errors}")
            )
            raise normalize_harness_error(cause, "hook")

        return {"clearedSteer": cleared_steer, "clearedFollowUp": cleared_follow_up}

    async def wait_for_idle(self) -> None:
        if self.run_promise:
            await self.run_promise

    def subscribe(self, listener: Callable) -> Callable[[], None]:
        handlers = self.handlers.get(SUBSCRIBER_EVENT_TYPE)
        if handlers is None:
            handlers = []
            self.handlers[SUBSCRIBER_EVENT_TYPE] = handlers
        handlers.append(listener)
        return lambda: handlers.remove(listener) if listener in handlers else None

    def on(self, event_type: str, handler: Callable) -> Callable[[], None]:
        handlers = self.handlers.get(event_type)
        if handlers is None:
            handlers = []
            self.handlers[event_type] = handlers
        handlers.append(handler)
        return lambda: handlers.remove(handler) if handler in handlers else None

    def get_phase(self) -> str:
        return self.phase

    # TypeScript-compatible camelCase aliases used by ported tests and callers.
    getModel = get_model
    setModel = set_model
    getThinkingLevel = get_thinking_level
    setThinkingLevel = set_thinking_level
    getSteeringMode = get_steering_mode
    setSteeringMode = set_steering_mode
    getFollowUpMode = get_follow_up_mode
    setFollowUpMode = set_follow_up_mode
    getTools = get_tools
    setTools = set_tools
    getActiveTools = get_active_tools
    setActiveTools = set_active_tools
    getResources = get_resources
    setResources = set_resources
    getStreamOptions = get_stream_options
    setStreamOptions = set_stream_options
    followUp = follow_up
    nextTurn = next_turn
    appendMessage = append_message
    waitForIdle = wait_for_idle
