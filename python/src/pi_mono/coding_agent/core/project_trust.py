"""Resolve whether project-local pi resources are trusted for a cwd."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, Protocol

from pi_mono.config import CONFIG_DIR_NAME
from pi_mono.coding_agent.core.extensions.project_trust_event import emit_project_trust_event
from pi_mono.coding_agent.core.extensions.types import (
    ProjectTrustEvent,
)
from pi_mono.coding_agent.core.trust_manager import (
    ProjectTrustOption,
    ProjectTrustStore,
    get_project_trust_options,
    has_trust_requiring_project_resources,
)

AppMode = Literal["interactive", "print", "json", "rpc"]


class ProjectTrustUI(Protocol):
    async def select(self, title: str, options: list[str]) -> str | None: ...


@dataclass
class ProjectTrustContext:
    has_ui: bool
    ui: ProjectTrustUI | None = None


@dataclass
class ResolveProjectTrustedOptions:
    cwd: str
    trust_store: ProjectTrustStore
    project_trust_context: ProjectTrustContext
    trust_override: bool | None = None
    default_project_trust: Literal["ask", "always", "never"] | None = None
    extensions_result: Any | None = None
    on_extension_error: Callable[[str], None] | None = None


def format_project_trust_prompt(cwd: str) -> str:
    return (
        f"Trust project folder?\n{cwd}\n\n"
        f"This allows pi to load {CONFIG_DIR_NAME} settings and resources, install missing "
        "project packages, and execute project extensions."
    )


async def _select_project_trust_option(
    cwd: str, ctx: ProjectTrustContext
) -> ProjectTrustOption | None:
    if ctx.ui is None:
        return None
    options = get_project_trust_options(cwd, include_session_only=True)
    labels = [option.label for option in options]
    selected = await ctx.ui.select(format_project_trust_prompt(cwd), labels)
    if selected is None:
        return None
    return next((option for option in options if option.label == selected), None)


def _save_project_trust_prompt_result(
    trust_store: ProjectTrustStore, result: ProjectTrustOption
) -> None:
    if result.updates:
        trust_store.set_many(result.updates)


async def resolve_project_trusted(options: ResolveProjectTrustedOptions) -> bool:
    if options.trust_override is not None:
        return options.trust_override
    if not has_trust_requiring_project_resources(options.cwd):
        return True

    if options.extensions_result is not None:
        result, errors = await emit_project_trust_event(
            options.extensions_result,
            ProjectTrustEvent(type="project_trust", cwd=options.cwd),
            options.project_trust_context,
        )
        for error in errors:
            message = f'Extension "{error.extension_path}" project_trust error: {error.error}'
            if options.on_extension_error is not None:
                options.on_extension_error(message)
        if result is not None:
            trusted = result.trusted == "yes"
            if result.remember is True:
                options.trust_store.set(options.cwd, trusted)
            return trusted

    decision = options.trust_store.get(options.cwd)
    if decision is not None:
        return decision

    default = options.default_project_trust or "ask"
    if default == "always":
        return True
    if default == "never":
        return False

    if not options.project_trust_context.has_ui:
        return False

    selected = await _select_project_trust_option(options.cwd, options.project_trust_context)
    if selected is not None:
        _save_project_trust_prompt_result(options.trust_store, selected)
        return selected.trusted
    return False
