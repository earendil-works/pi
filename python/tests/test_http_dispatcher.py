import os

import pytest

from pi_mono.core.http_dispatcher import apply_http_proxy_settings


@pytest.fixture(autouse=True)
def _reset_proxy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("HTTP_PROXY", "HTTPS_PROXY"):
        monkeypatch.delenv(key, raising=False)


def test_apply_http_proxy_settings_sets_proxy_env_vars() -> None:
    apply_http_proxy_settings("http://127.0.0.1:7890")
    assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:7890"
    assert os.environ["HTTPS_PROXY"] == "http://127.0.0.1:7890"


def test_apply_http_proxy_settings_does_not_override_existing_env() -> None:
    os.environ["HTTP_PROXY"] = "http://env-http:8080"
    os.environ["HTTPS_PROXY"] = "http://env-https:8080"
    apply_http_proxy_settings("http://127.0.0.1:7890")
    assert os.environ["HTTP_PROXY"] == "http://env-http:8080"
    assert os.environ["HTTPS_PROXY"] == "http://env-https:8080"


def test_apply_http_proxy_settings_ignores_blank_values() -> None:
    apply_http_proxy_settings("   ")
    assert "HTTP_PROXY" not in os.environ
    assert "HTTPS_PROXY" not in os.environ
