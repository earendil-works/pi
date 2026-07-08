import sys
import subprocess


def open_browser(target: str) -> None:
    """Open a URL or file in the platform browser/default handler without invoking a shell."""
    if sys.platform == "darwin":
        cmd, args = "open", [target]
    elif sys.platform == "win32":
        cmd, args = "rundll32", ["url.dll,FileProtocolHandler", target]
    else:
        cmd, args = "xdg-open", [target]

    try:
        subprocess.Popen(
            [cmd] + args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )
    except Exception:
        pass
