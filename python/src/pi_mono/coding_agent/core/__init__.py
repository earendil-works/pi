"""Coding agent core."""

from pi_mono.coding_agent.core.agent_session import (
    AgentSession,
    AgentSessionConfig,
    AgentSessionEvent,
    AgentSessionEventListener,
    AgentSessionRuntime,
    PromptOptions,
)
from pi_mono.coding_agent.core.agent_session_services import (
    AgentSessionServices,
    CreateAgentSessionServicesOptions,
    create_agent_session_services,
)
from pi_mono.coding_agent.core.auth_guidance import (
    format_no_api_key_found_message,
    format_no_model_selected_message,
    format_no_models_available_message,
    get_provider_login_help,
)
from pi_mono.coding_agent.core.model_resolver import (
    ScopedModel,
    find_exact_model_reference_match,
    find_initial_model,
    parse_model_pattern,
    resolve_cli_model,
    resolve_model_scope,
)
from pi_mono.coding_agent.core.output_guard import (
    flush_raw_stdout,
    is_stdout_taken_over,
    restore_stdout,
    take_over_stdout,
    wait_for_raw_stdout_backpressure,
    write_raw_stdout,
)
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
    ResourceLoader,
    load_project_context_files,
)
from pi_mono.coding_agent.core.sdk import (
    CreateAgentSessionFromServicesOptions,
    CreateAgentSessionOptions,
    CreateAgentSessionResult,
    create_agent_session,
    create_agent_session_from_services,
    create_agent_session_runtime,
)
from pi_mono.coding_agent.core.system_prompt import build_system_prompt

__all__ = [
    "AgentSession",
    "AgentSessionConfig",
    "AgentSessionEvent",
    "AgentSessionEventListener",
    "AgentSessionRuntime",
    "PromptOptions",
    "AgentSessionServices",
    "CreateAgentSessionServicesOptions",
    "create_agent_session_services",
    "format_no_api_key_found_message",
    "format_no_model_selected_message",
    "format_no_models_available_message",
    "get_provider_login_help",
    "ScopedModel",
    "find_exact_model_reference_match",
    "find_initial_model",
    "parse_model_pattern",
    "resolve_cli_model",
    "resolve_model_scope",
    "flush_raw_stdout",
    "is_stdout_taken_over",
    "restore_stdout",
    "take_over_stdout",
    "wait_for_raw_stdout_backpressure",
    "write_raw_stdout",
    "DefaultResourceLoader",
    "DefaultResourceLoaderOptions",
    "ResourceLoader",
    "load_project_context_files",
    "CreateAgentSessionFromServicesOptions",
    "CreateAgentSessionOptions",
    "CreateAgentSessionResult",
    "create_agent_session",
    "create_agent_session_from_services",
    "create_agent_session_runtime",
    "build_system_prompt",
]
