import sys
import platform


def get_pi_user_agent(version: str) -> str:
    """Generate a custom User-Agent string for HTTP requests."""
    runtime = f"python/{platform.python_version()}"

    arch = platform.machine().lower()
    if arch == "x86_64":
        arch = "x64"
    elif arch == "aarch64":
        arch = "arm64"

    return f"pi/{version} ({sys.platform}; {runtime}; {arch})"
