"""Footer width and formatting tests ported from footer-width.test.ts."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from pi_mono.coding_agent.core.footer_data_provider import FooterDataProvider, TokenUsageStats
from pi_mono.coding_agent.modes.interactive.components.footer import (
    FooterComponent,
    format_cwd_for_footer,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.tui.utils import visible_width
from pi_mono.utils.ansi import strip_ansi


def _create_session(
    *,
    session_name: str,
    model_id: str = "test-model",
    provider: str = "test",
    reasoning: bool = False,
    thinking_level: str = "off",
    usage: dict[str, Any] | None = None,
) -> Any:
    entries: list[dict[str, Any]] = []
    if usage is not None:
        entries.append(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "usage": usage,
                },
            }
        )

    session_manager = SimpleNamespace(
        get_entries=lambda: entries,
        get_session_name=lambda: session_name or None,
        get_cwd=lambda: "/tmp/project",
    )
    return SimpleNamespace(
        state=SimpleNamespace(
            model={
                "id": model_id,
                "provider": provider,
                "contextWindow": 200_000,
                "reasoning": reasoning,
            },
            thinkingLevel=thinking_level,
        ),
        session_manager=session_manager,
        get_context_usage=lambda: {"contextWindow": 200_000, "percent": 12.3},
        model_registry=SimpleNamespace(is_using_oauth=lambda _model: False),
    )


class _FooterData(FooterDataProvider):
    def __init__(self) -> None:
        super().__init__("/tmp/project")
        self._available_provider_count = 1

    def get_git_branch(self) -> str | None:
        return "main"

    def get_available_provider_count(self) -> int:
        return self._available_provider_count

    def get_token_stats(self, session_manager: Any) -> TokenUsageStats:
        stats = TokenUsageStats()
        for entry in session_manager.get_entries():
            if entry.get("type") != "message":
                continue
            message = entry.get("message") or {}
            if message.get("role") != "assistant":
                continue
            usage = message.get("usage") or {}
            stats.input += int(usage.get("input") or 0)
            stats.output += int(usage.get("output") or 0)
            stats.cache_read += int(usage.get("cacheRead") or 0)
            stats.cache_write += int(usage.get("cacheWrite") or 0)
            cost = usage.get("cost") or {}
            stats.total_cost += float(cost.get("total") or 0)
        return stats


def test_format_cwd_for_footer_home_prefix_edge_cases() -> None:
    assert format_cwd_for_footer("/home/user2", "/home/user") == "/home/user2"
    assert format_cwd_for_footer("/home/user", "/home/user") == "~"
    assert format_cwd_for_footer("/home/user/project", "/home/user") == "~/project"


def test_footer_keeps_lines_within_width_for_wide_session_names() -> None:
    init_theme()
    width = 93
    session = _create_session(session_name="한글" * 30)
    footer = FooterComponent(session, _FooterData())

    for line in footer.render(width):
        assert visible_width(line) <= width


def test_footer_keeps_stats_line_within_width_for_wide_model_names() -> None:
    init_theme()
    width = 60
    session = _create_session(
        session_name="",
        model_id="模" * 30,
        provider="공급자",
        reasoning=True,
        thinking_level="high",
        usage={
            "input": 12_345,
            "output": 6_789,
            "cacheRead": 0,
            "cacheWrite": 0,
            "cost": {"total": 1.234},
        },
    )
    footer_data = _FooterData()
    footer_data._available_provider_count = 2
    footer = FooterComponent(session, footer_data)

    for line in footer.render(width):
        assert visible_width(line) <= width


def test_footer_shows_latest_cache_hit_rate() -> None:
    init_theme()
    session = _create_session(
        session_name="",
        usage={
            "input": 100,
            "output": 10,
            "cacheRead": 50,
            "cacheWrite": 50,
            "cost": {"total": 0.001},
        },
    )
    footer = FooterComponent(session, _FooterData())

    stats_line = strip_ansi(footer.render(120)[1])
    assert "CH25.0%" in stats_line
