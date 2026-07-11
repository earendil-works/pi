"""Tests for remaining pending ports."""

from __future__ import annotations

import asyncio
import base64
import io
import time
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from pi_mono.ai.utils.oauth.device_code import poll_oauth_device_code_flow
from pi_mono.coding_agent.core.model_resolver import find_initial_model
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.tui.components.editor import Editor
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.utils.image_process import process_image
from pi_mono.utils.mime import detect_supported_image_mime_type


def test_ctrl_j_is_newline_keybinding() -> None:
    keys = get_keybindings().get_keys("tui.input.newLine")
    assert "ctrl+j" in keys
    assert "shift+enter" in keys


def test_detect_bmp_mime_type() -> None:
    # Minimal valid-looking BMP header (BITMAPINFOHEADER / 24bpp)
    header = bytearray(54)
    header[0:2] = b"BM"
    # file size (must be > pixel data offset)
    header[2:6] = (100).to_bytes(4, "little")
    # pixel data offset
    header[10:14] = (54).to_bytes(4, "little")
    # DIB header size
    header[14:18] = (40).to_bytes(4, "little")
    # planes
    header[26:28] = (1).to_bytes(2, "little")
    # bpp
    header[28:30] = (24).to_bytes(2, "little")
    assert detect_supported_image_mime_type(bytes(header)) == "image/bmp"


def test_process_image_converts_bmp_to_png() -> None:
    image = Image.new("RGB", (8, 8), color=(255, 0, 0))
    buffer = io.BytesIO()
    image.save(buffer, format="BMP")
    raw = buffer.getvalue()
    assert detect_supported_image_mime_type(raw) == "image/bmp"
    result = process_image(raw, "image/bmp", options=None)
    assert result.ok
    assert result.mime_type == "image/png"
    assert result.hints and "image/bmp" in result.hints[0]
    # Round-trip decode
    Image.open(io.BytesIO(base64.b64decode(result.data))).verify()


@pytest.mark.anyio
async def test_device_code_wait_before_first_poll_and_server_interval() -> None:
    poll_times: list[float] = []
    start = time.monotonic()

    async def poll() -> dict[str, Any]:
        poll_times.append(time.monotonic() - start)
        if len(poll_times) == 1:
            return {"status": "slow_down", "intervalSeconds": 1}
        return {"status": "complete", "value": "token"}

    class Options:
        intervalSeconds = 1
        expiresInSeconds = 30
        waitBeforeFirstPoll = True
        signal = None

    options = Options()
    options.poll = poll  # type: ignore[attr-defined]
    result = await poll_oauth_device_code_flow(options)
    assert result == "token"
    assert len(poll_times) == 2
    # First poll should wait ~1s before starting
    assert poll_times[0] >= 0.8


def test_auth_storage_throws_when_load_failed(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text("{}", encoding="utf-8")
    storage = AuthStorage.create(str(auth_path))
    auth_path.write_text("{not-json", encoding="utf-8")
    storage.reload()
    assert storage.load_error is not None
    with pytest.raises(RuntimeError, match="could not be loaded"):
        storage.set("openai", {"type": "api_key", "key": "sk-test"})
    assert auth_path.read_text(encoding="utf-8") == "{not-json"


def test_auth_storage_set_updates_only_after_persist() -> None:
    storage = AuthStorage.in_memory({})
    storage.set("openai", {"type": "api_key", "key": "sk-test"})
    assert storage.get("openai") == {"type": "api_key", "key": "sk-test"}


def test_find_initial_model_skips_unauthenticated_default(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = AuthStorage.in_memory({})
    registry = ModelRegistry.in_memory(auth)
    model = {
        "id": "ghost",
        "name": "ghost",
        "api": "openai-completions",
        "provider": "ghost-provider",
        "baseUrl": "https://example.invalid",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 8192,
        "maxTokens": 2048,
    }

    monkeypatch.setattr(registry, "find", lambda provider, model_id: model)
    monkeypatch.setattr(registry, "has_configured_auth", lambda _model: False)
    monkeypatch.setattr(registry, "get_available", lambda: [])

    result = find_initial_model(
        scoped_models=[],
        is_continuing=False,
        default_provider="ghost-provider",
        default_model_id="ghost",
        model_registry=registry,
    )
    assert result.model is None


def test_editor_large_paste_uses_marker_and_expands_on_submit() -> None:
    class FakeTui:
        def request_render(self) -> None:
            return None

    editor = Editor.__new__(Editor)
    from pi_mono.tui.undo_stack import UndoStack

    editor.tui = FakeTui()  # type: ignore[assignment]
    editor._state = type("S", (), {})()
    editor._state.lines = [""]
    editor._state.cursor_line = 0
    editor._state.cursor_col = 0
    editor._pastes = {}
    editor._paste_counter = 0
    editor._history_index = -1
    editor._history_draft = None
    editor._last_action = None
    editor._undo_stack = UndoStack()
    editor._autocomplete_state = None
    editor._autocomplete_list = None
    editor._autocomplete_provider = None
    editor._autocomplete_debounce_task = None
    editor._autocomplete_abort = None
    editor.on_change = None
    submitted: list[str] = []
    editor.on_submit = submitted.append
    editor.disable_submit = False

    large = "\n".join(f"line {i}" for i in range(15))
    editor._handle_paste(large)
    assert editor.get_text().startswith("[paste #1")
    assert 1 in editor._pastes
    editor._submit_value()
    assert submitted
    assert "line 0" in submitted[0]
    assert "line 14" in submitted[0]
    assert editor._pastes == {}
