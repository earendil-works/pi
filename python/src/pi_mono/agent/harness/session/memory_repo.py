"""In-memory session repository implementation."""

from datetime import datetime
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from pi_mono.agent.harness.session.session import Session

from pi_mono.agent.harness.types import (
    SessionError,
    SessionMetadata,
)
from pi_mono.agent.harness.session.memory_storage import InMemorySessionStorage
from pi_mono.agent.harness.session.repo_utils import (
    create_session_id,
    get_entries_to_fork,
    to_session,
)


class InMemorySessionRepo:
    """In-memory session repository implementation."""

    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}

    async def create(self, options: Any) -> Any:
        """Create a new session."""
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
        metadata = SessionMetadata(
            id=session_id,
            created_at=datetime.now().isoformat(),
        )
        setattr(metadata, "cwd", cwd)
        setattr(metadata, "path", f"memory://{cwd}/{session_id}")
        setattr(metadata, "parent_session_path", parent_session_path)

        storage = InMemorySessionStorage({"metadata": metadata})

        session = to_session(storage)
        self.sessions[session_id] = session

        return session

    async def open(self, metadata: Any) -> Any:
        """Open an existing session by metadata."""
        session_id = (
            metadata.get("id") if isinstance(metadata, dict) else getattr(metadata, "id", None)
        )
        if not session_id or session_id not in self.sessions:
            raise SessionError("not_found", f"Session not found: {session_id}")

        return self.sessions[session_id]

    async def list(self, options: Any = None) -> list:
        """List sessions."""
        unique_sessions = list(self.sessions.values())
        unique_sessions.sort(
            key=lambda s: getattr(
                s.get_storage().metadata,
                "created_at",
                getattr(s.get_storage().metadata, "createdAt", ""),
            ),
            reverse=True,
        )
        return [s.get_storage().metadata for s in unique_sessions]

    async def delete(self, metadata: Any) -> None:
        """Delete a session."""
        session_id = (
            metadata.get("id") if isinstance(metadata, dict) else getattr(metadata, "id", None)
        )
        if session_id in self.sessions:
            del self.sessions[session_id]

    async def fork(
        self,
        source_metadata: Any,
        options: Any,
    ) -> Any:
        """Fork a session from a given entry."""
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
        parent_session_path = parent_session_path or getattr(
            source_metadata,
            "path",
            source_metadata.get("path") if isinstance(source_metadata, dict) else "",
        )

        metadata = SessionMetadata(
            id=session_id,
            created_at=datetime.now().isoformat(),
        )
        setattr(metadata, "cwd", cwd)
        setattr(metadata, "path", f"memory://{cwd}/{session_id}")
        setattr(metadata, "parent_session_path", parent_session_path)

        storage = InMemorySessionStorage({"metadata": metadata})

        for entry in forked_entries:
            await storage.append_entry(entry)

        session = to_session(storage)
        self.sessions[session_id] = session

        return session
