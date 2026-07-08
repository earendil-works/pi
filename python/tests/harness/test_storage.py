import os
import json
import pytest
from pi_mono.agent.harness.session.memory_storage import InMemorySessionStorage
from pi_mono.agent.harness.session.jsonl_storage import (
    JsonlSessionStorage,
    loadJsonlSessionMetadata,
)
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.types import (
    MessageEntry,
    LabelEntry,
    JsonlSessionMetadata,
    ok,
)
from tests.harness.session_test_utils import (
    createUserMessage,
    createAssistantMessage,
    createTempDir,
    cleanupTempDirs,
)


@pytest.fixture(autouse=True)
def run_around_tests():
    yield
    cleanupTempDirs()


# =============================================================================
# InMemorySessionStorage Tests
# =============================================================================


@pytest.mark.anyio
async def test_in_memory_storage_returns_configured_metadata():
    metadata = {"id": "session-1", "createdAt": "2026-01-01T00:00:00.000Z"}
    storage = InMemorySessionStorage({"metadata": metadata})
    assert await storage.get_metadata() == metadata


@pytest.mark.anyio
async def test_in_memory_storage_copies_initial_entries_and_persists_leaf_changes():
    entry = MessageEntry(
        type="message",
        id="entry-1",
        parent_id=None,
        timestamp="2026-01-01T00:00:00.000Z",
        message=createUserMessage("one"),
    )
    initial_entries = [entry]
    storage = InMemorySessionStorage({"entries": initial_entries})

    # Modifying the original list shouldn't affect the storage copy
    initial_entries.append(
        MessageEntry(
            type="message",
            id="entry-2",
            parent_id="entry-1",
            timestamp="2026-01-01T00:00:01.000Z",
            message=createUserMessage("two"),
        )
    )

    entries = await storage.get_entries()
    assert [e.id for e in entries] == ["entry-1"]
    assert await storage.get_leaf_id() == "entry-1"

    await storage.set_leaf_id(None)
    assert await storage.get_leaf_id() is None
    entries = await storage.get_entries()
    assert len(entries) == 2
    assert entries[-1].type == "leaf"
    assert entries[-1].target_id is None


@pytest.mark.anyio
async def test_in_memory_storage_rejects_invalid_leaf_ids():
    storage = InMemorySessionStorage()
    with pytest.raises(Exception, match="Entry missing not found"):
        await storage.set_leaf_id("missing")


@pytest.mark.anyio
async def test_in_memory_storage_finds_entries_by_type():
    entry = MessageEntry(
        type="message",
        id="entry-1",
        parent_id=None,
        timestamp="2026-01-01T00:00:00.000Z",
        message=createUserMessage("one"),
    )
    storage = InMemorySessionStorage({"entries": [entry]})
    found = await storage.find_entries("message")
    assert [f.id for f in found] == ["entry-1"]
    assert await storage.find_entries("session_info") == []


@pytest.mark.anyio
async def test_in_memory_storage_maintains_label_lookup():
    entry = MessageEntry(
        type="message",
        id="entry-1",
        parent_id=None,
        timestamp="2026-01-01T00:00:00.000Z",
        message=createUserMessage("one"),
    )
    storage = InMemorySessionStorage({"entries": [entry]})
    assert await storage.get_label("entry-1") is None

    await storage.append_entry(
        LabelEntry(
            type="label",
            id="label-1",
            parent_id="entry-1",
            timestamp="2026-01-01T00:00:01.000Z",
            target_id="entry-1",
            label="checkpoint",
        )
    )
    assert await storage.get_label("entry-1") == "checkpoint"

    await storage.append_entry(
        LabelEntry(
            type="label",
            id="label-2",
            parent_id="label-1",
            timestamp="2026-01-01T00:00:02.000Z",
            target_id="entry-1",
            label=None,
        )
    )
    assert await storage.get_label("entry-1") is None


@pytest.mark.anyio
async def test_in_memory_storage_walks_paths_to_root():
    root = MessageEntry(
        type="message",
        id="root",
        parent_id=None,
        timestamp="2026-01-01T00:00:00.000Z",
        message=createUserMessage("root"),
    )
    child = MessageEntry(
        type="message",
        id="child",
        parent_id="root",
        timestamp="2026-01-01T00:00:01.000Z",
        message=createAssistantMessage("child"),
    )
    storage = InMemorySessionStorage({"entries": [root, child]})
    path = await storage.get_path_to_root("child")
    assert [e.id for e in path] == ["root", "child"]
    assert await storage.get_path_to_root(None) == []


# =============================================================================
# JsonlSessionStorage Tests
# =============================================================================


@pytest.mark.anyio
async def test_jsonl_storage_throws_for_missing_files_when_opening():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    with pytest.raises(Exception) as excinfo:
        await JsonlSessionStorage.open(env, file_path)
    assert excinfo.value.code == "not_found"


@pytest.mark.anyio
async def test_jsonl_storage_writes_header_on_create():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    storage = await JsonlSessionStorage.create(
        env, file_path, {"cwd": dir_path, "sessionId": "session-1"}
    )

    assert os.path.exists(file_path)
    with open(file_path, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    assert len(lines) == 1
    assert await storage.get_leaf_id() is None
    assert await storage.get_entries() == []

    await storage.append_entry(
        MessageEntry(
            type="message",
            id="user-1",
            parent_id=None,
            timestamp="2026-01-01T00:00:00.000Z",
            message=createUserMessage("one"),
        )
    )

    with open(file_path, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    assert len(lines) == 2
    assert json.loads(lines[0])["type"] == "session"
    assert json.loads(lines[1])["id"] == "user-1"


@pytest.mark.anyio
async def test_jsonl_storage_throws_for_malformed_session_headers():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    with open(file_path, "w", encoding="utf-8") as f:
        f.write("not json\n")
    with pytest.raises(Exception, match="first line is not a valid session header"):
        await JsonlSessionStorage.open(env, file_path)


@pytest.mark.anyio
async def test_jsonl_storage_throws_for_malformed_entry_lines():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    header = {
        "type": "session",
        "version": 3,
        "id": "session-1",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": dir_path,
    }
    entry = {
        "type": "message",
        "id": "entry-1",
        "parentId": None,
        "timestamp": "2026-01-01T00:00:00.000Z",
        "message": createUserMessage("one"),
    }
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(header) + "\nnot json\n" + json.dumps(entry) + "\n")
    with pytest.raises(Exception) as excinfo:
        await JsonlSessionStorage.open(env, file_path)
    assert excinfo.value.code == "invalid_entry"


@pytest.mark.anyio
async def test_jsonl_storage_creates_and_reads_session_metadata_from_header():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    storage = await JsonlSessionStorage.create(
        env,
        file_path,
        {
            "cwd": dir_path,
            "sessionId": "session-1",
            "parentSessionPath": "/tmp/parent.jsonl",
        },
    )
    metadata = await storage.get_metadata()
    assert metadata.id == "session-1"
    assert metadata.cwd == dir_path
    assert metadata.path == file_path
    assert metadata.parent_session_path == "/tmp/parent.jsonl"

    await storage.append_entry(
        MessageEntry(
            type="message",
            id="user-1",
            parent_id=None,
            timestamp="2026-01-01T00:00:00.000Z",
            message=createUserMessage("one"),
        )
    )

    loaded_metadata = await loadJsonlSessionMetadata(env, file_path)
    assert loaded_metadata == metadata


@pytest.mark.anyio
async def test_jsonl_storage_loads_existing_entries_and_reconstructs_leaf():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    storage = await JsonlSessionStorage.create(
        env, file_path, {"cwd": dir_path, "sessionId": "session-1"}
    )
    root = MessageEntry(
        type="message",
        id="root",
        parent_id=None,
        timestamp="2026-01-01T00:00:00.000Z",
        message=createUserMessage("root"),
    )
    child = MessageEntry(
        type="message",
        id="child",
        parent_id="root",
        timestamp="2026-01-01T00:00:01.000Z",
        message=createAssistantMessage("child"),
    )
    await storage.append_entry(root)
    await storage.append_entry(child)

    loaded = await JsonlSessionStorage.open(env, file_path)
    assert await loaded.get_leaf_id() == "child"
    assert [e.id for e in await loaded.get_entries()] == ["root", "child"]

    await loaded.set_leaf_id("root")
    reloaded = await JsonlSessionStorage.open(env, file_path)
    assert await reloaded.get_leaf_id() == "root"
    entries = await reloaded.get_entries()
    assert entries[-1].type == "leaf"
    assert entries[-1].target_id == "root"
    assert [e.id for e in await loaded.get_path_to_root("child")] == ["root", "child"]


@pytest.mark.anyio
async def test_jsonl_storage_finds_entries_by_type():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    storage = await JsonlSessionStorage.create(
        env, file_path, {"cwd": dir_path, "sessionId": "session-1"}
    )
    await storage.append_entry(
        MessageEntry(
            type="message",
            id="entry-1",
            parent_id=None,
            timestamp="2026-01-01T00:00:00.000Z",
            message=createUserMessage("one"),
        )
    )
    found = await storage.find_entries("message")
    assert [f.id for f in found] == ["entry-1"]
    assert await storage.find_entries("session_info") == []


@pytest.mark.anyio
async def test_jsonl_storage_maintains_label_lookup():
    dir_path = createTempDir()
    env = LocalExecutionEnv(cwd=dir_path)
    file_path = os.path.join(dir_path, "session.jsonl")
    storage = await JsonlSessionStorage.create(
        env, file_path, {"cwd": dir_path, "sessionId": "session-1"}
    )
    await storage.append_entry(
        MessageEntry(
            type="message",
            id="entry-1",
            parent_id=None,
            timestamp="2026-01-01T00:00:00.000Z",
            message=createUserMessage("one"),
        )
    )
    assert await storage.get_label("entry-1") is None

    await storage.append_entry(
        LabelEntry(
            type="label",
            id="label-1",
            parent_id="entry-1",
            timestamp="2026-01-01T00:00:01.000Z",
            target_id="entry-1",
            label="checkpoint",
        )
    )
    assert await storage.get_label("entry-1") == "checkpoint"

    await storage.append_entry(
        LabelEntry(
            type="label",
            id="label-2",
            parent_id="label-1",
            timestamp="2026-01-01T00:00:02.000Z",
            target_id="entry-1",
            label=None,
        )
    )
    assert await storage.get_label("entry-1") is None

    loaded = await JsonlSessionStorage.open(env, file_path)
    assert await loaded.get_label("entry-1") is None


@pytest.mark.anyio
async def test_jsonl_storage_reads_session_metadata_through_line_reading_fs():
    dir_path = createTempDir()
    file_path = os.path.join(dir_path, "session.jsonl")
    header = {
        "type": "session",
        "version": 3,
        "id": "session-1",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": dir_path,
    }

    class MockFs:
        async def read_text_lines(self, path, options=None):
            return ok([json.dumps(header)])

        async def read_text_file(self, path):
            raise Exception("read_text_file should not be called")

    metadata = await loadJsonlSessionMetadata(MockFs(), file_path)
    assert metadata == JsonlSessionMetadata(
        id="session-1",
        created_at="2026-01-01T00:00:00.000Z",
        cwd=dir_path,
        path=file_path,
        parent_session_path=None,
    )
