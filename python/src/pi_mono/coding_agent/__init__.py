"""Coding agent CLI and SDK."""

from pi_mono.coding_agent.cli.args import Args, Mode, parse_args, print_help
from pi_mono.coding_agent.core import (
    AgentSession,
    AgentSessionConfig,
    AgentSessionEvent,
    AgentSessionEventListener,
    PromptOptions,
    create_agent_session,
    create_agent_session_runtime,
)
from pi_mono.coding_agent.core.bash_executor import BashResult, execute_bash_with_operations
from pi_mono.coding_agent.core.extensions import (
    Extension,
    ExtensionAPI,
    ExtensionFactory,
    ExtensionRunner,
    LoadExtensionsResult,
    create_extension_runtime,
    define_tool,
    discover_and_load_extensions,
    discover_extensions_in_dir,
    load_extension_from_factory,
    load_extensions,
)
from pi_mono.coding_agent.core.keybindings import (
    APP_KEYBINDINGS,
    DEFAULT_APP_KEYBINDINGS,
    CodingAgentKeybindingsManager,
)
from pi_mono.coding_agent.core.prompt_templates import (
    format_prompt_template_invocation,
    load_prompt_templates,
    load_sourced_prompt_templates,
)
from pi_mono.coding_agent.core.provider_attribution import merge_provider_attribution_headers
from pi_mono.coding_agent.core.skills import SkillFrontmatter, format_skill_invocation, load_skills
from pi_mono.coding_agent.core.slash_commands import BUILTIN_SLASH_COMMANDS, SlashCommandInfo
from pi_mono.coding_agent.core.source_info import SourceInfo, create_synthetic_source_info
from pi_mono.coding_agent.core.tools import (
    ToolName,
    all_tool_names,
    create_all_tools,
    create_coding_tools,
    create_read_only_tools,
    create_tool,
)
from pi_mono.agent.harness.compaction.compaction import estimate_messages_tokens, estimate_tokens
from pi_mono.coding_agent.core.tools.edit_diff import (
    EditDiffResult,
    generate_diff_string,
    generate_unified_patch,
)
from pi_mono.coding_agent.main import MainOptions, main
from pi_mono.coding_agent.modes.print_mode import PrintModeOptions, run_print_mode

__all__ = [
    "Args",
    "Mode",
    "parse_args",
    "print_help",
    "AgentSession",
    "AgentSessionConfig",
    "AgentSessionEvent",
    "AgentSessionEventListener",
    "PromptOptions",
    "create_agent_session",
    "create_agent_session_runtime",
    "APP_KEYBINDINGS",
    "BUILTIN_SLASH_COMMANDS",
    "BashResult",
    "CodingAgentKeybindingsManager",
    "DEFAULT_APP_KEYBINDINGS",
    "Extension",
    "ExtensionAPI",
    "ExtensionFactory",
    "ExtensionRunner",
    "LoadExtensionsResult",
    "SkillFrontmatter",
    "SlashCommandInfo",
    "SourceInfo",
    "ToolName",
    "all_tool_names",
    "create_all_tools",
    "create_coding_tools",
    "create_extension_runtime",
    "create_read_only_tools",
    "create_synthetic_source_info",
    "create_tool",
    "define_tool",
    "discover_and_load_extensions",
    "discover_extensions_in_dir",
    "EditDiffResult",
    "estimate_messages_tokens",
    "estimate_tokens",
    "execute_bash_with_operations",
    "format_prompt_template_invocation",
    "format_skill_invocation",
    "generate_diff_string",
    "generate_unified_patch",
    "load_extension_from_factory",
    "load_extensions",
    "load_prompt_templates",
    "load_skills",
    "load_sourced_prompt_templates",
    "merge_provider_attribution_headers",
    "MainOptions",
    "main",
    "PrintModeOptions",
    "run_print_mode",
]
