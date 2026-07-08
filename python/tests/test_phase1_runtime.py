"""Phase 1 runtime foundation tests."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from pi_mono.agent.harness.agent_harness import AgentHarness
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.coding_agent.core.agent_session import (
    AgentSessionRuntime,
    SessionImportFileNotFoundError,
)
from pi_mono.coding_agent.core.project_trust import (
    ProjectTrustContext,
    resolve_project_trusted,
)
from pi_mono.coding_agent.core.project_trust import ResolveProjectTrustedOptions
from pi_mono.coding_agent.core.trust_manager import ProjectTrustStore
from pi_mono.coding_agent.migrations import migrate_extension_system
from pi_mono.core.http_dispatcher import apply_http_proxy_settings
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _write_sample_session(path: Path, *, cwd: str) -> None:
    header = {
        "type": "session",
        "version": 3,
        "id": "phase1-session",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "cwd": cwd,
    }
    user_message = {
        "type": "message",
        "id": "entry-1",
        "parentId": None,
        "timestamp": header["timestamp"],
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "Phase 1 import test"}],
        },
    }
    with path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(header) + "\n")
        handle.write(json.dumps(user_message) + "\n")


def test_apply_http_proxy_from_settings_manager(tmp_path, monkeypatch) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    settings_path = agent_dir / "settings.json"
    settings_path.write_text(
        json.dumps({"httpProxy": "http://127.0.0.1:3128"}),
        encoding="utf-8",
    )
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("HTTPS_PROXY", raising=False)

    settings = SettingsManager.create(str(tmp_path), str(agent_dir), project_trusted=True)
    apply_http_proxy_settings(settings.get_http_proxy())

    assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:3128"
    assert os.environ["HTTPS_PROXY"] == "http://127.0.0.1:3128"


def test_migrate_extension_system_renames_commands_to_prompts(tmp_path, monkeypatch) -> None:
    agent_dir = tmp_path / "agent"
    commands_dir = agent_dir / "commands"
    commands_dir.mkdir(parents=True)
    (commands_dir / "hello.md").write_text("hello", encoding="utf-8")
    monkeypatch.setattr("pi_mono.coding_agent.migrations.get_agent_dir", lambda: agent_dir)

    warnings = migrate_extension_system(str(tmp_path))
    assert (agent_dir / "prompts" / "hello.md").is_file()
    assert not commands_dir.exists()
    assert warnings == []


def test_read_catalog_bytes_from_json(tmp_path: Path) -> None:
    scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
    sys.path.insert(0, str(scripts_dir))
    try:
        from sync_models import read_catalog_bytes

        source = tmp_path / "models.generated.json"
        payload = {"openai": {"gpt-4": {"id": "gpt-4"}}}
        source.write_text(json.dumps(payload), encoding="utf-8")
        assert json.loads(read_catalog_bytes(source, None).decode("utf-8")) == payload
    finally:
        sys.path.remove(str(scripts_dir))


def test_sync_models_check_with_matching_catalogs(tmp_path: Path, monkeypatch) -> None:
    scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
    sys.path.insert(0, str(scripts_dir))
    try:
        from sync_models import sync_models

        root = tmp_path / "repo"
        ts_src = root / "packages" / "ai" / "src"
        py_dest = root / "python" / "src" / "pi_mono" / "ai"
        ts_src.mkdir(parents=True)
        py_dest.mkdir(parents=True)
        payload = b'{"provider": {"model": {"id": "model"}}}'
        for stem in ("models.generated", "image-models.generated"):
            (ts_src / f"{stem}.json").write_bytes(payload)
            (py_dest / f"{stem}.json").write_bytes(payload)

        monkeypatch.setattr("sync_models._repo_root", lambda: root)
        assert sync_models(check=True) == 0
    finally:
        sys.path.remove(str(scripts_dir))


def test_generate_models_wrapper_delegates_to_sync(tmp_path: Path, monkeypatch) -> None:
    scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
    sys.path.insert(0, str(scripts_dir))
    try:
        from generate_models import generate_models

        calls: list[bool] = []

        def fake_sync(*, check: bool = False) -> int:
            calls.append(check)
            return 0

        monkeypatch.setattr("generate_models.sync_models", fake_sync)
        assert generate_models(check=True) == 0
        assert calls == [True]
    finally:
        sys.path.remove(str(scripts_dir))


def test_agent_harness_defaults_to_local_execution_env(tmp_path) -> None:
    class _Session:
        cwd = str(tmp_path)

    harness = AgentHarness(
        {
            "session": _Session(),
            "model": {"provider": "faux", "id": "faux", "api": "faux"},
        }
    )
    assert isinstance(harness.env, LocalExecutionEnv)
    assert harness.env.cwd == str(tmp_path)


@pytest.mark.anyio
async def test_import_from_jsonl_loads_session_file(tmp_path) -> None:
    cwd = str(tmp_path)
    session_file = tmp_path / "import.jsonl"
    _write_sample_session(session_file, cwd=cwd)

    class _Session:
        def __init__(self) -> None:
            self.cwd = cwd
            self.session_file = None
            self.session_manager = SessionManager.in_memory(cwd)

    runtime = AgentSessionRuntime(
        session=_Session(),  # type: ignore[arg-type]
        services=SimpleNamespace(agent_dir=str(tmp_path / "agent")),
        diagnostics=[],
    )
    captured: dict[str, SessionManager] = {}

    async def fake_apply(
        session_manager: SessionManager,
        *,
        reason: str,
        previous_session_file: str | None = None,
    ) -> None:
        del reason, previous_session_file
        captured["session_manager"] = session_manager

    runtime._apply_runtime = fake_apply  # type: ignore[method-assign]
    runtime._teardown_current = AsyncMock()  # type: ignore[method-assign]
    runtime._finish_replacement = AsyncMock()  # type: ignore[method-assign]

    result = await runtime.import_from_jsonl(str(session_file))
    assert result == {"cancelled": False}
    assert "session_manager" in captured
    assert captured["session_manager"].get_cwd() == cwd


@pytest.mark.anyio
async def test_import_from_jsonl_missing_file_raises() -> None:
    runtime = AgentSessionRuntime(
        session=SimpleNamespace(
            cwd="/tmp",
            session_file=None,
            session_manager=SimpleNamespace(get_session_dir=lambda: "/tmp"),
        ),
        services=object(),
        diagnostics=[],
    )
    with pytest.raises(SessionImportFileNotFoundError):
        await runtime.import_from_jsonl("/tmp/does-not-exist-session.jsonl")


@pytest.mark.anyio
async def test_resolve_project_trusted_uses_ui_selection(tmp_path) -> None:
    project_cwd = tmp_path / "project"
    project_dir = project_cwd / ".pi"
    (project_dir / "extensions").mkdir(parents=True)
    (project_dir / "settings.json").write_text("{}", encoding="utf-8")

    class _UI:
        async def select(self, _title: str, options: list[str]) -> str | None:
            return options[0]

    trusted = await resolve_project_trusted(
        ResolveProjectTrustedOptions(
            cwd=str(project_cwd),
            trust_store=ProjectTrustStore(str(tmp_path / "agent")),
            project_trust_context=ProjectTrustContext(has_ui=True, ui=_UI()),
            default_project_trust="ask",
        )
    )
    assert trusted is True


@pytest.mark.anyio
async def test_agent_session_set_auto_retry_updates_settings(tmp_path) -> None:
    from pi_mono.ai.providers.faux import register_faux_provider
    from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
    from pi_mono.core.auth_storage import AuthStorage
    from pi_mono.core.model_registry import ModelRegistry

    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        model = faux.get_model()
        assert model is not None
        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        model_registry = ModelRegistry.create(auth_storage)
        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                no_extensions=True,
            )
        )
        session = result.session
        session.set_auto_retry(False)
        assert session.settings_manager.get_retry_enabled() is False
        session.set_auto_retry(True)
        assert session.settings_manager.get_retry_enabled() is True
    finally:
        faux.unregister()
