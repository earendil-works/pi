from pi_mono.ai.utils.provider_env import get_provider_env_value


def test_provider_env_prefers_scoped_over_process(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "process-key")
    assert (
        get_provider_env_value("ANTHROPIC_API_KEY", {"ANTHROPIC_API_KEY": "scoped-key"})
        == "scoped-key"
    )


def test_provider_env_falls_back_to_process(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "process-key")
    assert get_provider_env_value("OPENAI_API_KEY") == "process-key"
