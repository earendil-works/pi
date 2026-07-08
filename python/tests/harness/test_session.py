import os
import json
import pytest
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.session.jsonl_storage import JsonlSessionStorage
from pi_mono.agent.harness.session.memory_storage import InMemorySessionStorage
from pi_mono.agent.harness.session.session import Session
from tests.harness.session_test_utils import (
    createUserMessage,
    createAssistantMessage,
    createTempDir,
    cleanupTempDirs,
    getLatestTempDir,
)


@pytest.fixture(autouse=True)
def run_around_tests():
    yield
    cleanupTempDirs()


async def run_session_tests(create_storage, inspect=None):
    # 1. appends messages and builds context in order
    session = Session(await create_storage())
    await session.append_message(createUserMessage("one"))
    await session.append_message(createAssistantMessage("two"))
    context = await session.build_context()
    assert [m["role"] for m in context.messages] == ["user", "assistant"]

    # 2. tracks model and thinking level changes
    session = Session(await create_storage())
    await session.append_message(createUserMessage("one"))
    await session.append_model_change("openai", "gpt-4.1")
    await session.append_thinking_level_change("high")
    context = await session.build_context()
    assert context.thinking_level == "high"
    assert context.model == {"provider": "openai", "modelId": "gpt-4.1"}

    # 3. supports branching by moving the leaf and appending a new branch
    session = Session(await create_storage())
    user1 = await session.append_message(createUserMessage("one"))
    assistant1 = await session.append_message(createAssistantMessage("two"))
    await session.append_message(createUserMessage("three"))
    await session.move_to(user1)
    await session.append_message(createAssistantMessage("branched"))
    branch = await session.get_branch()
    assert user1 in [e.id for e in branch]
    assert assistant1 not in [e.id for e in branch]
    context = await session.build_context()
    assert [m["role"] for m in context.messages] == ["user", "assistant"]

    # 4. supports moving the leaf to root
    session = Session(await create_storage())
    await session.append_message(createUserMessage("one"))
    await session.move_to(None)
    assert await session.get_leaf_id() is None
    assert (await session.build_context()).messages == []

    # 5. reconstructs compaction summaries in context
    session = Session(await create_storage())
    await session.append_message(createUserMessage("one"))
    await session.append_message(createAssistantMessage("two"))
    user2 = await session.append_message(createUserMessage("three"))
    await session.append_message(createAssistantMessage("four"))
    await session.append_compaction("summary", user2, 1234)
    await session.append_message(createUserMessage("five"))
    context = await session.build_context()
    assert context.messages[0]["role"] == "compactionSummary"
    assert len(context.messages) == 4

    # 6. supports moving with branch summary entries in context
    session = Session(await create_storage())
    user1 = await session.append_message(createUserMessage("one"))
    summary_id = await session.move_to(user1, {"summary": "summary text"})
    assert summary_id is not None
    summary_entry = await session.get_entry(summary_id)
    assert getattr(summary_entry, "type") == "branch_summary"
    assert getattr(summary_entry, "parent_id") == user1
    assert getattr(summary_entry, "from_id") == user1
    context = await session.build_context()
    assert context.messages[1]["role"] == "branchSummary"

    # 7. supports custom message entries in context
    session = Session(await create_storage())
    await session.append_message(createUserMessage("one"))
    await session.append_custom_message_entry("custom", "hello", True, {"ok": True})
    context = await session.build_context()
    assert context.messages[1]["role"] == "custom"

    # 8. supports labels and session info entries without affecting context
    session = Session(await create_storage())
    user1 = await session.append_message(createUserMessage("one"))
    await session.append_label(user1, "checkpoint")
    await session.append_session_name("name")
    entries = await session.get_entries()
    assert any(getattr(e, "type") == "label" for e in entries)
    assert any(getattr(e, "type") == "session_info" for e in entries)
    assert await session.get_label(user1) == "checkpoint"
    assert await session.get_session_name() == "name"
    assert len((await session.build_context()).messages) == 1

    # 9. rejects labels for missing entries
    session = Session(await create_storage())
    with pytest.raises(Exception, match="Entry missing not found"):
        await session.append_label("missing", "checkpoint")

    # 10. persists leaf changes and appended entries via storage
    storage = await create_storage()
    session = Session(storage)
    user1 = await session.append_message(createUserMessage("one"))
    await session.append_message(createAssistantMessage("two"))
    await session.append_label(user1, "checkpoint")
    await session.append_session_name("name")
    await session.move_to(user1)
    await session.append_message(createAssistantMessage("branched"))
    session2 = Session(storage)
    context = await session2.build_context()
    assert [m["role"] for m in context.messages] == ["user", "assistant"]
    assert await session2.get_label(user1) == "checkpoint"
    assert await session2.get_session_name() == "name"
    if inspect:
        inspect()


@pytest.mark.anyio
async def test_session_with_in_memory_storage():
    async def create_storage():
        return InMemorySessionStorage()

    await run_session_tests(create_storage)


@pytest.mark.anyio
async def test_session_with_jsonl_storage():
    async def create_storage():
        dir_path = createTempDir()
        env = LocalExecutionEnv(cwd=dir_path)
        return await JsonlSessionStorage.create(
            env,
            os.path.join(dir_path, "session.jsonl"),
            {"cwd": dir_path, "sessionId": "session-1"},
        )

    def inspect():
        dir_path = getLatestTempDir()
        file_path = os.path.join(dir_path, "session.jsonl")
        with open(file_path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
        assert len(lines) > 1
        header = json.loads(lines[0])
        assert header["type"] == "session"
        assert header["version"] == 3
        entries = [json.loads(line) for line in lines[1:]]
        assert any(entry["type"] == "leaf" for entry in entries)
        for entry in entries:
            assert entry["type"] != "entry"
            assert isinstance(entry["id"], str)

    await run_session_tests(create_storage, inspect)
