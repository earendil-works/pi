"""P3 feature parity tests."""

from __future__ import annotations

import os
from unittest.mock import MagicMock


from pi_mono.coding_agent.core.package_manager import get_extension_temp_folder, parse_source
from pi_mono.coding_agent.modes.interactive.interactive_mode import InteractiveMode
from pi_mono.coding_agent.modes.interactive.model_search import (
    get_model_search_text,
    get_model_selector_search_text,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import (
    reload_theme_from_path,
    start_theme_watcher,
    stop_theme_watcher,
)
from pi_mono.coding_agent.utils.clipboard_image import (
    ClipboardImage,
    is_wayland_session,
    read_clipboard_image,
)
from pi_mono.utils.semver import (
    get_npm_version_range,
    is_exact_npm_version,
    max_satisfying,
    satisfies,
)
from pi_mono.utils.windows_self_update import cleanup_windows_self_update_quarantine


class _ModelItem:
    def __init__(self, model_id: str, provider: str, name: str | None = None) -> None:
        self.id = model_id
        self.provider = provider
        self.name = name


def test_model_selector_search_text_omits_leading_model_id() -> None:
    item = _ModelItem("gpt-5", "openrouter")
    search_text = get_model_selector_search_text(item)
    assert not search_text.startswith("gpt-5 ")
    assert "openrouter/openrouter/gpt-5" not in search_text
    assert search_text.startswith("openrouter")


def test_model_search_text_includes_model_id_first() -> None:
    item = _ModelItem("gpt-5", "openai", "GPT-5")
    assert get_model_search_text(item).startswith("gpt-5 openai")


def test_semver_range_resolution() -> None:
    versions = ["1.0.0", "1.1.0", "2.0.0"]
    assert max_satisfying(versions, "^1.0.0") == "1.1.0"
    assert satisfies("1.0.5", "~1.0.0")
    assert not satisfies("2.0.0", "^1.0.0")
    assert get_npm_version_range("1.2.3") is None
    assert get_npm_version_range("^1.2.3") == "^1.2.3"
    assert is_exact_npm_version("1.2.3")


def test_parse_source_npm_records_range() -> None:
    parsed = parse_source("npm:lodash@^4.17.0")
    assert parsed.range == "^4.17.0"
    assert parsed.pinned is False


def test_get_extension_temp_folder_creates_private_dir(tmp_path) -> None:
    folder = get_extension_temp_folder(str(tmp_path))
    assert os.path.isdir(folder)
    assert oct(os.stat(folder).st_mode & 0o777) == oct(0o700)


def test_wayland_session_detection() -> None:
    assert is_wayland_session({"WAYLAND_DISPLAY": "wayland-0"})
    assert is_wayland_session({"XDG_SESSION_TYPE": "wayland"})


def test_read_clipboard_image_wayland(monkeypatch) -> None:
    def fake_run(command, **kwargs):
        result = MagicMock()
        result.returncode = 0
        if command[:2] == ["wl-paste", "--list-types"]:
            result.stdout = b"text/plain\nimage/png\n"
        elif command[:3] == ["wl-paste", "--type", "image/png"]:
            result.stdout = b"\x89PNG"
        else:
            result.stdout = b""
        return result

    monkeypatch.setattr("pi_mono.coding_agent.utils.clipboard_image.subprocess.run", fake_run)
    image = read_clipboard_image(env={"WAYLAND_DISPLAY": "1"}, platform="linux")
    assert isinstance(image, ClipboardImage)
    assert image.mime_type == "image/png"


def test_theme_watcher_reloads_on_change(tmp_path) -> None:
    theme_path = tmp_path / "custom.json"
    theme_path.write_text(
        '{"name":"custom","colors":{"accent":"#ff0000","border":"","borderAccent":"","borderMuted":"","success":"","error":"","warning":"","muted":"","dim":"","text":"","thinkingText":""}}',
        encoding="utf-8",
    )
    reloaded: list[str] = []

    def on_change() -> None:
        reload_theme_from_path(str(theme_path))
        reloaded.append("ok")

    start_theme_watcher(str(theme_path), on_change)
    theme_path.write_text(
        '{"name":"custom","colors":{"accent":"#00ff00","border":"","borderAccent":"","borderMuted":"","success":"","error":"","warning":"","muted":"","dim":"","text":"","thinkingText":""}}',
        encoding="utf-8",
    )
    import time

    time.sleep(0.7)
    stop_theme_watcher()
    assert reloaded


def test_windows_quarantine_cleanup_noop_on_unix() -> None:
    cleanup_windows_self_update_quarantine("/tmp/fake-package")


def test_interactive_toggle_thinking_rebuilds_chat() -> None:
    mode = InteractiveMode.__new__(InteractiveMode)
    mode._hide_thinking_block = False
    mode._session = MagicMock()
    mode._session.settings_manager = MagicMock()
    mode._chat_container = MagicMock()
    mode._chat_container.children = []
    mode._streaming_component = None
    mode._expandable_components = []
    mode._startup_notices_shown = True
    mode._ui = MagicMock()
    mode._footer = MagicMock()
    mode._session.session_manager.build_session_context.return_value = {"messages": []}
    mode._render_session_context = MagicMock()
    mode._show_startup_notices_if_needed = MagicMock()
    mode._show_status = MagicMock()

    mode._toggle_thinking_block_visibility()
    assert mode._hide_thinking_block is True
    mode._session.settings_manager.set_hide_thinking_block.assert_called_once_with(True)
    mode._render_session_context.assert_called()
