import pytest
from pi_mono.ai.env_api_keys import find_env_keys, get_env_api_key


@pytest.fixture
def clean_env(monkeypatch):
    vars_to_clear = [
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "ZAI_CODING_CN_API_KEY",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GCLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "CURSOR_API_KEY",
    ]
    for var in vars_to_clear:
        monkeypatch.delenv(var, raising=False)


def test_does_not_treat_generic_github_tokens_as_github_copilot_credentials(clean_env, monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "gh-token")
    monkeypatch.setenv("GITHUB_TOKEN", "github-token")

    assert find_env_keys("github-copilot") is None
    assert get_env_api_key("github-copilot") is None


def test_resolves_github_copilot_credentials_from_copilot_github_token(clean_env, monkeypatch):
    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "copilot-token")
    monkeypatch.setenv("GH_TOKEN", "gh-token")
    monkeypatch.setenv("GITHUB_TOKEN", "github-token")

    assert find_env_keys("github-copilot") == ["COPILOT_GITHUB_TOKEN"]
    assert get_env_api_key("github-copilot") == "copilot-token"


def test_resolves_zai_china_coding_plan_credentials(clean_env, monkeypatch):
    monkeypatch.setenv("ZAI_CODING_CN_API_KEY", "zai-coding-cn-token")

    assert find_env_keys("zai-coding-cn") == ["ZAI_CODING_CN_API_KEY"]
    assert get_env_api_key("zai-coding-cn") == "zai-coding-cn-token"


def test_anthropic_priority(clean_env, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "api-key")
    assert find_env_keys("anthropic") == ["ANTHROPIC_API_KEY"]
    assert get_env_api_key("anthropic") == "api-key"

    monkeypatch.setenv("ANTHROPIC_OAUTH_TOKEN", "oauth-token")
    assert find_env_keys("anthropic") == [
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
    ]
    assert get_env_api_key("anthropic") == "oauth-token"


def test_google_vertex_ambient_credentials(clean_env, monkeypatch, tmp_path):
    fake_creds = tmp_path / "adc.json"
    fake_creds.touch()
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(fake_creds))

    assert get_env_api_key("google-vertex") is None

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-project")
    assert get_env_api_key("google-vertex") is None

    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")

    import pi_mono.ai.env_api_keys

    pi_mono.ai.env_api_keys._cached_vertex_adc_credentials_exists = None

    assert get_env_api_key("google-vertex") == "<authenticated>"


def test_amazon_bedrock_ambient_credentials(clean_env, monkeypatch):
    assert get_env_api_key("amazon-bedrock") is None

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "key-id")
    assert get_env_api_key("amazon-bedrock") is None

    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret-key")
    assert get_env_api_key("amazon-bedrock") == "<authenticated>"

    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY")
    monkeypatch.setenv("AWS_PROFILE", "my-profile")
    assert get_env_api_key("amazon-bedrock") == "<authenticated>"


def test_resolves_cursor_api_key(clean_env, monkeypatch):
    monkeypatch.setenv("CURSOR_API_KEY", "cursor-sdk-key")

    assert find_env_keys("cursor") == ["CURSOR_API_KEY"]
    assert get_env_api_key("cursor") == "cursor-sdk-key"
