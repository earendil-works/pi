"""JSONL session repository implementation."""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from pi_mono.agent.harness.types import (
    JsonlSessionCreateOptions,
    JsonlSessionMetadata,
    SessionError,
)
from pi_mono.agent.harness.session.jsonl_storage import (
    JsonlSessionStorage,
    loadJsonlSessionMetadata,
)


NL = "\n"
BS = "\\"


def _encode_cwd(cwd: str) -> str:
    """Encode working directory for filesystem-safe path."""
    prefix = "--"
    suffix = "--"
    sanitized = cwd.lstrip("/" + BS).replace("/", "-").replace(BS, "-").replace(":", "-")
    return prefix + sanitized + suffix


def create_session_id() -> str:
    """Generate a unique session ID."""
    import uuid

    return uuid.uuid4().hex[:12]


def create_timestamp() -> str:
    """Create ISO timestamp for session file naming."""
    return datetime.now().strftime("%Y-%m-%dT%H-%M-%S.%f")[:-3]


class JsonlSessionRepo:
    """JSONL session repository implementation."""

    def __init__(self, fs: Any, sessions_root: str):
        self.fs = fs
        self.sessions_root_input = sessions_root
        self.sessions_root: str | None = None

    async def _get_sessions_root(self) -> str:
        if self.sessions_root is None:
            self.sessions_root = os.path.abspath(self.sessions_root_input)
        return self.sessions_root

    async def _get_session_dir(self, cwd: str) -> str:
        sessions_root = await self._get_sessions_root()
        session_dir = os.path.join(sessions_root, _encode_cwd(cwd))
        return session_dir

    async def _create_session_file_path(self, cwd: str, session_id: str, timestamp: str) -> str:
        session_dir = await self._get_session_dir(cwd)
        timestamp_safe = timestamp.replace(":", "-").replace(".", "-")
        filename = f"{timestamp_safe}_{session_id}.jsonl"
        return os.path.join(session_dir, filename)

    async def create(self, options: JsonlSessionCreateOptions) -> Any:
        """Create a new session."""
        from pi_mono.agent.harness.session.repo_utils import create_session_id, to_session

        session_id = options.id or create_session_id()

        session_dir = await self._get_session_dir(options.cwd)
        await self.fs.create_dir(session_dir, {"recursive": True})

        file_path = await self._create_session_file_path(
            options.cwd, session_id, datetime.now().isoformat()
        )

        storage = await JsonlSessionStorage.create(
            self.fs,
            file_path,
            {
                "cwd": options.cwd,
                "sessionId": session_id,
                "parentSessionPath": options.parent_session_path,
            },
        )

        return to_session(storage)

    async def open(self, metadata: JsonlSessionMetadata) -> Any:
        """Open an existing session by metadata."""
        from pi_mono.agent.harness.session.repo_utils import to_session

        exists_res = await self.fs.exists(metadata.path)
        if not exists_res.ok or not exists_res.value:
            raise SessionError("not_found", f"Session not found: {metadata.path}")

        storage = await JsonlSessionStorage.open(self.fs, metadata.path)
        return to_session(storage)

    async def list(self, options: Any = None) -> list:
        """List sessions."""
        cwd_val = None
        if options:
            if isinstance(options, dict):
                cwd_val = options.get("cwd")
            else:
                cwd_val = getattr(options, "cwd", None)

        if cwd_val:
            dirs = [await self._get_session_dir(cwd_val)]
        else:
            dirs = await self._list_session_dirs()

        sessions = []
        for dir_path in dirs:
            exists_res = await self.fs.exists(dir_path)
            if not exists_res.ok or not exists_res.value:
                continue

            list_res = await self.fs.list_dir(dir_path)
            if not list_res.ok:
                continue

            for entry in list_res.value:
                if entry.name.endswith(".jsonl"):
                    try:
                        metadata = await loadJsonlSessionMetadata(self.fs, entry.path)
                        sessions.append(metadata)
                    except Exception:
                        # Skip invalid sessions
                        pass

        # Sort by created_at descending
        sessions.sort(
            key=lambda s: getattr(s, "created_at", getattr(s, "createdAt", "")), reverse=True
        )
        return sessions

    async def delete(self, metadata: JsonlSessionMetadata) -> None:
        """Delete a session."""
        await self.fs.remove(metadata.path, {"force": True})

    async def fork(
        self,
        source_metadata: JsonlSessionMetadata,
        options: Any,
    ) -> Any:
        """Fork a session from a given entry."""
        from pi_mono.agent.harness.session.repo_utils import (
            create_session_id,
            get_entries_to_fork,
            to_session,
        )

        source = await self.open(source_metadata)
        forked_entries = await get_entries_to_fork(source.get_storage(), options)

        session_id = None
        cwd = ""
        parent_session_path = None

        if isinstance(options, dict):
            session_id = options.get("id")
            cwd = options.get("cwd", "")
            parent_session_path = options.get("parentSessionPath") or options.get(
                "parent_session_path"
            )
        else:
            session_id = getattr(options, "id", None)
            cwd = getattr(options, "cwd", "")
            parent_session_path = getattr(
                options, "parent_session_path", getattr(options, "parentSessionPath", None)
            )

        session_id = session_id or create_session_id()
        parent_session_path = parent_session_path or source_metadata.path

        session_dir = await self._get_session_dir(cwd)
        await self.fs.create_dir(session_dir, {"recursive": True})

        file_path = await self._create_session_file_path(
            cwd, session_id, datetime.now().isoformat()
        )

        storage = await JsonlSessionStorage.create(
            self.fs,
            file_path,
            {
                "cwd": cwd,
                "sessionId": session_id,
                "parentSessionPath": parent_session_path,
            },
        )

        for entry in forked_entries:
            await storage.append_entry(entry)

        return to_session(storage)

    async def _list_session_dirs(self) -> list[str]:
        sessions_root = await self._get_sessions_root()
        exists_res = await self.fs.exists(sessions_root)
        if not exists_res.ok or not exists_res.value:
            return []

        list_res = await self.fs.list_dir(sessions_root)
        if not list_res.ok:
            return []

        return [entry.path for entry in list_res.value if entry.kind == "directory"]
