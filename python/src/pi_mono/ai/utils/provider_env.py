"""Provider-scoped environment resolution for pi-ai consumers."""

from __future__ import annotations

import os
from typing import Mapping

from pi_mono.ai.types import ProviderEnv

_proc_env_cache: dict[str, str] | None = None


def _get_bun_sandbox_env_value(name: str) -> str | None:
    if os.name == "posix" and not os.environ and os.path.exists("/proc/self/environ"):
        global _proc_env_cache
        if _proc_env_cache is None:
            _proc_env_cache = {}
            try:
                with open("/proc/self/environ", "rb") as handle:
                    data = handle.read()
                for entry in data.split(b"\0"):
                    if b"=" not in entry:
                        continue
                    key, value = entry.split(b"=", 1)
                    _proc_env_cache[key.decode("utf-8", errors="ignore")] = value.decode(
                        "utf-8", errors="ignore"
                    )
            except OSError:
                pass
        return _proc_env_cache.get(name)
    return None


def get_provider_env_value(
    name: str, env: ProviderEnv | Mapping[str, str] | None = None
) -> str | None:
    """Resolve an env var from scoped overrides, process env, then sandbox fallback."""
    if env and name in env:
        return env[name]
    value = os.environ.get(name)
    if value is not None:
        return value
    return _get_bun_sandbox_env_value(name)
