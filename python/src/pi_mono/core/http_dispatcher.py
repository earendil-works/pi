import math
import os
from typing import Any

DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000


def parse_http_idle_timeout_ms(value: Any) -> int | None:
    """Parse HTTP idle timeout value into milliseconds, returning None if invalid."""
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed.lower() == "disabled":
            return 0
        if len(trimmed) == 0:
            return None
        try:
            return parse_http_idle_timeout_ms(float(trimmed))
        except ValueError:
            return None

    if isinstance(value, bool):
        return None

    if not isinstance(value, (int, float)):
        return None

    if not math.isfinite(value) or value < 0:
        return None

    return int(value)


def apply_http_proxy_settings(http_proxy: str | None) -> None:
    """Apply httpProxy setting to HTTP_PROXY/HTTPS_PROXY if not already set."""
    proxy = http_proxy.strip() if isinstance(http_proxy, str) else None
    if not proxy:
        return
    if "HTTP_PROXY" not in os.environ:
        os.environ["HTTP_PROXY"] = proxy
    if "HTTPS_PROXY" not in os.environ:
        os.environ["HTTPS_PROXY"] = proxy


def configure_http_dispatcher(timeout_ms: int = DEFAULT_HTTP_IDLE_TIMEOUT_MS) -> None:
    """No-op in Python; httpx respects HTTP_PROXY/HTTPS_PROXY from the environment."""
    del timeout_ms
