import os
import json
import time
import math
import secrets
import uuid
import asyncio
import re
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Union, cast

from pi_mono.ai.types import TextContent, ImageContent
from pi_mono.config import get_agent_dir as get_default_agent_dir, get_sessions_dir
from pi_mono.utils.paths import normalize_path, resolve_path

CURRENT_SESSION_VERSION = 3


def create_session_id() -> str:
    ms = int(time.time() * 1000)
    rand = secrets.token_bytes(10)
    ms_bytes = ms.to_bytes(6, byteorder="big")
    val_7_8 = 0x7000 | (int.from_bytes(rand[0:2], "big") & 0x0FFF)
    val_7_8_bytes = val_7_8.to_bytes(2, byteorder="big")
    val_9 = 0x80 | (rand[2] & 0x3F)
    rest_bytes = bytes([val_9]) + rand[3:9]
    uuid_bytes = ms_bytes + val_7_8_bytes + rest_bytes
    h = uuid_bytes.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def assert_valid_session_id(session_id: str) -> None:
    import re

    if not re.match(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$", session_id):
        raise ValueError(
            "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character"
        )


def generate_id(by_id: Union[set[str], Dict[str, Any]]) -> str:
    for _ in range(100):
        val = uuid.uuid4().hex[:8]
        if val not in by_id:
            return val
    return str(uuid.uuid4())


def migrate_v1_to_v2(entries: List[Dict[str, Any]]) -> None:
    ids: set[str] = set()
    prev_id = None

    for entry in entries:
        if entry.get("type") == "session":
            entry["version"] = 2
            continue

        entry["id"] = generate_id(ids)
        ids.add(entry["id"])
        entry["parentId"] = prev_id
        prev_id = entry["id"]

        if entry.get("type") == "compaction":
            first_kept_index = entry.get("firstKeptEntryIndex")
            if isinstance(first_kept_index, int):
                if 0 <= first_kept_index < len(entries):
                    target_entry = entries[first_kept_index]
                    if target_entry and target_entry.get("type") != "session":
                        entry["firstKeptEntryId"] = target_entry["id"]
                entry.pop("firstKeptEntryIndex", None)


def migrate_v2_to_v3(entries: List[Dict[str, Any]]) -> None:
    for entry in entries:
        if entry.get("type") == "session":
            entry["version"] = 3
            continue

        if entry.get("type") == "message":
            msg = entry.get("message")
            if msg and msg.get("role") == "hookMessage":
                msg["role"] = "custom"


def migrate_to_current_version(entries: List[Dict[str, Any]]) -> bool:
    header = next((e for e in entries if e.get("type") == "session"), None)
    if not header:
        return False
    version = header.get("version", 1)

    if version >= CURRENT_SESSION_VERSION:
        return False

    if version < 2:
        migrate_v1_to_v2(entries)
    if version < 3:
        migrate_v2_to_v3(entries)

    return True


def migrate_session_entries(entries: List[Dict[str, Any]]) -> None:
    migrate_to_current_version(entries)


def parse_session_entries(content: str) -> List[Dict[str, Any]]:
    entries = []
    lines = content.strip().split("\n")
    for line in lines:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            entries.append(entry)
        except Exception:
            pass
    return entries


def get_latest_compaction_entry(entries: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for i in range(len(entries) - 1, -1, -1):
        if entries[i].get("type") == "compaction":
            return entries[i]
    return None


class _Undefined:
    pass


UNDEFINED = _Undefined()


def build_session_context(
    entries: List[Dict[str, Any]],
    leaf_id: Union[None, str, _Undefined] = UNDEFINED,
    by_id: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    if by_id is None:
        by_id = {}
        for entry in entries:
            by_id[entry["id"]] = entry

    leaf: Optional[Dict[str, Any]] = None
    if leaf_id is None:
        return {"messages": [], "thinkingLevel": "off", "model": None}

    if isinstance(leaf_id, str):
        leaf = by_id.get(leaf_id)

    if leaf_id is UNDEFINED:
        if entries:
            leaf = entries[-1]

    if not leaf:
        return {"messages": [], "thinkingLevel": "off", "model": None}

    path: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = leaf
    while current:
        path.insert(0, current)
        parent_id = current.get("parentId")
        current = by_id.get(parent_id) if parent_id else None

    thinking_level = "off"
    model = None
    compaction = None

    for entry in path:
        entry_type = entry.get("type")
        if entry_type == "thinking_level_change":
            thinking_level = entry["thinkingLevel"]
        elif entry_type == "model_change":
            model = {"provider": entry["provider"], "modelId": entry["modelId"]}
        elif entry_type == "message" and entry.get("message", {}).get("role") == "assistant":
            msg = entry["message"]
            model = {"provider": msg.get("provider"), "modelId": msg.get("model")}
        elif entry_type == "compaction":
            compaction = entry

    messages = []

    def append_message(e: Dict[str, Any]) -> None:
        e_type = e.get("type")
        if e_type == "message":
            messages.append(e["message"])
        elif e_type == "custom_message":
            from pi_mono.core.messages import create_custom_message

            messages.append(
                create_custom_message(
                    e["customType"],
                    e["content"],
                    e["display"],
                    e.get("details"),
                    e["timestamp"],
                )
            )
        elif e_type == "branch_summary" and e.get("summary"):
            from pi_mono.core.messages import create_branch_summary_message

            messages.append(
                create_branch_summary_message(
                    e["summary"],
                    e["fromId"],
                    e["timestamp"],
                )
            )

    if compaction:
        from pi_mono.core.messages import create_compaction_summary_message

        messages.append(
            create_compaction_summary_message(
                compaction["summary"],
                compaction["tokensBefore"],
                compaction["timestamp"],
            )
        )

        compaction_idx = -1
        for idx, e in enumerate(path):
            if e.get("type") == "compaction" and e.get("id") == compaction["id"]:
                compaction_idx = idx
                break

        found_first_kept = False
        first_kept_id = compaction.get("firstKeptEntryId")
        for i in range(compaction_idx):
            entry = path[i]
            if entry.get("id") == first_kept_id:
                found_first_kept = True
            if found_first_kept:
                append_message(entry)

        for i in range(compaction_idx + 1, len(path)):
            append_message(path[i])
    else:
        for entry in path:
            append_message(entry)

    return {"messages": messages, "thinkingLevel": thinking_level, "model": model}


def get_default_session_dir_path(cwd: str, agent_dir: str = str(get_default_agent_dir())) -> str:
    resolved_cwd = resolve_path(cwd)
    resolved_agent_dir = resolve_path(agent_dir)
    replaced_cwd = resolved_cwd.replace("/", "-").replace("\\", "-").replace(":", "-")
    safe_path = f"--{replaced_cwd}--"
    safe_path = re.sub(r"-+", "-", safe_path)
    return os.path.join(resolved_agent_dir, "sessions", safe_path)


def get_default_session_dir(cwd: str, agent_dir: str = str(get_default_agent_dir())) -> str:
    session_dir = get_default_session_dir_path(cwd, agent_dir)
    if not os.path.exists(session_dir):
        os.makedirs(session_dir, exist_ok=True)
    return session_dir


def parse_session_entry_line(line: str) -> Optional[Dict[str, Any]]:
    line_stripped = line.strip()
    if not line_stripped:
        return None
    try:
        return json.loads(line_stripped)
    except Exception:
        return None


def load_entries_from_file(file_path: str) -> List[Dict[str, Any]]:
    resolved_file_path = normalize_path(file_path)
    if not os.path.exists(resolved_file_path):
        return []

    entries = []
    try:
        with open(resolved_file_path, "r", encoding="utf-8") as f:
            for line in f:
                entry = parse_session_entry_line(line)
                if entry:
                    entries.append(entry)
    except Exception:
        pass

    if len(entries) == 0:
        return entries
    header = entries[0]
    if header.get("type") != "session" or not isinstance(header.get("id"), str):
        return []

    return entries


def read_session_header(file_path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            first_line = f.readline()
        if not first_line:
            return None
        header = json.loads(first_line)
        if header.get("type") != "session" or not isinstance(header.get("id"), str):
            return None
        return header
    except Exception:
        return None


def get_session_header_cwd(header: Dict[str, Any]) -> Optional[str]:
    cwd = header.get("cwd")
    return cwd if isinstance(cwd, str) else None


def session_cwd_matches(cwd: Optional[str], resolved_cwd: str) -> bool:
    return cwd is not None and cwd != "" and resolve_path(cwd) == resolved_cwd


def find_most_recent_session(session_dir: str, cwd: Optional[str] = None) -> Optional[str]:
    resolved_session_dir = normalize_path(session_dir)
    resolved_cwd = resolve_path(cwd) if cwd else None
    try:
        files = []
        for f in os.listdir(resolved_session_dir):
            if f.endswith(".jsonl"):
                path = os.path.join(resolved_session_dir, f)
                header = read_session_header(path)
                if header is not None:
                    if not resolved_cwd or session_cwd_matches(
                        get_session_header_cwd(header), resolved_cwd
                    ):
                        files.append((path, os.stat(path).st_mtime))
        files.sort(key=lambda x: x[1], reverse=True)
        return files[0][0] if files else None
    except Exception:
        return None


def is_message_with_content(message: Dict[str, Any]) -> bool:
    return isinstance(message.get("role"), str) and "content" in message


def extract_text_content(message: Dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return " ".join(parts)
    return ""


def get_message_activity_time(entry: Dict[str, Any]) -> Optional[int]:
    message = entry.get("message")
    if not message or not is_message_with_content(message):
        return None
    if message.get("role") not in ("user", "assistant"):
        return None

    msg_timestamp = message.get("timestamp")
    if isinstance(msg_timestamp, (int, float)):
        return int(msg_timestamp)

    try:
        dt = datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def build_session_info_sync(file_path: str) -> Optional[Dict[str, Any]]:
    try:
        stats = os.stat(file_path)
        header = None
        message_count = 0
        first_message = ""
        all_messages: List[str] = []
        name = None
        last_activity_time = None

        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                entry = parse_session_entry_line(line)
                if not entry:
                    continue

                if not header:
                    if entry.get("type") != "session":
                        return None
                    header = entry
                    continue

                if entry.get("type") == "session_info":
                    name = (entry.get("name") or "").strip() or None

                if entry.get("type") != "message":
                    continue
                message_count += 1

                activity_time = get_message_activity_time(entry)
                if activity_time is not None:
                    last_activity_time = max(last_activity_time or 0, activity_time)

                message = entry.get("message")
                if not message or not is_message_with_content(message):
                    continue
                if message.get("role") not in ("user", "assistant"):
                    continue

                text_content = extract_text_content(message)
                if not text_content:
                    continue

                all_messages.append(text_content)
                if not first_message and message.get("role") == "user":
                    first_message = text_content

        if not header:
            return None

        cwd = header.get("cwd", "")
        parent_session_path = header.get("parentSession")

        header_time = float("nan")
        if header.get("timestamp"):
            try:
                header_time = (
                    datetime.fromisoformat(header["timestamp"].replace("Z", "+00:00")).timestamp()
                    * 1000
                )
            except Exception:
                pass

        if last_activity_time is not None and last_activity_time > 0:
            modified = datetime.fromtimestamp(last_activity_time / 1000.0)
        elif not math.isnan(header_time):
            modified = datetime.fromtimestamp(header_time / 1000.0)
        else:
            modified = datetime.fromtimestamp(stats.st_mtime)

        try:
            created = datetime.fromisoformat(header["timestamp"].replace("Z", "+00:00"))
        except Exception:
            created = datetime.fromtimestamp(stats.st_ctime)

        return {
            "path": file_path,
            "id": header["id"],
            "cwd": cwd,
            "name": name,
            "parentSessionPath": parent_session_path,
            "created": created,
            "modified": modified,
            "messageCount": message_count,
            "firstMessage": first_message or "(no messages)",
            "allMessagesText": " ".join(all_messages),
        }
    except Exception:
        return None


async def build_session_infos_concurrently(
    files: List[str], on_loaded_cb: Callable[[], None]
) -> List[Optional[Dict[str, Any]]]:
    sem = asyncio.Semaphore(10)

    async def worker(file: str) -> Optional[Dict[str, Any]]:
        async with sem:
            res = await asyncio.to_thread(build_session_info_sync, file)
            on_loaded_cb()
            return res

    tasks = [worker(f) for f in files]
    return await asyncio.gather(*tasks)


async def list_sessions_from_dir(
    dir_path: str,
    on_progress: Optional[Callable[[int, int], None]] = None,
    progress_offset: int = 0,
    progress_total: Optional[int] = None,
) -> List[Dict[str, Any]]:
    sessions: List[Dict[str, Any]] = []
    if not os.path.exists(dir_path):
        return sessions

    try:
        dir_entries = os.listdir(dir_path)
        files = [os.path.join(dir_path, f) for f in dir_entries if f.endswith(".jsonl")]
        total = progress_total if progress_total is not None else len(files)

        loaded = 0

        def on_loaded() -> None:
            nonlocal loaded
            loaded += 1
            if on_progress:
                on_progress(progress_offset + loaded, total)

        results = await build_session_infos_concurrently(files, on_loaded)
        for info in results:
            if info:
                sessions.append(info)
    except Exception:
        pass
    return sessions


class SessionManager:
    def __init__(
        self,
        cwd: str,
        session_dir: str,
        session_file: Optional[str],
        persist: bool,
        new_session_options: Optional[Dict[str, Any]] = None,
    ):
        self.cwd = resolve_path(cwd)
        self.session_dir = normalize_path(session_dir)
        self.persist = persist
        if persist and self.session_dir and not os.path.exists(self.session_dir):
            os.makedirs(self.session_dir, exist_ok=True)

        self.sessionId = ""
        self.sessionFile: Optional[str] = None
        self.flushed = False
        self.file_entries: List[Dict[str, Any]] = []
        self.by_id: Dict[str, Dict[str, Any]] = {}
        self.labels_by_id: Dict[str, str] = {}
        self.label_timestamps_by_id: Dict[str, str] = {}
        self.leafId: Optional[str] = None

        if session_file:
            self.set_session_file(session_file)
        else:
            self.new_session(new_session_options)

    def set_session_file(self, session_file: str) -> None:
        self.sessionFile = resolve_path(session_file)
        if os.path.exists(self.sessionFile):
            self.file_entries = load_entries_from_file(self.sessionFile)

            if len(self.file_entries) == 0:
                explicit_path = self.sessionFile
                self.new_session()
                self.sessionFile = explicit_path
                self._rewrite_file()
                self.flushed = True
                return

            header = next((e for e in self.file_entries if e.get("type") == "session"), None)
            self.sessionId = str(header["id"]) if header else create_session_id()

            if migrate_to_current_version(self.file_entries):
                self._rewrite_file()

            self._build_index()
            self.flushed = True
        else:
            explicit_path = self.sessionFile
            self.new_session()
            self.sessionFile = explicit_path

    def new_session(self, options: Optional[Dict[str, Any]] = None) -> Optional[str]:
        if options and options.get("id") is not None:
            assert_valid_session_id(options["id"])
        self.sessionId = (options.get("id") if options else None) or create_session_id()
        timestamp = datetime.utcnow().isoformat() + "Z"
        header = {
            "type": "session",
            "version": CURRENT_SESSION_VERSION,
            "id": self.sessionId,
            "timestamp": timestamp,
            "cwd": self.cwd,
            "parentSession": options.get("parentSession") if options else None,
        }
        self.file_entries = [header]
        self.by_id.clear()
        self.labels_by_id.clear()
        self.label_timestamps_by_id.clear()
        self.leafId = None
        self.flushed = False

        if self.persist:
            file_timestamp = timestamp.replace(":", "-").replace(".", "-")
            self.sessionFile = os.path.join(
                self.get_session_dir(), f"{file_timestamp}_{self.sessionId}.jsonl"
            )
        return self.sessionFile

    def _build_index(self) -> None:
        self.by_id.clear()
        self.labels_by_id.clear()
        self.label_timestamps_by_id.clear()
        self.leafId = None
        for entry in self.file_entries:
            if entry.get("type") == "session":
                continue
            entry_id = entry["id"]
            self.by_id[entry_id] = entry
            self.leafId = entry_id
            if entry.get("type") == "label":
                target_id = entry["targetId"]
                label_val = entry.get("label")
                if label_val:
                    self.labels_by_id[target_id] = label_val
                    self.label_timestamps_by_id[target_id] = entry["timestamp"]
                else:
                    self.labels_by_id.pop(target_id, None)
                    self.label_timestamps_by_id.pop(target_id, None)

    def _rewrite_file(self) -> None:
        if not self.persist or not self.sessionFile:
            return
        with open(self.sessionFile, "w", encoding="utf-8") as f:
            for entry in self.file_entries:
                f.write(f"{json.dumps(entry)}\n")

    def is_persisted(self) -> bool:
        return self.persist

    def get_cwd(self) -> str:
        return self.cwd

    def get_session_dir(self) -> str:
        return self.session_dir

    def uses_default_session_dir(self) -> bool:
        return self.session_dir == get_default_session_dir_path(self.cwd)

    def get_session_id(self) -> str:
        return self.sessionId

    def get_session_file(self) -> Optional[str]:
        return self.sessionFile

    def _persist(self, entry: Dict[str, Any]) -> None:
        if not self.persist or not self.sessionFile:
            return

        has_assistant = any(
            e.get("type") == "message" and e.get("message", {}).get("role") == "assistant"
            for e in self.file_entries
        )
        if not has_assistant:
            if self.flushed:
                with open(self.sessionFile, "a", encoding="utf-8") as f:
                    f.write(f"{json.dumps(entry)}\n")
            else:
                self.flushed = False
            return

        if not self.flushed:
            try:
                fd = os.open(self.sessionFile, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    for e in self.file_entries:
                        f.write(f"{json.dumps(e)}\n")
                self.flushed = True
            except FileExistsError:
                with open(self.sessionFile, "a", encoding="utf-8") as f:
                    f.write(f"{json.dumps(entry)}\n")
                self.flushed = True
        else:
            with open(self.sessionFile, "a", encoding="utf-8") as f:
                f.write(f"{json.dumps(entry)}\n")

    def _append_entry(self, entry: Dict[str, Any]) -> None:
        self.file_entries.append(entry)
        self.by_id[entry["id"]] = entry
        self.leafId = entry["id"]
        self._persist(entry)

    def append_message(self, message: Dict[str, Any]) -> str:
        entry = {
            "type": "message",
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "message": message,
        }
        self._append_entry(entry)
        return str(entry["id"])

    def append_thinking_level_change(self, thinking_level: str) -> str:
        entry = {
            "type": "thinking_level_change",
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "thinkingLevel": thinking_level,
        }
        self._append_entry(entry)
        return str(entry["id"])

    def append_model_change(self, provider: str, model_id: str) -> str:
        entry = {
            "type": "model_change",
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "provider": provider,
            "modelId": model_id,
        }
        self._append_entry(entry)
        return str(entry["id"])

    def append_compaction(
        self,
        summary: str,
        first_kept_entry_id: str,
        tokens_before: int,
        details: Optional[Any] = None,
        from_hook: Optional[bool] = None,
    ) -> str:
        entry = {
            "type": "compaction",
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "summary": summary,
            "firstKeptEntryId": first_kept_entry_id,
            "tokensBefore": tokens_before,
            "details": details,
            "fromHook": from_hook,
        }
        self._append_entry(entry)
        return str(entry["id"])

    def append_custom_entry(self, custom_type: str, data: Optional[Any] = None) -> str:
        entry = {
            "type": "custom",
            "customType": custom_type,
            "data": data,
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
        self._append_entry(entry)
        return str(entry["id"])

    def append_session_info(self, name: str) -> str:
        entry = {
            "type": "session_info",
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "name": name.strip(),
        }
        self._append_entry(entry)
        return str(entry["id"])

    def get_session_name(self) -> Optional[str]:
        entries = self.get_entries()
        for i in range(len(entries) - 1, -1, -1):
            entry = entries[i]
            if entry.get("type") == "session_info":
                return (entry.get("name") or "").strip() or None
        return None

    def append_custom_message_entry(
        self,
        custom_type: str,
        content: Union[str, List[Union[TextContent, ImageContent]]],
        display: bool,
        details: Optional[Any] = None,
    ) -> str:
        entry = {
            "type": "custom_message",
            "customType": custom_type,
            "content": content,
            "display": display,
            "details": details,
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
        self._append_entry(entry)
        return str(entry["id"])

    def get_leaf_id(self) -> Optional[str]:
        return self.leafId

    def get_leaf_entry(self) -> Optional[Dict[str, Any]]:
        return self.by_id.get(self.leafId) if self.leafId else None

    def get_entry(self, entry_id: str) -> Optional[Dict[str, Any]]:
        return self.by_id.get(entry_id)

    def get_children(self, parent_id: str) -> List[Dict[str, Any]]:
        return [entry for entry in self.by_id.values() if entry.get("parentId") == parent_id]

    def get_label(self, entry_id: str) -> Optional[str]:
        return self.labels_by_id.get(entry_id)

    def append_label_change(self, target_id: str, label: Optional[str]) -> str:
        if target_id not in self.by_id:
            raise ValueError(f"Entry {target_id} not found")
        entry: Dict[str, Any] = {
            "type": "label",
            "id": generate_id(self.by_id),
            "parentId": self.leafId,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "targetId": target_id,
            "label": label,
        }
        self._append_entry(entry)
        if label:
            self.labels_by_id[target_id] = label
            self.label_timestamps_by_id[target_id] = cast(str, entry["timestamp"])
        else:
            self.labels_by_id.pop(target_id, None)
            self.label_timestamps_by_id.pop(target_id, None)
        return str(entry["id"])

    def get_branch(self, from_id: Optional[str] = None) -> List[Dict[str, Any]]:
        path: List[Dict[str, Any]] = []
        start_id = from_id or self.leafId
        current: Optional[Dict[str, Any]] = self.by_id.get(start_id) if start_id else None
        while current:
            path.insert(0, current)
            parent_id = current.get("parentId")
            current = self.by_id.get(parent_id) if parent_id else None
        return path

    def build_session_context(self) -> Dict[str, Any]:
        return build_session_context(self.get_entries(), self.leafId, self.by_id)

    def get_header(self) -> Optional[Dict[str, Any]]:
        return next((e for e in self.file_entries if e.get("type") == "session"), None)

    def get_entries(self) -> List[Dict[str, Any]]:
        return [e for e in self.file_entries if e.get("type") != "session"]

    def get_tree(self) -> List[Dict[str, Any]]:
        entries = self.get_entries()
        node_map: Dict[str, Dict[str, Any]] = {}
        roots: List[Dict[str, Any]] = []

        for entry in entries:
            entry_id = entry["id"]
            label = self.labels_by_id.get(entry_id)
            label_timestamp = self.label_timestamps_by_id.get(entry_id)
            node_map[entry_id] = {
                "entry": entry,
                "children": [],
                "label": label,
                "labelTimestamp": label_timestamp,
            }

        for entry in entries:
            entry_id = entry["id"]
            node = node_map[entry_id]
            parent_id = entry.get("parentId")
            if parent_id is None or parent_id == entry_id:
                roots.append(node)
            else:
                parent = node_map.get(parent_id)
                if parent:
                    parent["children"].append(node)
                else:
                    roots.append(node)

        stack: List[Dict[str, Any]] = list(roots)
        while len(stack) > 0:
            node = stack.pop()
            node["children"].sort(
                key=lambda x: datetime.fromisoformat(
                    x["entry"]["timestamp"].replace("Z", "+00:00")
                ).timestamp()
            )
            stack.extend(node["children"])

        return roots

    def branch(self, branch_from_id: str) -> None:
        if branch_from_id not in self.by_id:
            raise ValueError(f"Entry {branch_from_id} not found")
        self.leafId = branch_from_id

    def reset_leaf(self) -> None:
        self.leafId = None

    def branch_with_summary(
        self,
        branch_from_id: Optional[str],
        summary: str,
        details: Optional[Any] = None,
        from_hook: Optional[bool] = None,
    ) -> str:
        if branch_from_id is not None and branch_from_id not in self.by_id:
            raise ValueError(f"Entry {branch_from_id} not found")
        self.leafId = branch_from_id
        entry = {
            "type": "branch_summary",
            "id": generate_id(self.by_id),
            "parentId": branch_from_id,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "fromId": branch_from_id or "root",
            "summary": summary,
            "details": details,
            "fromHook": from_hook,
        }
        self._append_entry(entry)
        return str(entry["id"])

    def create_branched_session(self, leaf_id: str) -> Optional[str]:
        previous_session_file = self.sessionFile
        label_entry: Dict[str, Any]
        path = self.get_branch(leaf_id)
        if len(path) == 0:
            raise ValueError(f"Entry {leaf_id} not found")

        path_without_labels = [e for e in path if e.get("type") != "label"]

        new_session_id = create_session_id()
        timestamp = datetime.utcnow().isoformat() + "Z"
        file_timestamp = timestamp.replace(":", "-").replace(".", "-")
        new_session_file = os.path.join(
            self.get_session_dir(), f"{file_timestamp}_{new_session_id}.jsonl"
        )

        header = {
            "type": "session",
            "version": CURRENT_SESSION_VERSION,
            "id": new_session_id,
            "timestamp": timestamp,
            "cwd": self.cwd,
            "parentSession": previous_session_file if self.persist else None,
        }

        path_entry_ids: set[str] = {str(e["id"]) for e in path_without_labels}
        labels_to_write = []
        for target_id, label in self.labels_by_id.items():
            if target_id in path_entry_ids:
                labels_to_write.append(
                    {
                        "targetId": target_id,
                        "label": label,
                        "timestamp": self.label_timestamps_by_id.get(target_id),
                    }
                )

        if self.persist:
            last_entry_id = path_without_labels[-1]["id"] if path_without_labels else None
            parent_id = last_entry_id
            label_entries = []
            for item in labels_to_write:
                label_entry = {
                    "type": "label",
                    "id": generate_id(path_entry_ids),
                    "parentId": parent_id,
                    "timestamp": item["timestamp"],
                    "targetId": item["targetId"],
                    "label": item["label"],
                }
                path_entry_ids.add(cast(str, label_entry["id"]))
                label_entries.append(label_entry)
                parent_id = cast(str, label_entry["id"])

            self.file_entries = [header] + path_without_labels + label_entries
            self.sessionId = new_session_id
            self.sessionFile = new_session_file
            self._build_index()

            has_assistant = any(
                e.get("type") == "message" and e.get("message", {}).get("role") == "assistant"
                for e in self.file_entries
            )
            if has_assistant:
                self._rewrite_file()
                self.flushed = True
            else:
                self.flushed = False

            return new_session_file

        label_entries = []
        last_entry_id = path_without_labels[-1]["id"] if path_without_labels else None
        parent_id = last_entry_id
        for item in labels_to_write:
            existing_ids = path_entry_ids.union({cast(str, e["id"]) for e in label_entries})
            label_entry = {
                "type": "label",
                "id": generate_id(existing_ids),
                "parentId": parent_id,
                "timestamp": item["timestamp"],
                "targetId": item["targetId"],
                "label": item["label"],
            }
            label_entries.append(label_entry)
            parent_id = cast(str, label_entry["id"])

        self.file_entries = [header] + path_without_labels + label_entries
        self.sessionId = new_session_id
        self._build_index()
        return None

    @classmethod
    def create(
        cls, cwd: str, session_dir: Optional[str] = None, options: Optional[Dict[str, Any]] = None
    ) -> "SessionManager":
        dir_path = session_dir if session_dir else get_default_session_dir(cwd)
        return cls(cwd, dir_path, None, True, options)

    @classmethod
    def open(
        cls, path: str, session_dir: Optional[str] = None, cwd_override: Optional[str] = None
    ) -> "SessionManager":
        resolved_path = resolve_path(path)
        entries = load_entries_from_file(resolved_path)
        header = next((e for e in entries if e.get("type") == "session"), None)
        cwd = cwd_override or (header.get("cwd") if header else None) or os.getcwd()
        dir_path = session_dir if session_dir else os.path.dirname(resolved_path)
        return cls(cwd, dir_path, resolved_path, True)

    @classmethod
    def continue_recent(cls, cwd: str, session_dir: Optional[str] = None) -> "SessionManager":
        dir_path = session_dir if session_dir else get_default_session_dir(cwd)
        filter_cwd = session_dir is not None and dir_path != get_default_session_dir_path(cwd)
        most_recent = find_most_recent_session(dir_path, cwd if filter_cwd else None)
        if most_recent:
            return cls(cwd, dir_path, most_recent, True)
        return cls(cwd, dir_path, None, True)

    @classmethod
    def in_memory(cls, cwd: str = os.getcwd()) -> "SessionManager":
        return cls(cwd, "", None, False)

    @classmethod
    def fork_from(
        cls,
        source_path: str,
        target_cwd: str,
        session_dir: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
    ) -> "SessionManager":
        resolved_source_path = resolve_path(source_path)
        resolved_target_cwd = resolve_path(target_cwd)
        source_entries = load_entries_from_file(resolved_source_path)
        if len(source_entries) == 0:
            raise ValueError(
                f"Cannot fork: source session file is empty or invalid: {resolved_source_path}"
            )

        source_header = next((e for e in source_entries if e.get("type") == "session"), None)
        if not source_header:
            raise ValueError(f"Cannot fork: source session has no header: {resolved_source_path}")

        dir_path = session_dir if session_dir else get_default_session_dir(resolved_target_cwd)
        if not os.path.exists(dir_path):
            os.makedirs(dir_path, exist_ok=True)

        if options and options.get("id") is not None:
            assert_valid_session_id(options["id"])
        new_session_id = (options.get("id") if options else None) or create_session_id()
        timestamp = datetime.utcnow().isoformat() + "Z"
        file_timestamp = timestamp.replace(":", "-").replace(".", "-")
        new_session_file = os.path.join(dir_path, f"{file_timestamp}_{new_session_id}.jsonl")

        new_header = {
            "type": "session",
            "version": CURRENT_SESSION_VERSION,
            "id": new_session_id,
            "timestamp": timestamp,
            "cwd": resolved_target_cwd,
            "parentSession": resolved_source_path,
        }

        try:
            fd = os.open(new_session_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(f"{json.dumps(new_header)}\n")
        except FileExistsError:
            pass

        with open(new_session_file, "a", encoding="utf-8") as f:
            for entry in source_entries:
                if entry.get("type") != "session":
                    f.write(f"{json.dumps(entry)}\n")

        return cls(resolved_target_cwd, dir_path, new_session_file, True)

    @classmethod
    async def list(
        cls,
        cwd: str,
        session_dir: Optional[str] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> List[Dict[str, Any]]:
        dir_path = session_dir if session_dir else get_default_session_dir(cwd)
        filter_cwd = session_dir is not None and dir_path != get_default_session_dir_path(cwd)
        resolved_cwd = resolve_path(cwd)

        sessions = await list_sessions_from_dir(dir_path, on_progress)
        filtered = [
            s for s in sessions if not filter_cwd or session_cwd_matches(s.get("cwd"), resolved_cwd)
        ]
        filtered.sort(key=lambda s: s["modified"], reverse=True)
        return filtered

    @classmethod
    async def list_all(
        cls,
        session_dir_or_on_progress: Optional[Union[str, Callable[[int, int], None]]] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> List[Dict[str, Any]]:
        custom_session_dir = None
        progress = None
        if isinstance(session_dir_or_on_progress, str):
            custom_session_dir = normalize_path(session_dir_or_on_progress)
            progress = on_progress
        elif callable(session_dir_or_on_progress):
            progress = session_dir_or_on_progress

        if custom_session_dir:
            sessions = await list_sessions_from_dir(custom_session_dir, progress)
            sessions.sort(key=lambda s: s["modified"], reverse=True)
            return sessions

        sessions_dir = get_sessions_dir()

        try:
            if not os.path.exists(sessions_dir):
                return []

            dirs = []
            for entry in os.scandir(sessions_dir):
                if entry.is_dir():
                    dirs.append(entry.path)

            total_files = 0
            all_files = []
            for d in dirs:
                try:
                    files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".jsonl")]
                    all_files.extend(files)
                    total_files += len(files)
                except Exception:
                    pass

            loaded = 0

            def on_loaded() -> None:
                nonlocal loaded
                loaded += 1
                if progress:
                    progress(loaded, total_files)

            sessions = []
            results = await build_session_infos_concurrently(all_files, on_loaded)
            for info in results:
                if info:
                    sessions.append(info)

            sessions.sort(key=lambda s: s["modified"], reverse=True)
            return sessions
        except Exception:
            return []
