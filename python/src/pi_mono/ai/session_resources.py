from typing import Callable, Set

SessionResourceCleanup = Callable[[str | None], None]

_session_resource_cleanups: Set[SessionResourceCleanup] = set()


def register_session_resource_cleanup(cleanup: SessionResourceCleanup) -> Callable[[], None]:
    """Register a callback for session resource cleanup.

    Returns a function that unregisters the callback.
    """
    _session_resource_cleanups.add(cleanup)

    def unregister() -> None:
        _session_resource_cleanups.discard(cleanup)

    return unregister


def cleanup_session_resources(session_id: str | None = None) -> None:
    """Run all registered session resource cleanup callbacks."""
    errors: list[Exception] = []
    for cleanup in list(_session_resource_cleanups):
        try:
            cleanup(session_id)
        except Exception as e:
            errors.append(e)

    if errors:
        raise ExceptionGroup("Failed to cleanup session resources", errors)
