import pytest
from pi_mono.ai.session_resources import (
    register_session_resource_cleanup,
    cleanup_session_resources,
    _session_resource_cleanups,
)


@pytest.fixture(autouse=True)
def clear_cleanups():
    _session_resource_cleanups.clear()
    yield
    _session_resource_cleanups.clear()


def test_register_and_unregister():
    called_with = []

    def cleanup(session_id: str | None) -> None:
        called_with.append(session_id)

    unregister = register_session_resource_cleanup(cleanup)
    assert len(_session_resource_cleanups) == 1

    cleanup_session_resources("session-123")
    assert called_with == ["session-123"]

    unregister()
    assert len(_session_resource_cleanups) == 0

    called_with.clear()
    cleanup_session_resources("session-123")
    assert called_with == []


def test_multiple_cleanups_and_exception_handling():
    called = []

    def cleanup_ok(session_id: str | None) -> None:
        called.append(session_id)

    def cleanup_fail(session_id: str | None) -> None:
        raise ValueError("cleanup error")

    register_session_resource_cleanup(cleanup_ok)
    register_session_resource_cleanup(cleanup_fail)

    with pytest.raises(ExceptionGroup) as excinfo:
        cleanup_session_resources("session-456")

    assert "Failed to cleanup session resources" in str(excinfo.value)
    assert len(excinfo.value.exceptions) == 1
    assert isinstance(excinfo.value.exceptions[0], ValueError)
    assert called == ["session-456"]
