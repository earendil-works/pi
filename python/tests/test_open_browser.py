import sys
import subprocess
from pi_mono.utils.open_browser import open_browser


class MockPopen:
    def __init__(self, args, **kwargs):
        self.args = args
        self.kwargs = kwargs


def test_open_browser(monkeypatch):
    called_args = []

    def mock_popen(args, **kwargs):
        called_args.append(args)
        return MockPopen(args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", mock_popen)

    # Test on current platform
    open_browser("http://example.com")
    assert len(called_args) == 1

    # Force platform behavior
    monkeypatch.setattr(sys, "platform", "darwin")
    called_args.clear()
    open_browser("http://example.com")
    assert called_args[0] == ["open", "http://example.com"]

    monkeypatch.setattr(sys, "platform", "win32")
    called_args.clear()
    open_browser("http://example.com")
    assert called_args[0] == [
        "rundll32",
        "url.dll,FileProtocolHandler",
        "http://example.com",
    ]

    monkeypatch.setattr(sys, "platform", "linux")
    called_args.clear()
    open_browser("http://example.com")
    assert called_args[0] == ["xdg-open", "http://example.com"]


def test_open_browser_exception(monkeypatch):
    def mock_popen_fail(args, **kwargs):
        raise RuntimeError("failed to spawn")

    monkeypatch.setattr(subprocess, "Popen", mock_popen_fail)

    # Should handle Popen exception without crashing
    open_browser("http://example.com")
