"""Cursor CLI auth helpers for the coding agent."""

from __future__ import annotations

from pi_mono.ai.cursor_agent import is_cursor_agent_authenticated
from pi_mono.core.auth_storage import AuthStorage

CURSOR_CLI_LOGIN_HINT = (
    "Cursor OAuth credentials in auth.json are not used by the Python port. "
    "Run /login → Use a subscription → Cursor to authenticate via `agent login`."
)


def get_cursor_auth_warning(auth_storage: AuthStorage) -> str | None:
    if is_cursor_agent_authenticated():
        return None
    credential = auth_storage.get("cursor")
    if credential and credential.get("type") == "oauth":
        return CURSOR_CLI_LOGIN_HINT
    return None


def clear_stale_cursor_oauth(auth_storage: AuthStorage) -> bool:
    """Remove unused Cursor OAuth creds after successful CLI login."""
    credential = auth_storage.get("cursor")
    if credential and credential.get("type") == "oauth":
        auth_storage.remove("cursor")
        return True
    return False
