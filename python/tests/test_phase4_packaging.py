"""Phase 4 AI and packaging depth tests."""

from __future__ import annotations

import base64
import io
from unittest.mock import AsyncMock, patch

import pytest
from PIL import Image

from pi_mono.ai.providers.mistral import (
    build_chat_payload,
    build_request_options,
    get_mistral_cached_prompt_tokens,
    should_use_prompt_caching,
)
from pi_mono.ai.providers.register_builtins import _make_lazy_provider
from pi_mono.ai.utils.oauth.github_copilot import (
    GitHubCopilotOAuthProvider,
    is_selectable_copilot_model,
    parse_available_copilot_model_ids,
)
from pi_mono.coding_agent.core.tools.find import _glob_with_walk
from pi_mono.coding_agent.package_manager_cli import (
    UpdateTarget,
    _update_target_includes_extensions,
    _update_target_includes_self,
    parse_package_command,
)
from pi_mono.coding_agent.utils.tools_manager import TOOLS, get_tool_path
from pi_mono.utils.exif_orientation import apply_exif_orientation
from pi_mono.utils.image_convert import convert_to_png
from pi_mono.utils.image_resize import resize_image


def test_is_selectable_copilot_model():
    assert is_selectable_copilot_model(
        {
            "id": "gpt-4.1",
            "model_picker_enabled": True,
            "policy": {"state": "enabled"},
            "capabilities": {"supports": {"tool_calls": True}},
        }
    )
    assert not is_selectable_copilot_model(
        {
            "id": "hidden",
            "model_picker_enabled": False,
            "policy": {"state": "enabled"},
            "capabilities": {"supports": {"tool_calls": True}},
        }
    )


def test_parse_available_copilot_model_ids():
    raw = {
        "data": [
            {
                "id": "gpt-4.1",
                "model_picker_enabled": True,
                "policy": {"state": "enabled"},
                "capabilities": {"supports": {"tool_calls": True}},
            },
            {
                "id": "disabled-model",
                "model_picker_enabled": True,
                "policy": {"state": "disabled"},
                "capabilities": {"supports": {"tool_calls": True}},
            },
        ]
    }
    assert parse_available_copilot_model_ids(raw) == ["gpt-4.1"]


def test_github_copilot_modify_models_filters_unavailable():
    provider = GitHubCopilotOAuthProvider()
    models = [
        {"id": "a", "provider": "github-copilot", "baseUrl": ""},
        {"id": "b", "provider": "github-copilot", "baseUrl": ""},
        {"id": "c", "provider": "openai", "baseUrl": ""},
    ]
    credentials = {
        "refresh": "r",
        "access": "token",
        "expires": 999999999999,
        "availableModelIds": ["a"],
    }
    result = provider.modify_models(models, credentials)  # type: ignore[arg-type]
    assert [m["id"] for m in result] == ["a", "c"]
    assert result[0]["baseUrl"].startswith("https://")


def test_mistral_prompt_caching_helpers():
    assert should_use_prompt_caching({"sessionId": "sess", "cacheRetention": "short"})
    assert not should_use_prompt_caching({"sessionId": "sess", "cacheRetention": "none"})
    assert (
        get_mistral_cached_prompt_tokens({"prompt_tokens_details": {"cached_tokens": 12}}, 20) == 12
    )


def test_mistral_build_chat_payload_sets_prompt_cache_key():
    model = {"id": "mistral-large", "provider": "mistral", "input": ["text"]}
    context = {"messages": [], "systemPrompt": "sys"}
    payload = build_chat_payload(
        model,
        context,
        [],
        {"sessionId": "session-1", "cacheRetention": "short"},
    )
    assert payload["prompt_cache_key"] == "session-1"


def test_mistral_build_request_options_sets_x_affinity():
    model = {"id": "mistral-large", "provider": "mistral", "input": ["text"]}
    options = build_request_options(
        model,
        {"sessionId": "session-1", "cacheRetention": "short"},
    )
    assert options["http_headers"]["x-affinity"] == "session-1"


def test_lazy_provider_defers_import():
    imported: list[str] = []

    class FakeModule:
        def stream_mistral(self, model, context, options=None):
            imported.append("stream")
            return "ok"

        def stream_simple_mistral(self, model, context, options=None):
            imported.append("simple")
            return "simple-ok"

    provider = _make_lazy_provider(
        "mistral-conversations",
        "fake.module",
        "stream_mistral",
        "stream_simple_mistral",
    )

    with patch("importlib.import_module", return_value=FakeModule()):
        assert imported == []
        assert provider.stream({}, {}) == "ok"
        assert provider.stream_simple({}, {}) == "simple-ok"
        assert imported == ["stream", "simple"]


def test_tools_config_has_fd_and_rg():
    assert "fd" in TOOLS
    assert "rg" in TOOLS


def test_get_tool_path_returns_system_rg_when_available(monkeypatch):
    monkeypatch.setattr(
        "pi_mono.coding_agent.utils.tools_manager._command_exists",
        lambda command: command == "rg",
    )
    monkeypatch.setattr(
        "pi_mono.coding_agent.utils.tools_manager.os.path.isfile",
        lambda _path: False,
    )
    assert get_tool_path("rg") == "rg"


@pytest.mark.anyio
async def test_find_walk_fallback(tmp_path):
    file_path = tmp_path / "hello.txt"
    file_path.write_text("x", encoding="utf-8")
    results = await _glob_with_walk("*.txt", str(tmp_path), limit=10)
    assert results == ["hello.txt"]


def test_parse_package_command_update_defaults_to_self():
    options = parse_package_command(["update"])
    assert options is not None
    assert options.update_target == UpdateTarget(type="self")
    assert options.show_extensions_skipped_note is True


def test_parse_package_command_update_all():
    options = parse_package_command(["update", "--all"])
    assert options is not None
    assert options.update_target == UpdateTarget(type="all")


def test_update_target_helpers():
    assert _update_target_includes_self(UpdateTarget(type="self"))
    assert _update_target_includes_self(UpdateTarget(type="all"))
    assert _update_target_includes_extensions(UpdateTarget(type="extensions"))
    assert _update_target_includes_extensions(UpdateTarget(type="all"))


def test_apply_exif_orientation_preserves_plain_image():
    image = Image.new("RGB", (4, 2), color="red")
    assert apply_exif_orientation(image).size == (4, 2)


def test_convert_to_png_from_jpeg():
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color="blue").save(buffer, format="JPEG")
    data = base64.b64encode(buffer.getvalue()).decode("ascii")
    converted = convert_to_png(data, "image/jpeg")
    assert converted is not None
    assert converted["mimeType"] == "image/png"


def test_resize_image_returns_result_for_jpeg():
    buffer = io.BytesIO()
    Image.new("RGB", (40, 20), color="green").save(buffer, format="JPEG")
    result = resize_image(buffer.getvalue(), "image/jpeg", {"max_width": 10, "max_height": 10})
    assert result is not None
    assert result.width <= 10
    assert result.height <= 10


@pytest.mark.anyio
async def test_get_self_update_plan_skips_when_current():
    from pi_mono.coding_agent import package_manager_cli as cli

    with patch(
        "pi_mono.coding_agent.package_manager_cli.get_latest_pi_release",
        new=AsyncMock(return_value={"version": cli.VERSION, "packageName": cli.PACKAGE_NAME}),
    ):
        plan = await cli._get_self_update_plan(False)
    assert plan["shouldRun"] is False
