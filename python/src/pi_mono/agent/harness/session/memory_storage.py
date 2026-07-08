"""In-memory session storage implementation."""

from datetime import datetime
import uuid
from typing import Any, Generic, TypeVar

from pi_mono.agent.harness.types import (
    SessionError,
    SessionMetadata,
    SessionTreeEntry,
    LeafEntry,
)

TMetadata = TypeVar("TMetadata", bound=SessionMetadata)


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


def _get_target_id(entry: Any) -> str | None:
    if isinstance(entry, dict):
        return entry.get("targetId", entry.get("target_id"))
    return getattr(entry, "target_id", getattr(entry, "targetId", None))


def _get_label(entry: Any) -> str | None:
    if isinstance(entry, dict):
        return entry.get("label")
    return getattr(entry, "label", None)


def _update_label_cache(labels_by_id: dict[str, str], entry: SessionTreeEntry) -> None:
    if _get_type(entry) != "label":
        return
    label = _get_label(entry)
    target_id = _get_target_id(entry)
    if target_id is None:
        return
    if label is not None:
        labels_by_id[target_id] = label.strip()
    else:
        labels_by_id.pop(target_id, None)


def _build_labels_by_id(entries: list[SessionTreeEntry]) -> dict[str, str]:
    labels_by_id: dict[str, str] = {}
    for entry in entries:
        _update_label_cache(labels_by_id, entry)
    return labels_by_id


def _generate_entry_id(by_id: dict[str, Any]) -> str:
    """Generate a unique 8-character entry ID."""
    for _ in range(100):
        id_ = str(uuid.uuid4())[:8]
        if id_ not in by_id:
            return id_
    return str(uuid.uuid4())


def _leaf_id_after_entry(entry: SessionTreeEntry) -> str | None:
    if _get_type(entry) == "leaf":
        return _get_target_id(entry)
    return _get_id(entry)


class InMemorySessionStorage(Generic[TMetadata]):
    """In-memory session storage implementation."""

    def __init__(
        self,
        options: dict[str, Any] | None = None,
    ) -> None:
        options = options or {}
        self.entries: list[SessionTreeEntry] = list(options.get("entries", []))
        self.by_id: dict[str, SessionTreeEntry] = {_get_id(entry): entry for entry in self.entries}
        self.labels_by_id = _build_labels_by_id(self.entries)
        self.leaf_id: str | None = None
        for entry in self.entries:
            self.leaf_id = _leaf_id_after_entry(entry)

        if self.leaf_id is not None and self.leaf_id not in self.by_id:
            raise SessionError("invalid_session", f"Entry {self.leaf_id} not found")

        self.metadata = options.get("metadata") or {
            "id": str(uuid.uuid4()),
            "createdAt": datetime.now().isoformat(),
        }

    async def get_metadata(self) -> dict:
        return self.metadata

    async def get_leaf_id(self) -> str | None:
        if self.leaf_id is not None and self.leaf_id not in self.by_id:
            raise SessionError("invalid_session", f"Entry {self.leaf_id} not found")
        return self.leaf_id

    async def set_leaf_id(self, leaf_id: str | None) -> None:
        if leaf_id is not None and leaf_id not in self.by_id:
            raise SessionError("not_found", f"Entry {leaf_id} not found")

        entry = LeafEntry(
            type="leaf",
            id=_generate_entry_id(self.by_id),
            parent_id=self.leaf_id,
            timestamp=datetime.now().isoformat(),
            target_id=leaf_id,
        )

        self.entries.append(entry)
        self.by_id[entry.id] = entry
        self.leaf_id = leaf_id

    async def create_entry_id(self) -> str:
        return _generate_entry_id(self.by_id)

    async def append_entry(self, entry: SessionTreeEntry) -> None:
        self.entries.append(entry)
        self.by_id[_get_id(entry)] = entry
        self._update_label_cache(entry)
        self.leaf_id = _leaf_id_after_entry(entry)

    def _update_label_cache(self, entry: SessionTreeEntry) -> None:
        _update_label_cache(self.labels_by_id, entry)

    async def get_entry(self, id: str) -> SessionTreeEntry | None:
        return self.by_id.get(id)

    async def find_entries(self, type_: str) -> list[SessionTreeEntry]:
        return [entry for entry in self.entries if _get_type(entry) == type_]

    async def get_label(self, id: str) -> str | None:
        return self.labels_by_id.get(id)

    async def get_path_to_root(self, leaf_id: str | None) -> list[SessionTreeEntry]:
        if leaf_id is None:
            return []
        path: list[SessionTreeEntry] = []
        current = self.by_id.get(leaf_id)
        if not current:
            raise SessionError("not_found", f"Entry {leaf_id} not found")

        while current:
            path.insert(0, current)
            parent_id = _get_parent_id(current)
            if not parent_id:
                break
            parent = self.by_id.get(parent_id)
            if not parent:
                raise SessionError("invalid_session", f"Entry {parent_id} not found")
            current = parent
        return path

    async def get_entries(self) -> list[SessionTreeEntry]:
        return list(self.entries)
