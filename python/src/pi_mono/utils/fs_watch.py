import os
import threading
import time
from typing import Callable

FS_WATCH_RETRY_DELAY_MS = 5000


class FSWatcher:
    def __init__(
        self,
        path: str,
        listener: Callable[[str, str], None],
        on_error: Callable[[], None],
    ):
        self.path = path
        self.listener = listener
        self.on_error = on_error
        self.stopped = threading.Event()

        # Check initial state
        try:
            if not os.path.exists(path):
                raise FileNotFoundError(f"No such file or directory: {path}")
            self.last_exists = True
            self.last_mtime: float | None = os.path.getmtime(path)
        except Exception:
            # If checking initial state fails, trigger error immediately and raise
            on_error()
            raise

        self.thread = threading.Thread(target=self._watch_loop, daemon=True)
        self.thread.start()

    def _watch_loop(self) -> None:
        while not self.stopped.is_set():
            time.sleep(0.5)  # Poll every 500ms
            if self.stopped.is_set():
                break

            try:
                exists = os.path.exists(self.path)
                if exists != self.last_exists:
                    self.last_exists = exists
                    self.last_mtime = os.path.getmtime(self.path) if exists else None
                    self.listener("rename", os.path.basename(self.path))
                elif exists:
                    mtime = os.path.getmtime(self.path)
                    if mtime != self.last_mtime:
                        self.last_mtime = mtime
                        self.listener("change", os.path.basename(self.path))
            except Exception:
                self.on_error()
                break

    def close(self) -> None:
        self.stopped.set()


def watch_with_error_handler(
    path: str,
    listener: Callable[[str, str], None],
    on_error: Callable[[], None],
) -> FSWatcher | None:
    """Watch a path for changes with an error callback if watching fails."""
    try:
        return FSWatcher(path, listener, on_error)
    except Exception:
        on_error()
        return None


def close_watcher(watcher: FSWatcher | None) -> None:
    """Close a watcher safely, ignoring errors."""
    if not watcher:
        return

    try:
        watcher.close()
    except Exception:
        pass
