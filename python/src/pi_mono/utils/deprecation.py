import sys

emitted_deprecation_warnings: set[str] = set()


def warn_deprecation(message: str) -> None:
    """Emit a deprecation warning in yellow to stderr once per unique message."""
    if message in emitted_deprecation_warnings:
        return
    emitted_deprecation_warnings.add(message)
    sys.stderr.write(f"\033[33mDeprecation warning: {message}\033[0m\n")
    sys.stderr.flush()


def clear_deprecation_warnings_for_tests() -> None:
    """Clear deprecation warning state. Exported for tests."""
    emitted_deprecation_warnings.clear()
