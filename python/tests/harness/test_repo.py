import pytest
from pi_mono.agent.harness.session.memory_repo import InMemorySessionRepo
from pi_mono.agent.harness.session.jsonl_repo import JsonlSessionRepo
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.types import JsonlSessionMetadata
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
# InMemorySessionRepo Tests
# =============================================================================


@pytest.mark.anyio
async def test_in_memory_repo_opens_deletes_and_forks_by_metadata():
    repo = InMemorySessionRepo()
    session = await repo.create({"id": "session-1", "cwd": "/tmp"})
    metadata = await session.get_metadata()
    user1 = await session.append_message(createUserMessage("one"))
    assistant1 = await session.append_message(createAssistantMessage("two"))
    user2 = await session.append_message(createUserMessage("three"))

    assert await repo.open(metadata) == session

    listed = await repo.list()
    assert [info.id for info in listed] == ["session-1"]

    fork = await repo.fork(metadata, {"entryId": user2, "id": "session-2", "cwd": "/tmp"})
    assert [e.id for e in await fork.get_entries()] == [user1, assistant1]

    full_fork = await repo.fork(metadata, {"id": "session-3", "cwd": "/tmp"})
    assert [e.id for e in await full_fork.get_entries()] == [user1, assistant1, user2]

    await repo.delete(metadata)
    with pytest.raises(Exception, match="Session not found: session-1"):
        await repo.open(metadata)


# =============================================================================
# JsonlSessionRepo Tests
# =============================================================================


@pytest.mark.anyio
async def test_jsonl_repo_stores_sessions_below_encoded_cwd_directories_and_lists_by_cwd():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    cwd = "/tmp/my-project"
    other_cwd = "/tmp/other-project"
    repo = JsonlSessionRepo(fs=env, sessions_root=root)

    options1 = JsonlSessionMetadata(
        id="019de8c2-de29-73e9-ae0c-e134db34c447", created_at="", cwd=cwd, path=""
    )
    session = await repo.create(options1)

    options2 = JsonlSessionMetadata(id="other-session", created_at="", cwd=other_cwd, path="")
    other_session = await repo.create(options2)

    metadata = await session.get_metadata()
    other_metadata = await other_session.get_metadata()

    assert "--tmp-my-project--" in metadata.path
    assert "--tmp-other-project--" in other_metadata.path

    exists_res = await env.exists(metadata.path)
    assert exists_res.ok and exists_res.value is True

    listed_cwd = await repo.list({"cwd": cwd})
    assert [m.id for m in listed_cwd] == [metadata.id]

    listed_all = await repo.list()
    assert sorted([m.id for m in listed_all]) == sorted([metadata.id, other_metadata.id])


@pytest.mark.anyio
async def test_jsonl_repo_opens_deletes_and_forks_by_metadata():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    repo = JsonlSessionRepo(fs=env, sessions_root=root)

    options = JsonlSessionMetadata(id="source-session", created_at="", cwd="/tmp/source", path="")
    source = await repo.create(options)
    source_metadata = await source.get_metadata()

    user1 = await source.append_message(createUserMessage("one"))
    assistant1 = await source.append_message(createAssistantMessage("two"))
    user2 = await source.append_message(createUserMessage("three"))

    opened = await repo.open(source_metadata)
    assert (await opened.get_metadata()) == source_metadata

    fork = await repo.fork(
        source_metadata, {"cwd": "/tmp/target", "id": "fork-session", "entryId": user2}
    )
    fork_metadata = await fork.get_metadata()
    assert fork_metadata.cwd == "/tmp/target"
    assert fork_metadata.parent_session_path == source_metadata.path
    assert [e.id for e in await fork.get_entries()] == [user1, assistant1]

    full_fork = await repo.fork(source_metadata, {"cwd": "/tmp/target", "id": "full-fork-session"})
    assert [e.id for e in await full_fork.get_entries()] == [user1, assistant1, user2]

    await repo.delete(source_metadata)
    exists_res = await env.exists(source_metadata.path)
    assert exists_res.ok and exists_res.value is False

    with pytest.raises(Exception, match="Session not found"):
        await repo.open(source_metadata)
