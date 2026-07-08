"""Footer component showing cwd, model, and context usage."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Protocol

from pi_mono.coding_agent.core.experimental import are_experimental_features_enabled
from pi_mono.coding_agent.core.footer_data_provider import (
    FooterDataProvider,
    get_latest_cache_hit_rate,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.utils import truncate_to_width, visible_width


def sanitize_status_text(text: str) -> str:
    return " ".join(text.replace("\r", " ").replace("\n", " ").replace("\t", " ").split()).strip()


def format_tokens(count: int) -> str:
    if count < 1000:
        return str(count)
    if count < 10000:
        return f"{count / 1000:.1f}k"
    if count < 1_000_000:
        return f"{round(count / 1000)}k"
    if count < 10_000_000:
        return f"{count / 1_000_000:.1f}M"
    return f"{round(count / 1_000_000)}M"


def format_cwd_for_footer(cwd: str, home: str | None) -> str:
    if not home:
        return cwd
    resolved_cwd = Path(cwd).resolve()
    resolved_home = Path(home).resolve()
    try:
        relative_to_home = os.path.relpath(resolved_cwd, resolved_home)
    except ValueError:
        return cwd
    is_inside_home = relative_to_home == "." or (
        not relative_to_home.startswith("..") and not Path(relative_to_home).is_absolute()
    )
    if not is_inside_home:
        return cwd
    if relative_to_home == ".":
        return "~"
    return f"~{os.sep}{relative_to_home}"


class FooterDataProviderProtocol(Protocol):
    def get_git_branch(self) -> str | None: ...

    def get_extension_statuses(self) -> dict[str, str]: ...

    def get_available_provider_count(self) -> int: ...

    def get_token_stats(self, session_manager: Any) -> Any: ...


class SimpleFooterDataProvider(FooterDataProvider):
    """Backward-compatible alias for FooterDataProvider."""


class FooterComponent:
    """Footer showing pwd, token stats, and context usage."""

    def __init__(self, session: Any, footer_data: FooterDataProviderProtocol) -> None:
        self._session = session
        self._footer_data = footer_data
        self._auto_compact_enabled = True

    def set_session(self, session: Any) -> None:
        self._session = session

    def set_auto_compact_enabled(self, enabled: bool) -> None:
        self._auto_compact_enabled = enabled

    def invalidate(self) -> None:
        pass

    def dispose(self) -> None:
        pass

    def render(self, width: int) -> list[str]:
        state = self._session.state
        session_manager = self._session.session_manager

        token_stats = self._footer_data.get_token_stats(session_manager)
        total_input = token_stats.input
        total_output = token_stats.output
        total_cache_read = token_stats.cache_read
        total_cache_write = token_stats.cache_write
        total_cost = token_stats.total_cost

        context_usage = None
        get_context_usage = getattr(self._session, "get_context_usage", None)
        if callable(get_context_usage):
            context_usage = get_context_usage()

        model = state.model or {}
        context_window = (
            (context_usage or {}).get("contextWindow") or model.get("contextWindow") or 0
        )
        context_percent_value = (context_usage or {}).get("percent")
        if context_percent_value is None:
            context_percent = "?"
        else:
            context_percent = f"{float(context_percent_value):.1f}"

        home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
        pwd = format_cwd_for_footer(session_manager.get_cwd(), home)
        branch = self._footer_data.get_git_branch()
        if branch:
            pwd = f"{pwd} ({branch})"

        session_name = session_manager.get_session_name()
        if session_name:
            pwd = f"{pwd} • {session_name}"

        stats_parts: list[str] = []
        if total_input:
            stats_parts.append(f"↑{format_tokens(total_input)}")
        if total_output:
            stats_parts.append(f"↓{format_tokens(total_output)}")
        if total_cache_read:
            stats_parts.append(f"R{format_tokens(total_cache_read)}")
        if total_cache_write:
            stats_parts.append(f"W{format_tokens(total_cache_write)}")
        latest_cache_hit_rate = get_latest_cache_hit_rate(session_manager)
        if (total_cache_read > 0 or total_cache_write > 0) and latest_cache_hit_rate is not None:
            stats_parts.append(f"CH{latest_cache_hit_rate:.1f}%")
        using_subscription = False
        model_registry = getattr(self._session, "model_registry", None)
        if model and model_registry is not None and hasattr(model_registry, "is_using_oauth"):
            using_subscription = bool(model_registry.is_using_oauth(model))
        if total_cost or using_subscription:
            cost_str = f"${total_cost:.3f}{' (sub)' if using_subscription else ''}"
            stats_parts.append(cost_str)

        auto_indicator = " (auto)" if self._auto_compact_enabled else ""
        if context_percent == "?":
            context_display = f"?/{format_tokens(int(context_window))}{auto_indicator}"
        else:
            context_display = (
                f"{context_percent}%/{format_tokens(int(context_window))}{auto_indicator}"
            )

        percent_num = float(context_percent_value) if context_percent_value is not None else 0.0
        if percent_num > 90:
            context_percent_str = theme.fg("error", context_display)
        elif percent_num > 70:
            context_percent_str = theme.fg("warning", context_display)
        else:
            context_percent_str = context_display
        stats_parts.append(context_percent_str)
        if are_experimental_features_enabled():
            stats_parts.append(f"{theme.fg('dim', '•')} {theme.bold(theme.fg('warning', 'xp'))}")

        stats_left = " ".join(stats_parts)
        model_name = model.get("id") or "no-model"
        stats_left_width = visible_width(stats_left)
        if stats_left_width > width:
            stats_left = truncate_to_width(stats_left, width, "...")
            stats_left_width = visible_width(stats_left)

        min_padding = 2
        right_side = model_name
        if model.get("reasoning"):
            thinking_level = state.thinkingLevel or "off"
            if thinking_level == "off":
                right_side = f"{model_name} • thinking off"
            else:
                right_side = f"{model_name} • {thinking_level}"

        if self._footer_data.get_available_provider_count() > 1 and model.get("provider"):
            candidate = f"({model['provider']}) {right_side}"
            if stats_left_width + min_padding + visible_width(candidate) <= width:
                right_side = candidate

        right_side_width = visible_width(right_side)
        total_needed = stats_left_width + min_padding + right_side_width
        if total_needed <= width:
            padding = " " * (width - stats_left_width - right_side_width)
            stats_line = stats_left + padding + right_side
        else:
            available_for_right = width - stats_left_width - min_padding
            if available_for_right > 0:
                truncated_right = truncate_to_width(right_side, available_for_right, "")
                truncated_right_width = visible_width(truncated_right)
                padding = " " * max(0, width - stats_left_width - truncated_right_width)
                stats_line = stats_left + padding + truncated_right
            else:
                stats_line = stats_left

        dim_stats_left = theme.fg("dim", stats_left)
        remainder = stats_line[len(stats_left) :]
        dim_remainder = theme.fg("dim", remainder)
        pwd_line = truncate_to_width(theme.fg("dim", pwd), width, theme.fg("dim", "..."))
        lines = [pwd_line, dim_stats_left + dim_remainder]

        extension_statuses = self._footer_data.get_extension_statuses()
        if extension_statuses:
            sorted_statuses = [
                sanitize_status_text(text)
                for _, text in sorted(extension_statuses.items(), key=lambda item: item[0])
            ]
            status_line = " ".join(sorted_statuses)
            lines.append(truncate_to_width(status_line, width, theme.fg("dim", "...")))

        return lines


class FooterRenderComponent:
    """Adapter so FooterComponent can be used in the TUI component tree."""

    def __init__(self, footer: FooterComponent) -> None:
        self._footer = footer

    def invalidate(self) -> None:
        self._footer.invalidate()

    def render(self, width: int) -> list[str]:
        return self._footer.render(width)
