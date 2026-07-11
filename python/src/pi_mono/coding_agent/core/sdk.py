"""SDK entry points for creating AgentSession and runtime."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable, Literal

from pi_mono.agent.agent import Agent
from pi_mono.agent.types import AgentMessage, ThinkingLevel
from pi_mono.ai.models import clamp_thinking_level
from pi_mono.ai.stream import stream_simple
from pi_mono.ai.types import Context, Model, SimpleStreamOptions
from pi_mono.config import get_agent_dir
from pi_mono.utils.abort_signals import AbortSignal
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.defaults import DEFAULT_THINKING_LEVEL
from pi_mono.core.messages import convert_to_llm
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager, get_default_session_dir
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.coding_agent.core.agent_session import (
    AgentSession,
    AgentSessionConfig,
    AgentSessionRuntime,
)
from pi_mono.coding_agent.core.agent_session_services import (
    AgentSessionServices,
    CreateAgentSessionServicesOptions,
    create_agent_session_services,
)
from pi_mono.coding_agent.core.auth_guidance import (
    format_no_api_key_found_message,
    format_no_models_available_message,
)
from pi_mono.coding_agent.core.model_resolver import ScopedModel, find_initial_model
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
    ResourceLoader,
)
from pi_mono.coding_agent.core.provider_attribution import merge_provider_attribution_headers
from pi_mono.coding_agent.core.extensions.runner import ExtensionRunner
from pi_mono.coding_agent.core.tools import ToolName
from pi_mono.utils.paths import resolve_path


@dataclass
class CreateAgentSessionOptions:
    cwd: str | None = None
    agent_dir: str | None = None
    auth_storage: AuthStorage | None = None
    model_registry: ModelRegistry | None = None
    model: Model[Any] | None = None
    thinking_level: ThinkingLevel | None = None
    scoped_models: list[ScopedModel] | None = None
    no_tools: Literal["all", "builtin"] | None = None
    tools: list[str] | None = None
    exclude_tools: list[str] | None = None
    no_extensions: bool = False
    resource_loader: ResourceLoader | None = None
    session_manager: SessionManager | None = None
    settings_manager: SettingsManager | None = None


@dataclass
class CreateAgentSessionResult:
    session: AgentSession
    extensions_result: dict[str, Any]
    model_fallback_message: str | None = None


@dataclass
class CreateAgentSessionFromServicesOptions:
    services: AgentSessionServices
    session_manager: SessionManager
    model: Model[Any] | None = None
    thinking_level: ThinkingLevel | None = None
    scoped_models: list[ScopedModel] | None = None
    tools: list[str] | None = None
    exclude_tools: list[str] | None = None
    no_tools: Literal["all", "builtin"] | None = None
    no_extensions: bool = False


def _convert_to_llm_with_block_images(
    settings_manager: SettingsManager,
) -> Callable[[list[AgentMessage]], list[Any]]:
    def convert(messages: list[AgentMessage]) -> list[Any]:
        converted = convert_to_llm(messages)
        if not settings_manager.get_block_images():
            return converted
        filtered: list[Any] = []
        for msg in converted:
            role = msg.get("role")
            if role not in ("user", "toolResult"):
                filtered.append(msg)
                continue
            content = msg.get("content")
            if not isinstance(content, list):
                filtered.append(msg)
                continue
            if not any(part.get("type") == "image" for part in content):
                filtered.append(msg)
                continue
            replaced: list[Any] = []
            for part in content:
                if part.get("type") == "image":
                    replaced.append({"type": "text", "text": "Image reading is disabled."})
                else:
                    replaced.append(part)
            deduped: list[Any] = []
            for index, part in enumerate(replaced):
                if (
                    part.get("type") == "text"
                    and part.get("text") == "Image reading is disabled."
                    and index > 0
                    and replaced[index - 1].get("type") == "text"
                    and replaced[index - 1].get("text") == "Image reading is disabled."
                ):
                    continue
                deduped.append(part)
            filtered.append({**msg, "content": deduped})
        return filtered

    return convert


async def create_agent_session(
    options: CreateAgentSessionOptions | None = None,
) -> CreateAgentSessionResult:
    opts = options or CreateAgentSessionOptions()
    cwd = resolve_path(
        opts.cwd or (opts.session_manager.get_cwd() if opts.session_manager else os.getcwd())
    )
    agent_dir = resolve_path(opts.agent_dir) if opts.agent_dir else str(get_agent_dir())

    auth_path = os.path.join(agent_dir, "auth.json") if opts.agent_dir else None
    models_path = os.path.join(agent_dir, "models.json") if opts.agent_dir else None
    auth_storage = opts.auth_storage or AuthStorage.create(auth_path)
    model_registry = opts.model_registry or ModelRegistry.create(auth_storage, models_path)
    settings_manager = opts.settings_manager or SettingsManager.create(cwd, agent_dir)
    session_manager = opts.session_manager or SessionManager.create(
        cwd, get_default_session_dir(cwd, agent_dir)
    )

    resource_loader = opts.resource_loader
    if resource_loader is None:
        resource_loader = DefaultResourceLoader(
            DefaultResourceLoaderOptions(
                cwd=cwd, agent_dir=agent_dir, settings_manager=settings_manager
            )
        )
        await resource_loader.reload()

    existing_session = session_manager.build_session_context()
    has_existing_session = len(existing_session.get("messages", [])) > 0
    has_thinking_entry = any(
        entry.get("type") == "thinking_level_change" for entry in session_manager.get_branch()
    )

    model = opts.model
    model_fallback_message: str | None = None

    if not model and has_existing_session and existing_session.get("model"):
        saved_model = existing_session["model"]
        restored_model = model_registry.find(saved_model["provider"], saved_model["modelId"])
        if restored_model and model_registry.has_configured_auth(restored_model):
            model = restored_model
        if not model:
            model_fallback_message = (
                f"Could not restore model {saved_model['provider']}/{saved_model['modelId']}"
            )

    if not model:
        initial = find_initial_model(
            scoped_models=list(opts.scoped_models or []),
            is_continuing=has_existing_session,
            default_provider=settings_manager.get_default_provider(),
            default_model_id=settings_manager.get_default_model(),
            default_thinking_level=settings_manager.get_default_thinking_level(),
            model_registry=model_registry,
        )
        model = initial.model
        if not model:
            model_fallback_message = format_no_models_available_message()
        elif model_fallback_message:
            model_fallback_message += f". Using {model['provider']}/{model['id']}"

    thinking_level: ThinkingLevel = opts.thinking_level  # type: ignore[assignment]
    if thinking_level is None and has_existing_session:
        thinking_level = (
            existing_session.get("thinkingLevel")  # type: ignore[assignment]
            if has_thinking_entry
            else settings_manager.get_default_thinking_level() or DEFAULT_THINKING_LEVEL  # type: ignore[assignment]
        )
    if thinking_level is None:
        thinking_level = settings_manager.get_default_thinking_level() or DEFAULT_THINKING_LEVEL  # type: ignore[assignment]

    if not model:
        thinking_level = "off"
    else:
        thinking_level = clamp_thinking_level(model, thinking_level)  # type: ignore[assignment]

    default_active_tool_names: list[ToolName] = ["read", "bash", "edit", "write"]
    if opts.tools is not None:
        allowed_tool_names = opts.tools
    elif opts.no_tools == "all":
        allowed_tool_names = []
    else:
        allowed_tool_names = None
    excluded_tool_names = opts.exclude_tools
    excluded_tool_name_set = set(excluded_tool_names or [])
    if opts.tools is not None:
        initial_active_tool_names = [
            name for name in opts.tools if name not in excluded_tool_name_set
        ]
    elif opts.no_tools:
        initial_active_tool_names = []
    else:
        initial_active_tool_names = [
            name for name in default_active_tool_names if name not in excluded_tool_name_set
        ]

    async def stream_fn(
        selected_model: Model[Any],
        context: Context,
        stream_options: SimpleStreamOptions | None = None,
    ) -> Any:
        auth = await model_registry.get_api_key_and_headers(selected_model)
        if not auth.get("ok") or not auth.get("apiKey"):
            raise RuntimeError(
                auth.get("error")
                or format_no_api_key_found_message(selected_model.get("provider", "unknown"))
            )
        provider_retry_settings = settings_manager.get_provider_retry_settings()
        http_idle_timeout_ms = settings_manager.get_http_idle_timeout_ms()
        effective_timeout_ms = 2_147_483_647 if http_idle_timeout_ms == 0 else http_idle_timeout_ms
        timeout_ms = (
            (stream_options or {}).get("timeoutMs")
            or provider_retry_settings.get("timeoutMs")
            or effective_timeout_ms
        )
        websocket_connect_timeout_ms = (stream_options or {}).get(
            "websocketConnectTimeoutMs"
        ) or settings_manager.get_websocket_connect_timeout_ms()
        merged_env = None
        auth_env = auth.get("env")
        stream_env = (stream_options or {}).get("env")
        if auth_env or stream_env:
            merged_env = {**(auth_env or {}), **(stream_env or {})}
        merged_options: SimpleStreamOptions = {
            **(stream_options or {}),
            "apiKey": auth.get("apiKey"),
            "timeoutMs": timeout_ms,
            "websocketConnectTimeoutMs": websocket_connect_timeout_ms,
            "maxRetries": (stream_options or {}).get("maxRetries")
            or provider_retry_settings.get("maxRetries"),
            "maxRetryDelayMs": (stream_options or {}).get("maxRetryDelayMs")
            or provider_retry_settings.get("maxRetryDelayMs"),
        }
        if merged_env:
            merged_options["env"] = merged_env
        headers = merge_provider_attribution_headers(
            selected_model,
            settings_manager,
            session_manager.get_session_id(),
            auth.get("headers"),
            (stream_options or {}).get("headers"),
        )
        runner = extension_runner_ref[0]
        if runner is not None and runner.has_handlers("before_provider_headers"):
            headers = await runner.emit_before_provider_headers(headers or {})
        if headers:
            merged_options["headers"] = headers

        async def on_payload(payload: Any, _model: Model[Any]) -> Any:
            runner = extension_runner_ref[0]
            if runner is None or not runner.has_handlers("before_provider_request"):
                return payload
            return await runner.emit_before_provider_request(payload)

        async def on_response(response: Any, _model: Model[Any]) -> None:
            runner = extension_runner_ref[0]
            if runner is None or not runner.has_handlers("after_provider_response"):
                return
            await runner.emit(
                {
                    "type": "after_provider_response",
                    "status": (
                        getattr(response, "status", None)
                        if not isinstance(response, dict)
                        else response.get("status")
                    ),
                    "headers": (
                        getattr(response, "headers", None)
                        if not isinstance(response, dict)
                        else response.get("headers")
                    ),
                }
            )

        merged_options["onPayload"] = on_payload
        merged_options["onResponse"] = on_response
        return stream_simple(selected_model, context, merged_options)

    extension_runner_ref: list[ExtensionRunner | None] = [None]

    async def transform_context(
        messages: list[AgentMessage], _signal: AbortSignal | None = None
    ) -> list[AgentMessage]:
        runner = extension_runner_ref[0]
        if runner is None:
            return messages
        return await runner.emit_context(messages)

    agent = Agent(
        {
            "initialState": {
                "systemPrompt": "",
                "model": model,
                "thinkingLevel": thinking_level,
                "tools": [],
            },
            "convertToLlm": _convert_to_llm_with_block_images(settings_manager),
            "streamFn": stream_fn,
            "transformContext": transform_context,
            "sessionId": session_manager.get_session_id(),
            "steeringMode": settings_manager.get_steering_mode(),
            "followUpMode": settings_manager.get_follow_up_mode(),
            "transport": settings_manager.get_transport(),
            "thinkingBudgets": settings_manager.get_thinking_budgets(),
            "maxRetryDelayMs": settings_manager.get_provider_retry_settings().get(
                "maxRetryDelayMs"
            ),
        }
    )

    if has_existing_session:
        agent.state.messages = list(existing_session.get("messages", []))
        if not has_thinking_entry:
            session_manager.append_thinking_level_change(thinking_level)
    else:
        if model:
            session_manager.append_model_change(model["provider"], model["id"])
        session_manager.append_thinking_level_change(thinking_level)

    session = AgentSession(
        AgentSessionConfig(
            agent=agent,
            session_manager=session_manager,
            settings_manager=settings_manager,
            cwd=cwd,
            scoped_models=[
                {"model": item.model, "thinkingLevel": item.thinking_level}
                for item in (opts.scoped_models or [])
            ],
            resource_loader=resource_loader,
            model_registry=model_registry,
            initial_active_tool_names=initial_active_tool_names,
            allowed_tool_names=allowed_tool_names,
            excluded_tool_names=excluded_tool_names,
            no_extensions=opts.no_extensions,
            extension_runner_ref=extension_runner_ref,
        )
    )

    extensions = resource_loader.get_extensions()
    return CreateAgentSessionResult(
        session=session,
        extensions_result={
            "extensions": extensions.extensions,
            "errors": extensions.errors,
            "runtime": extensions.runtime,
        },
        model_fallback_message=model_fallback_message,
    )


async def create_agent_session_from_services(
    options: CreateAgentSessionFromServicesOptions,
) -> CreateAgentSessionResult:
    return await create_agent_session(
        CreateAgentSessionOptions(
            cwd=options.services.cwd,
            agent_dir=options.services.agent_dir,
            auth_storage=options.services.auth_storage,
            settings_manager=options.services.settings_manager,
            model_registry=options.services.model_registry,
            resource_loader=options.services.resource_loader,
            session_manager=options.session_manager,
            model=options.model,
            thinking_level=options.thinking_level,
            scoped_models=options.scoped_models,
            tools=options.tools,
            exclude_tools=options.exclude_tools,
            no_tools=options.no_tools,
            no_extensions=options.no_extensions,
        )
    )


async def create_agent_session_runtime(
    *,
    cwd: str,
    agent_dir: str | None = None,
    session_manager: SessionManager | None = None,
    model: Model[Any] | None = None,
    thinking_level: ThinkingLevel | None = None,
    scoped_models: list[ScopedModel] | None = None,
    tools: list[str] | None = None,
    exclude_tools: list[str] | None = None,
    no_tools: Literal["all", "builtin"] | None = None,
    resource_loader_options: dict[str, Any] | None = None,
    extension_flag_values: dict[str, bool | str] | None = None,
    no_extensions: bool = False,
    settings_manager: SettingsManager | None = None,
    auth_storage: AuthStorage | None = None,
    model_registry: ModelRegistry | None = None,
) -> AgentSessionRuntime:
    services = await create_agent_session_services(
        CreateAgentSessionServicesOptions(
            cwd=cwd,
            agent_dir=agent_dir,
            settings_manager=settings_manager,
            auth_storage=auth_storage,
            model_registry=model_registry,
            resource_loader_options=resource_loader_options,
            extension_flag_values=extension_flag_values,
        )
    )
    resolved_session_manager = session_manager or SessionManager.create(
        services.cwd, get_default_session_dir(services.cwd, services.agent_dir)
    )
    result = await create_agent_session_from_services(
        CreateAgentSessionFromServicesOptions(
            services=services,
            session_manager=resolved_session_manager,
            model=model,
            thinking_level=thinking_level,
            scoped_models=scoped_models,
            tools=tools,
            exclude_tools=exclude_tools,
            no_tools=no_tools,
            no_extensions=no_extensions,
        )
    )
    await result.session.bind_extensions()

    async def recreate_runtime(
        *,
        cwd: str,
        agent_dir: str,
        session_manager: SessionManager,
        session_start_event: dict[str, Any] | None = None,
    ) -> tuple[AgentSession, Any, list[dict[str, str]], str | None]:
        next_settings_manager = SettingsManager.create(
            cwd,
            agent_dir,
            project_trusted=services.settings_manager.is_project_trusted(),
        )
        next_services = await create_agent_session_services(
            CreateAgentSessionServicesOptions(
                cwd=cwd,
                agent_dir=agent_dir,
                auth_storage=services.auth_storage,
                model_registry=services.model_registry,
                settings_manager=next_settings_manager,
                resource_loader_options=resource_loader_options,
                extension_flag_values=extension_flag_values,
            )
        )
        next_result = await create_agent_session_from_services(
            CreateAgentSessionFromServicesOptions(
                services=next_services,
                session_manager=session_manager,
                model=model,
                thinking_level=thinking_level,
                scoped_models=scoped_models,
                tools=tools,
                exclude_tools=exclude_tools,
                no_tools=no_tools,
                no_extensions=no_extensions,
            )
        )
        next_session = next_result.session
        if session_start_event:
            next_session._session_start_reason = session_start_event.get("reason", "startup")
            next_session._session_start_previous_file = session_start_event.get(
                "previousSessionFile"
            )
        await next_session.bind_extensions()
        return (
            next_session,
            next_services,
            next_services.diagnostics,
            next_result.model_fallback_message,
        )

    return AgentSessionRuntime(
        session=result.session,
        services=services,
        diagnostics=services.diagnostics,
        model_fallback_message=result.model_fallback_message,
        _create_runtime=recreate_runtime,
    )
