"""Session management for agent harness."""

from __future__ import annotations

from typing import Any, Generic, TypeVar

from pi_mono.ai.types import ImageContent, TextContent
from pi_mono.agent.types import AgentMessage
from pi_mono.agent.harness.messages import (
    create_branch_summary_message,
    create_compaction_summary_message,
    create_custom_message,
)
from pi_mono.agent.harness.types import (
    ActiveToolsChangeEntry,
    BranchSummaryEntry,
    CompactionEntry,
    CustomEntry,
    CustomMessageEntry,
    LabelEntry,
    MessageEntry,
    ModelChangeEntry,
    SessionContext,
    SessionError,
    SessionInfoEntry,
    SessionMetadata,
    SessionStorage,
    SessionTreeEntry,
    ThinkingLevelChangeEntry,
)

TMetadata = TypeVar("TMetadata", bound=SessionMetadata)


def build_session_context(path_entries: list[SessionTreeEntry]) -> SessionContext:
    """Build session context from path entries."""
    thinking_level = "off"
    model: dict[str, str] | None = None
    active_tool_names: list[str] | None = None
    compaction: CompactionEntry | None = None

    for entry in path_entries:
        if entry.type == "thinking_level_change":
            thinking_level = entry.thinking_level
        elif entry.type == "model_change":
            model = {"provider": entry.provider, "modelId": entry.model_id}
        elif entry.type == "message" and entry.message.get("role") == "assistant":
            model = {"provider": entry.message["provider"], "modelId": entry.message["model"]}
        elif entry.type == "active_tools_change":
            active_tool_names = list(entry.active_tool_names)
        elif entry.type == "compaction":
            compaction = entry

    messages: list[AgentMessage] = []

    def append_message(entry: SessionTreeEntry) -> None:
        if entry.type == "message":
            messages.append(entry.message)  # type: ignore
        elif entry.type == "custom_message":
            messages.append(
                create_custom_message(
                    entry.custom_type,
                    entry.content,  # type: ignore
                    entry.display,  # type: ignore
                    entry.details,  # type: ignore
                    entry.timestamp,  # type: ignore
                )
            )
        elif entry.type == "branch_summary" and entry.summary:
            messages.append(
                create_branch_summary_message(entry.summary, entry.from_id, entry.timestamp)
            )

    if compaction:
        messages.append(
            create_compaction_summary_message(
                compaction.summary, compaction.tokens_before, compaction.timestamp
            )
        )
        compaction_idx = next(
            i
            for i, e in enumerate(path_entries)
            if e.type == "compaction" and e.id == compaction.id
        )
        found_first_kept = False
        for i in range(compaction_idx):
            entry = path_entries[i]
            if entry.id == compaction.first_kept_entry_id:
                found_first_kept = True
            if found_first_kept:
                append_message(entry)
        for i in range(compaction_idx + 1, len(path_entries)):
            append_message(path_entries[i])
    else:
        for entry in path_entries:
            append_message(entry)

    return SessionContext(messages, thinking_level, model, active_tool_names)


class Session(Generic[TMetadata]):
    """Session wrapper around storage backend."""

    def __init__(self, storage: SessionStorage[TMetadata]) -> None:
        self._storage = storage

    async def get_metadata(self) -> TMetadata:
        return await self._storage.get_metadata()

    def get_storage(self) -> SessionStorage[TMetadata]:
        return self._storage

    async def get_leaf_id(self) -> str | None:
        return await self._storage.get_leaf_id()

    async def get_entry(self, id: str) -> Any | None:  # SessionTreeEntry
        return await self._storage.get_entry(id)

    async def get_entries(self) -> list[Any]:  # list[SessionTreeEntry]
        return await self._storage.get_entries()

    async def get_branch(self, from_id: str | None = None) -> list[Any]:
        leaf_id = from_id or await self._storage.get_leaf_id()
        return await self._storage.get_path_to_root(leaf_id)

    async def build_context(self) -> SessionContext:
        return build_session_context(await self.get_branch())

    async def get_label(self, id: str) -> str | None:
        return await self._storage.get_label(id)

    async def get_session_name(self) -> str | None:
        entries = await self._storage.find_entries("session_info")
        if entries:
            name = entries[-1].name
            return name.strip() if name else None
        return None

    async def _append_typed_entry(self, entry: Any) -> str:  # SessionTreeEntry
        await self._storage.append_entry(entry)
        return entry.id

    async def append_message(self, message: AgentMessage) -> str:
        return await self._append_typed_entry(
            MessageEntry(
                type="message",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                message=message,
            )
        )

    async def append_thinking_level_change(self, thinking_level: str) -> str:
        return await self._append_typed_entry(
            ThinkingLevelChangeEntry(
                type="thinking_level_change",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                thinking_level=thinking_level,
            )
        )

    async def append_model_change(self, provider: str, model_id: str) -> str:
        return await self._append_typed_entry(
            ModelChangeEntry(
                type="model_change",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                provider=provider,
                model_id=model_id,
            )
        )

    async def append_active_tools_change(self, active_tool_names: list[str]) -> str:
        return await self._append_typed_entry(
            ActiveToolsChangeEntry(
                type="active_tools_change",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                active_tool_names=list(active_tool_names),
            )
        )

    async def append_compaction(
        self,
        summary: str,
        first_kept_entry_id: str,
        tokens_before: int,
        details: Any = None,
        from_hook: bool = False,
    ) -> str:
        return await self._append_typed_entry(
            CompactionEntry(
                type="compaction",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                summary=summary,
                first_kept_entry_id=first_kept_entry_id,
                tokens_before=tokens_before,
                details=details,
                from_hook=from_hook,
            )
        )

    async def append_custom_entry(self, custom_type: str, data: Any = None) -> str:
        return await self._append_typed_entry(
            CustomEntry(
                type="custom",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                custom_type=custom_type,
                data=data,
            )
        )

    async def append_custom_message_entry(
        self,
        custom_type: str,
        content: str | list[TextContent | ImageContent],
        display: bool,
        details: Any = None,
    ) -> str:
        return await self._append_typed_entry(
            CustomMessageEntry(
                type="custom_message",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                custom_type=custom_type,
                content=content,
                display=display,
                details=details,
            )
        )

    async def append_label(self, target_id: str, label: str | None) -> str:
        if not await self._storage.get_entry(target_id):
            raise SessionError("not_found", f"Entry {target_id} not found")
        return await self._append_typed_entry(
            LabelEntry(
                type="label",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                target_id=target_id,
                label=label,
            )
        )

    async def append_session_name(self, name: str) -> str:
        return await self._append_typed_entry(
            SessionInfoEntry(
                type="session_info",
                id=await self._storage.create_entry_id(),
                parent_id=await self._storage.get_leaf_id(),
                timestamp=self._iso_timestamp(),
                name=name.strip(),
            )
        )

    async def move_to(
        self,
        entry_id: str | None,
        summary: dict[str, Any] | None = None,
    ) -> str | None:
        if entry_id is not None and not await self._storage.get_entry(entry_id):
            raise SessionError("not_found", f"Entry {entry_id} not found")
        await self._storage.set_leaf_id(entry_id)
        if not summary:
            return None
        return await self._append_typed_entry(
            BranchSummaryEntry(
                type="branch_summary",
                id=await self._storage.create_entry_id(),
                parent_id=entry_id,
                timestamp=self._iso_timestamp(),
                from_id=entry_id or "root",
                summary=summary["summary"],
                details=summary.get("details"),
                from_hook=summary.get("from_hook", False),
            )
        )

    # CamelCase aliases for TS compatibility
    buildContext = build_context
    getMetadata = get_metadata
    appendMessage = append_message
    appendModelChange = append_model_change
    appendThinkingLevelChange = append_thinking_level_change
    appendActiveToolsChange = append_active_tools_change
    appendCustomEntry = append_custom_entry
    appendCustomMessageEntry = append_custom_message_entry
    appendLabel = append_label
    appendSessionName = append_session_name
    getStorage = get_storage
    getBranch = get_branch
    appendCompaction = append_compaction
    getEntry = get_entry
    getEntries = get_entries
    getLeafId = get_leaf_id
    moveTo = move_to

    @staticmethod
    def _iso_timestamp() -> str:
        import datetime

        return datetime.datetime.now(datetime.timezone.utc).isoformat()
