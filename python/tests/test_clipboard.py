import pytest

from pi_mono.utils import clipboard


def test_read_clipboard_text_uses_platform_command(monkeypatch):
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)

        class Result:
            stdout = "clipboard-text"

        return Result()

    monkeypatch.setattr(clipboard.subprocess, "run", fake_run)
    monkeypatch.setattr(clipboard.platform, "system", lambda: "Darwin")

    assert clipboard.read_clipboard_text() == "clipboard-text"
    assert calls == [["pbpaste"]]


def test_read_clipboard_text_xclip_fallback(monkeypatch):
    calls: list[list[str]] = []

    def fake_which(command: str) -> str | None:
        return "/usr/bin/xclip" if command == "xclip" else None

    def fake_run(command, **_kwargs):
        calls.append(command)

        class Result:
            stdout = "xclip-text"

        return Result()

    monkeypatch.setattr(clipboard.shutil, "which", fake_which)
    monkeypatch.setattr(clipboard.subprocess, "run", fake_run)
    monkeypatch.setattr(clipboard.platform, "system", lambda: "Linux")

    assert clipboard.read_clipboard_text() == "xclip-text"
    assert calls[0][:2] == ["xclip", "-selection"]


@pytest.mark.skipif(
    not __import__("shutil").which("pbpaste") and not __import__("shutil").which("xclip"),
    reason="No system clipboard tool available",
)
def test_read_clipboard_text_integration():
    text = clipboard.read_clipboard_text()
    assert isinstance(text, str)
