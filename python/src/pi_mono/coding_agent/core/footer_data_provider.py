"""Footer data provider: git branch, extension statuses, and token usage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pi_mono.utils.git import get_current_branch


@dataclass
class TokenUsageStats:
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    total_cost: float = 0.0


def get_last_assistant_usage(session_manager: Any) -> TokenUsageStats | None:
    """Return usage from the most recent assistant message on the current branch."""
    for entry in reversed(session_manager.get_branch()):
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        if message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        cost = usage.get("cost") or {}
        return TokenUsageStats(
            input=int(usage.get("input") or 0),
            output=int(usage.get("output") or 0),
            cache_read=int(usage.get("cacheRead") or 0),
            cache_write=int(usage.get("cacheWrite") or 0),
            total_cost=float(cost.get("total") or 0),
        )
    return None


def get_cumulative_token_stats(session_manager: Any) -> TokenUsageStats:
    """Aggregate usage from all assistant messages in the session."""
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


def get_latest_cache_hit_rate(session_manager: Any) -> float | None:
    """Return cache hit rate from the most recent assistant message with usage."""
    latest: float | None = None
    for entry in session_manager.get_entries():
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        if message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        cache_read = int(usage.get("cacheRead") or 0)
        cache_write = int(usage.get("cacheWrite") or 0)
        input_tokens = int(usage.get("input") or 0)
        latest_prompt_tokens = input_tokens + cache_read + cache_write
        if latest_prompt_tokens > 0:
            latest = (cache_read / latest_prompt_tokens) * 100
    return latest


class FooterDataProvider:
    """Provides git branch and extension statuses for the footer."""

    def __init__(self, cwd: str) -> None:
        self._cwd = cwd
        self._extension_statuses: dict[str, str] = {}
        self._available_provider_count = 0
        self._branch_change_callbacks: list[Any] = []

    def get_git_branch(self) -> str | None:
        return get_current_branch(self._cwd)

    def get_extension_statuses(self) -> dict[str, str]:
        return dict(self._extension_statuses)

    def get_available_provider_count(self) -> int:
        return self._available_provider_count

    def get_token_stats(self, session_manager: Any) -> TokenUsageStats:
        """Cumulative token stats from all assistant messages in the session."""
        return get_cumulative_token_stats(session_manager)

    def on_branch_change(self, callback: Any) -> Any:
        self._branch_change_callbacks.append(callback)

        def unsubscribe() -> None:
            try:
                self._branch_change_callbacks.remove(callback)
            except ValueError:
                pass

        return unsubscribe

    def set_extension_status(self, key: str, text: str | None) -> None:
        if text is None:
            self._extension_statuses.pop(key, None)
        else:
            self._extension_statuses[key] = text

    def clear_extension_statuses(self) -> None:
        self._extension_statuses.clear()

    def set_available_provider_count(self, count: int) -> None:
        self._available_provider_count = count

    def set_cwd(self, cwd: str) -> None:
        if self._cwd == cwd:
            return
        self._cwd = cwd
        for callback in self._branch_change_callbacks:
            callback()

    def dispose(self) -> None:
        self._branch_change_callbacks.clear()
