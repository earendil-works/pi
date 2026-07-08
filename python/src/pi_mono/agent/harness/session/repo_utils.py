"""Repository utilities for session management."""

from datetime import datetime
from typing import Any

from pi_mono.agent.harness.types import (
    Result,
    SessionError,
    SessionStorage,
)
from pi_mono.agent.harness.session.session import Session


def create_session_id() -> str:
    """Generate a unique session ID."""
    import uuid

    return uuid.uuid4().hex[:12]


def create_timestamp() -> str:
    """Create ISO timestamp for session file naming."""
    return datetime.now().isoformat()


def to_session(storage: SessionStorage[Any]) -> Session[Any]:
    """Convert storage to Session object."""
    return Session(storage)


def get_file_system_result_or_throw(
    result: Result[Any, Any],
    message: str,
) -> Any:
    """Throw SessionError if result is an error."""
    if not result.ok:
        code = "not_found" if result.error.code == "not_found" else "storage"
        raise SessionError(code, f"{message}: {result.error.message}", result.error)
    return result.value


def _get_type(entry: Any) -> str:
    if isinstance(entry, dict):
        return entry.get("type", "")
    return getattr(entry, "type", "")


def _get_id(entry: Any) -> str:
    if isinstance(entry, dict):
        return entry.get("id", "")
    return getattr(entry, "id", "")


def _get_parent_id(entry: Any) -> str | None:
    if isinstance(entry, dict):
        return entry.get("parentId", entry.get("parent_id"))
    return getattr(entry, "parent_id", getattr(entry, "parentId", None))


async def get_entries_to_fork(
    storage: SessionStorage,
    options: Any,
) -> list[Any]:
    """Get entries to fork from storage."""
    entry_id = None
    position = "before"

    if isinstance(options, dict):
        entry_id = options.get("entryId") or options.get("entry_id")
        position = options.get("position", "before")
    else:
        entry_id = getattr(options, "entry_id", getattr(options, "entryId", None))
        position = getattr(options, "position", "before")

    if not entry_id:
        return await storage.get_entries()

    target = await storage.get_entry(entry_id)
    if not target:
        raise SessionError("invalid_fork_target", f"Entry {entry_id} not found")

    if position == "at":
        effective_leaf_id = _get_id(target)
    else:
        msg = (
            getattr(target, "message", None)
            if not isinstance(target, dict)
            else target.get("message")
        )
        msg = msg or {}
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", None)

        if _get_type(target) != "message" or role != "user":
            raise SessionError("invalid_fork_target", f"Entry {entry_id} is not a user message")
        effective_leaf_id = _get_parent_id(target)

    return await storage.get_path_to_root(effective_leaf_id)
