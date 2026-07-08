"""Serialize file mutation operations targeting the same file."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")

_file_locks: dict[str, asyncio.Lock] = {}
_registration_lock = asyncio.Lock()


async def with_file_mutation_queue(file_path: str, fn: Callable[[], Awaitable[T]]) -> T:
    key = os.path.abspath(file_path)
    async with _registration_lock:
        lock = _file_locks.setdefault(key, asyncio.Lock())
    async with lock:
        return await fn()
