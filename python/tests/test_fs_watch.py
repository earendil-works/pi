import time
from pi_mono.utils.fs_watch import (
    watch_with_error_handler,
    close_watcher,
)


def test_watch_with_error_handler_change(tmp_path):
    test_file = tmp_path / "watch_test.txt"
    test_file.touch()

    events = []

    def listener(event_type, filename):
        events.append((event_type, filename))

    error_triggered = False

    def on_error():
        nonlocal error_triggered
        error_triggered = True

    watcher = watch_with_error_handler(str(test_file), listener, on_error)
    assert watcher is not None
    assert not error_triggered

    # Modify the file and wait for polling loop (poll is every 500ms)
    time.sleep(0.1)
    test_file.write_text("updated content")

    # Wait for the poll loop to detect change
    for _ in range(20):
        if len(events) > 0:
            break
        time.sleep(0.1)

    assert len(events) > 0
    assert events[0][0] == "change"
    assert events[0][1] == "watch_test.txt"

    close_watcher(watcher)


def test_watch_with_error_handler_rename_delete(tmp_path):
    test_file = tmp_path / "watch_test_delete.txt"
    test_file.touch()

    events = []

    def listener(event_type, filename):
        events.append((event_type, filename))

    error_triggered = False

    def on_error():
        nonlocal error_triggered
        error_triggered = True

    watcher = watch_with_error_handler(str(test_file), listener, on_error)
    assert watcher is not None

    time.sleep(0.1)
    test_file.unlink()

    # Wait for the poll loop to detect removal
    for _ in range(20):
        if len(events) > 0:
            break
        time.sleep(0.1)

    assert len(events) > 0
    assert events[0][0] == "rename"

    close_watcher(watcher)


def test_watch_with_error_handler_error():
    error_triggered = False

    def on_error():
        nonlocal error_triggered
        error_triggered = True

    watcher = watch_with_error_handler(
        "/nonexistent/directory/file.txt",
        lambda et, fn: None,
        on_error,
    )
    assert watcher is None
    assert error_triggered
