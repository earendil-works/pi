import json

from pi_mono.coding_agent.migrations import migrate_auth_to_auth_json, run_migrations
from pi_mono.coding_agent.utils.tools_manager import get_tool_path


def test_migrate_auth_to_auth_json_moves_oauth_and_api_keys(monkeypatch, tmp_path) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    monkeypatch.setattr("pi_mono.coding_agent.migrations.get_agent_dir", lambda: agent_dir)

    oauth = {"anthropic": {"accessToken": "token"}}
    (agent_dir / "oauth.json").write_text(json.dumps(oauth), encoding="utf-8")
    settings = {"apiKeys": {"openai": "sk-test"}}
    (agent_dir / "settings.json").write_text(json.dumps(settings), encoding="utf-8")

    providers = migrate_auth_to_auth_json()
    assert "anthropic" in providers
    assert "openai" in providers
    auth = json.loads((agent_dir / "auth.json").read_text(encoding="utf-8"))
    assert auth["anthropic"]["type"] == "oauth"
    assert auth["openai"]["type"] == "api_key"


def test_run_migrations_returns_warnings_for_hooks_dir(monkeypatch, tmp_path) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    hooks_dir = agent_dir / "hooks"
    hooks_dir.mkdir()
    monkeypatch.setattr("pi_mono.coding_agent.migrations.get_agent_dir", lambda: agent_dir)

    result = run_migrations(str(tmp_path))
    assert any("hooks/" in warning for warning in result.deprecation_warnings)


def test_get_tool_path_prefers_managed_binary(monkeypatch, tmp_path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    rg_path = bin_dir / "rg"
    rg_path.write_text("#!/bin/sh\n", encoding="utf-8")
    rg_path.chmod(0o755)
    monkeypatch.setattr("pi_mono.coding_agent.utils.tools_manager.get_bin_dir", lambda: bin_dir)
    assert get_tool_path("rg") == str(rg_path)
