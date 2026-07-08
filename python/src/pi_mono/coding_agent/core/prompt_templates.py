"""Thin wrapper over agent harness prompt template loading."""

from __future__ import annotations

from pi_mono.agent.harness import prompt_templates as _harness_prompt_templates

load_prompt_templates = _harness_prompt_templates.load_prompt_templates
load_sourced_prompt_templates = _harness_prompt_templates.load_sourced_prompt_templates
format_prompt_template_invocation = _harness_prompt_templates.format_prompt_template_invocation
parse_command_args = _harness_prompt_templates.parse_command_args
substitute_args = _harness_prompt_templates.substitute_args
expand_prompt_template = _harness_prompt_templates.expand_prompt_template

__all__ = [
    "load_prompt_templates",
    "load_sourced_prompt_templates",
    "format_prompt_template_invocation",
    "parse_command_args",
    "substitute_args",
    "expand_prompt_template",
]
