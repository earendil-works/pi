"""Detect prompt-cache misses from session usage deltas."""

from __future__ import annotations

from typing import Any, Protocol, TypedDict

from pi_mono.ai.types import AssistantMessage

CACHE_TTL_MS = 5 * 60 * 1000
_NOISE_FLOOR_TOKENS = 1024


class CacheMiss(TypedDict):
    missedTokens: int
    missedCost: float
    idleMs: int
    modelChanged: bool


class CacheWasteTotals(TypedDict):
    missedTokens: int
    missedCost: float
    missCount: int


class ModelPriceSource(Protocol):
    def find(self, provider: str, model_id: str) -> dict[str, Any] | None: ...


class _PreviousRequest(TypedDict):
    promptTokens: int
    modelKey: str
    timestamp: int
    reportedCache: bool


def _detect_miss(
    prev: _PreviousRequest | None,
    message: AssistantMessage,
    models: ModelPriceSource,
) -> CacheMiss | None:
    usage = message.get("usage") or {}
    prompt_tokens = int(usage.get("input", 0)) + int(usage.get("cacheRead", 0)) + int(
        usage.get("cacheWrite", 0)
    )
    cache_activity = int(usage.get("cacheRead", 0)) + int(usage.get("cacheWrite", 0))
    if not prev or prompt_tokens <= 0 or (cache_activity == 0 and not prev["reportedCache"]):
        return None

    missed_tokens = min(prev["promptTokens"], prompt_tokens) - int(usage.get("cacheRead", 0))
    if missed_tokens <= _NOISE_FLOOR_TOKENS:
        return None

    cost = usage.get("cost") or {}
    paid_tokens = int(usage.get("input", 0)) + int(usage.get("cacheWrite", 0))
    paid_per_token = (
        (float(cost.get("input", 0)) + float(cost.get("cacheWrite", 0))) / paid_tokens
        if paid_tokens > 0
        else 0.0
    )
    cache_read = int(usage.get("cacheRead", 0))
    if cache_read > 0:
        read_per_token = float(cost.get("cacheRead", 0)) / cache_read
    else:
        model = models.find(str(message.get("provider", "")), str(message.get("model", "")))
        model_cost = (model or {}).get("cost") or {}
        read_per_token = float(model_cost.get("cacheRead", 0)) / 1_000_000

    return {
        "missedTokens": missed_tokens,
        "missedCost": missed_tokens * max(0.0, paid_per_token - read_per_token),
        "idleMs": max(0, int(message.get("timestamp", 0)) - prev["timestamp"]),
        "modelChanged": f"{message.get('provider')}/{message.get('model')}" != prev["modelKey"],
    }


def _as_previous_request(
    message: AssistantMessage, reported_cache: bool
) -> _PreviousRequest | None:
    usage = message.get("usage") or {}
    prompt_tokens = int(usage.get("input", 0)) + int(usage.get("cacheRead", 0)) + int(
        usage.get("cacheWrite", 0)
    )
    if prompt_tokens <= 0:
        return None
    return {
        "promptTokens": prompt_tokens,
        "modelKey": f"{message.get('provider')}/{message.get('model')}",
        "timestamp": int(message.get("timestamp", 0)),
        "reportedCache": reported_cache
        or (int(usage.get("cacheRead", 0)) + int(usage.get("cacheWrite", 0)) > 0),
    }


def _scan(
    entries: list[dict[str, Any]],
    models: ModelPriceSource,
) -> tuple[_PreviousRequest | None, CacheWasteTotals, dict[int, CacheMiss]]:
    prev: _PreviousRequest | None = None
    totals: CacheWasteTotals = {"missedTokens": 0, "missedCost": 0.0, "missCount": 0}
    # Key by id(message) so rebuild can look up by message identity when available.
    misses: dict[int, CacheMiss] = {}

    for entry in entries:
        entry_type = entry.get("type")
        if entry_type in ("compaction", "branch_summary"):
            prev = None
            continue
        if entry_type == "message" and (entry.get("message") or {}).get("role") == "assistant":
            message = entry["message"]
            miss = _detect_miss(prev, message, models)
            if miss:
                totals["missedTokens"] += miss["missedTokens"]
                totals["missedCost"] += miss["missedCost"]
                totals["missCount"] += 1
                misses[id(message)] = miss
            prev = _as_previous_request(message, prev["reportedCache"] if prev else False) or prev
    return prev, totals, misses


def compute_cache_waste(
    entries: list[dict[str, Any]], models: ModelPriceSource
) -> CacheWasteTotals:
    return _scan(entries, models)[1]


def collect_cache_misses(
    entries: list[dict[str, Any]], models: ModelPriceSource
) -> dict[int, CacheMiss]:
    return _scan(entries, models)[2]


def detect_cache_miss(
    entries: list[dict[str, Any]],
    message: AssistantMessage,
    models: ModelPriceSource,
) -> CacheMiss | None:
    """Detect a miss on a just-completed assistant message.

    ``entries`` must not yet contain ``message`` (message_end fires before persistence).
    """
    return _detect_miss(_scan(entries, models)[0], message, models)
