"""JSONL session storage implementation."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pi_mono.agent.harness.types import (
    JsonlSessionMetadata,
    SessionError,
    SessionTreeEntry,
    MessageEntry,
    ThinkingLevelChangeEntry,
    ModelChangeEntry,
    ActiveToolsChangeEntry,
    CompactionEntry,
    BranchSummaryEntry,
    CustomEntry,
    CustomMessageEntry,
    LabelEntry,
    SessionInfoEntry,
    LeafEntry,
)


@dataclass
class SessionHeader:
    type: str = "session"
    version: int = 3
    id: str = ""
    timestamp: str = ""
    cwd: str = ""
    parent_session: str | None = None


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


def _serialize_entry(entry: Any) -> dict:
    if isinstance(entry, dict):
        return entry

    res = {}
    res["type"] = entry.type
    res["id"] = entry.id
    res["parentId"] = entry.parent_id
    res["timestamp"] = entry.timestamp

    if entry.type == "message":
        res["message"] = entry.message
    elif entry.type == "thinking_level_change":
        res["thinkingLevel"] = entry.thinking_level
    elif entry.type == "model_change":
        res["provider"] = entry.provider
        res["modelId"] = entry.model_id
    elif entry.type == "active_tools_change":
        res["activeToolNames"] = entry.active_tool_names
    elif entry.type == "compaction":
        res["summary"] = entry.summary
        res["firstKeptEntryId"] = entry.first_kept_entry_id
        res["tokensBefore"] = entry.tokens_before
        res["details"] = entry.details
        res["fromHook"] = entry.from_hook
    elif entry.type == "branch_summary":
        res["fromId"] = entry.from_id
        res["summary"] = entry.summary
        res["details"] = entry.details
        res["fromHook"] = entry.from_hook
    elif entry.type == "custom":
        res["customType"] = entry.custom_type
        res["data"] = entry.data
    elif entry.type == "custom_message":
        res["customType"] = entry.custom_type
        res["content"] = entry.content
        res["details"] = entry.details
        res["display"] = entry.display
    elif entry.type == "label":
        res["targetId"] = entry.target_id
        res["label"] = entry.label
    elif entry.type == "session_info":
        res["name"] = entry.name
    elif entry.type == "leaf":
        res["targetId"] = entry.target_id

    return res


def _deserialize_entry(data: dict) -> Any:
    t = data.get("type")
    base_args = {
        "id": data.get("id", ""),
        "parent_id": data.get("parentId", data.get("parent_id")),
        "timestamp": data.get("timestamp", ""),
    }
    if t == "message":
        return MessageEntry(**base_args, message=data.get("message"))
    elif t == "thinking_level_change":
        return ThinkingLevelChangeEntry(
            **base_args, thinking_level=data.get("thinkingLevel", data.get("thinking_level", ""))
        )
    elif t == "model_change":
        return ModelChangeEntry(
            **base_args,
            provider=data.get("provider", ""),
            model_id=data.get("modelId", data.get("model_id", "")),
        )
    elif t == "active_tools_change":
        return ActiveToolsChangeEntry(
            **base_args,
            active_tool_names=data.get("activeToolNames", data.get("active_tool_names")),
        )
    elif t == "compaction":
        return CompactionEntry(
            **base_args,
            summary=data.get("summary", ""),
            first_kept_entry_id=data.get("firstKeptEntryId", data.get("first_kept_entry_id", "")),
            tokens_before=data.get("tokensBefore", data.get("tokens_before", 0)),
            details=data.get("details"),
            from_hook=data.get("fromHook", data.get("from_hook", False)),
        )
    elif t == "branch_summary":
        return BranchSummaryEntry(
            **base_args,
            from_id=data.get("fromId", data.get("from_id", "")),
            summary=data.get("summary", ""),
            details=data.get("details"),
            from_hook=data.get("fromHook", data.get("from_hook", False)),
        )
    elif t == "custom":
        return CustomEntry(
            **base_args,
            custom_type=data.get("customType", data.get("custom_type", "")),
            data=data.get("data"),
        )
    elif t == "custom_message":
        return CustomMessageEntry(
            **base_args,
            custom_type=data.get("customType", data.get("custom_type", "")),
            content=data.get("content", ""),
            details=data.get("details"),
            display=data.get("display", False),
        )
    elif t == "label":
        return LabelEntry(
            **base_args,
            target_id=data.get("targetId", data.get("target_id", "")),
            label=data.get("label"),
        )
    elif t == "session_info":
        return SessionInfoEntry(**base_args, name=data.get("name"))
    elif t == "leaf":
        return LeafEntry(**base_args, target_id=data.get("targetId", data.get("target_id")))
    else:
        return data


def _invalid_session(file_path: str, message: str, cause: Exception | None = None) -> SessionError:
    return SessionError(
        "invalid_session", f"Invalid JSONL session file {file_path}: {message}", cause
    )


def _invalid_entry(
    file_path: str, line_number: int, message: str, cause: Exception | None = None
) -> SessionError:
    return SessionError(
        "invalid_entry",
        f"Invalid JSONL session file {file_path}: line {line_number} {message}",
        cause,
    )


def parse_header_line(line: str, file_path: str) -> dict:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError as e:
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: first line is not a valid session header",
            e,
        )

    if not isinstance(parsed, dict):
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: first line is not a valid session header",
        )

    if parsed.get("type") != "session":
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: first line is not a valid session header",
        )
    if parsed.get("version") != 3:
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: unsupported session version",
        )
    if not isinstance(parsed.get("id"), str) or not parsed.get("id"):
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: session header is missing id",
        )
    if not isinstance(parsed.get("timestamp"), str) or not parsed.get("timestamp"):
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: session header is missing timestamp",
        )
    if not isinstance(parsed.get("cwd"), str) or not parsed.get("cwd"):
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: session header is missing cwd",
        )
    if parsed.get("parentSession") is not None and not isinstance(parsed.get("parentSession"), str):
        raise SessionError(
            "invalid_session",
            f"Invalid JSONL session file {file_path}: session header parentSession must be a string",
        )

    return {
        "type": "session",
        "version": 3,
        "id": parsed["id"],
        "timestamp": parsed["timestamp"],
        "cwd": parsed["cwd"],
        "parentSession": parsed.get("parentSession"),
    }


def parse_entry_line(line: str, file_path: str, line_number: int) -> dict:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError as e:
        raise SessionError(
            "invalid_entry",
            f"Invalid JSONL session file {file_path}: line {line_number} is not valid JSON",
            e,
        )

    if not isinstance(parsed, dict):
        raise SessionError(
            "invalid_entry",
            f"Invalid JSONL session file {file_path}: line {line_number} is not a valid session entry",
        )

    if not isinstance(parsed.get("type"), str):
        raise SessionError(
            "invalid_entry",
            f"Invalid JSONL session file {file_path}: line {line_number} is missing entry type",
        )
    if not isinstance(parsed.get("id"), str) or not parsed.get("id"):
        raise SessionError(
            "invalid_entry",
            f"Invalid JSONL session file {file_path}: line {line_number} is missing entry id",
        )
    if parsed.get("parentId") is not None and not isinstance(parsed.get("parentId"), str):
        raise SessionError(
            "invalid_entry",
            f"Invalid JSONL session file {file_path}: line {line_number} has invalid parentId",
        )
    if not isinstance(parsed.get("timestamp"), str) or not parsed.get("timestamp"):
        raise SessionError(
            "invalid_entry",
            f"Invalid JSONL session file {file_path}: line {line_number} is missing timestamp",
        )
    if (
        parsed.get("type") == "leaf"
        and parsed.get("targetId") is not None
        and not isinstance(parsed.get("targetId"), str)
    ):
        raise SessionError(
            "invalid_entry",
            f"Invalid JSONL session file {file_path}: line {line_number} has invalid targetId",
        )

    return parsed


def _leaf_id_after_entry(entry: Any) -> str | None:
    if _get_type(entry) == "leaf":
        return _get_target_id(entry)
    return _get_id(entry)


def _header_to_session_metadata(header: dict, file_path: str) -> JsonlSessionMetadata:
    return JsonlSessionMetadata(
        id=header["id"],
        created_at=header["timestamp"],
        cwd=header["cwd"],
        path=file_path,
        parent_session_path=header.get("parentSession"),
    )


async def _load_jsonl_session_metadata(
    fs: Any,
    file_path: str,
) -> JsonlSessionMetadata:
    """Load just the metadata from a JSONL session file."""
    lines_result = await fs.read_text_lines(file_path, {"maxLines": 1})
    if not lines_result.ok:
        raise SessionError(
            "storage", f"Failed to read session header {file_path}", lines_result.error
        )
    lines = lines_result.value
    if not lines or not lines[0].strip():
        raise SessionError(
            "invalid_session", f"Invalid JSONL session file {file_path}: missing session header"
        )
    header = parse_header_line(lines[0], file_path)
    return _header_to_session_metadata(header, file_path)


class JsonlSessionStorage:
    """JSONL session storage implementation."""

    def __init__(
        self,
        fs: Any,
        file_path: str,
        header: dict,
        entries: list[SessionTreeEntry],
        leaf_id: str | None,
    ):
        self.fs = fs
        self.file_path = file_path
        self.metadata = _header_to_session_metadata(header, file_path)
        self.entries = entries
        self.by_id = {_get_id(entry): entry for entry in entries}
        self.labels_by_id: dict[str, str] = {}
        self._build_labels_by_id()
        self.current_leaf_id = leaf_id

    def _build_labels_by_id(self) -> None:
        self.labels_by_id = {}
        for entry in self.entries:
            if _get_type(entry) == "label":
                label = _get_label(entry)
                target_id = _get_target_id(entry)
                if target_id is not None:
                    if label:
                        self.labels_by_id[target_id] = label.strip()
                    else:
                        self.labels_by_id.pop(target_id, None)

    @classmethod
    async def open(cls, fs: Any, file_path: str) -> "JsonlSessionStorage":
        """Open an existing JSONL session file."""
        content_result = await fs.read_text_file(file_path)
        if not content_result.ok:
            raise SessionError(
                "not_found", f"Failed to read session {file_path}", content_result.error
            )

        content = content_result.value
        lines = [line for line in content.split("\n") if line.strip()]
        if not lines:
            raise SessionError(
                "invalid_session", f"Invalid JSONL session file {file_path}: missing session header"
            )

        header = parse_header_line(lines[0], file_path)
        entries = []
        leaf_id = None

        for i in range(1, len(lines)):
            entry_dict = parse_entry_line(lines[i], file_path, i + 1)
            entry = _deserialize_entry(entry_dict)
            entries.append(entry)
            leaf_id = _leaf_id_after_entry(entry)

        return cls(fs, file_path, header, entries, leaf_id)

    @classmethod
    async def create(
        cls,
        fs: Any,
        file_path: str,
        options: dict,
    ) -> "JsonlSessionStorage":
        """Create a new JSONL session file."""
        header = {
            "type": "session",
            "version": 3,
            "id": options["sessionId"],
            "timestamp": datetime.now().isoformat(),
            "cwd": options["cwd"],
            "parentSession": options.get("parentSessionPath"),
        }

        write_res = await fs.write_file(file_path, json.dumps(header) + "\n")
        if not write_res.ok:
            raise SessionError("storage", f"Failed to write header to {file_path}", write_res.error)
        return cls(fs, file_path, header, [], None)

    async def get_metadata(self) -> JsonlSessionMetadata:
        return self.metadata

    async def get_leaf_id(self) -> str | None:
        if self.current_leaf_id and self.current_leaf_id not in self.by_id:
            raise SessionError("invalid_session", f"Entry {self.current_leaf_id} not found")
        return self.current_leaf_id

    async def set_leaf_id(self, leaf_id: str | None) -> None:
        if leaf_id is not None and leaf_id not in self.by_id:
            raise SessionError("not_found", f"Entry {leaf_id} not found")

        entry = LeafEntry(
            type="leaf",
            id=generate_entry_id(self.by_id),
            parent_id=self.current_leaf_id,
            timestamp=datetime.now().isoformat(),
            target_id=leaf_id,
        )

        serialized = _serialize_entry(entry)
        json_line = json.dumps(serialized) + "\n"
        append_res = await self.fs.append_file(self.file_path, json_line)
        if not append_res.ok:
            raise SessionError(
                "storage", f"Failed to set leaf id in {self.file_path}", append_res.error
            )

        self.entries.append(entry)
        self.by_id[entry.id] = entry
        self.current_leaf_id = leaf_id

    async def create_entry_id(self) -> str:
        return generate_entry_id(self.by_id)

    async def append_entry(self, entry: SessionTreeEntry) -> None:
        serialized = _serialize_entry(entry)
        json_line = json.dumps(serialized) + "\n"
        append_res = await self.fs.append_file(self.file_path, json_line)
        if not append_res.ok:
            raise SessionError(
                "storage", f"Failed to append entry to {self.file_path}", append_res.error
            )

        deserialized = entry if not isinstance(entry, dict) else _deserialize_entry(entry)
        self.entries.append(deserialized)
        self.by_id[deserialized.id] = deserialized
        self._update_label_cache(deserialized)
        self.current_leaf_id = _leaf_id_after_entry(deserialized)

    async def get_entry(self, id: str) -> SessionTreeEntry | None:
        return self.by_id.get(id)

    async def find_entries(self, type_: str) -> list[SessionTreeEntry]:
        return [entry for entry in self.entries if _get_type(entry) == type_]

    async def get_label(self, id: str) -> str | None:
        return self.labels_by_id.get(id)

    async def get_path_to_root(self, leaf_id: str | None) -> list[SessionTreeEntry]:
        if leaf_id is None:
            return []
        path = []
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

    def _update_label_cache(self, entry: SessionTreeEntry) -> None:
        if _get_type(entry) != "label":
            return
        label = _get_label(entry)
        target_id = _get_target_id(entry)
        if target_id is not None:
            if label:
                self.labels_by_id[target_id] = label.strip()
            else:
                self.labels_by_id.pop(target_id, None)


def generate_entry_id(by_id: dict) -> str:
    """Generate a unique 8-character entry ID."""
    for _ in range(100):
        id_ = str(uuid.uuid4())[:8]
        if id_ not in by_id:
            return id_
    return str(uuid.uuid4())


def leaf_id_after_entry(entry: Any) -> str | None:
    return _leaf_id_after_entry(entry)


loadJsonlSessionMetadata = _load_jsonl_session_metadata
