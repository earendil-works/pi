import pytest
from pi_mono.utils.node_http_proxy import (
    resolve_http_proxy_url_for_target,
    create_http_proxy_agents_for_target,
    UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
)


def test_proxy_resolution_basic(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://my-proxy:8080")
    monkeypatch.delenv("NO_PROXY", raising=False)

    proxy_url = resolve_http_proxy_url_for_target("http://google.com")
    assert proxy_url is not None
    assert proxy_url.scheme == "http"
    assert proxy_url.netloc == "my-proxy:8080"

    agents = create_http_proxy_agents_for_target("http://google.com")
    assert agents == {
        "http": "http://my-proxy:8080",
        "https": "http://my-proxy:8080",
    }


def test_no_proxy_matching(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://my-proxy:8080")
    monkeypatch.setenv("NO_PROXY", "localhost, .local, *.example.com, specific.host:8081")

    # localhost should be bypassed
    assert resolve_http_proxy_url_for_target("http://localhost") is None
    # foo.local should be bypassed
    assert resolve_http_proxy_url_for_target("http://foo.local") is None
    # bar.example.com should be bypassed
    assert resolve_http_proxy_url_for_target("http://bar.example.com") is None
    # specific.host at 8081 should be bypassed
    assert resolve_http_proxy_url_for_target("http://specific.host:8081") is None
    # specific.host at 8080 should STILL proxy
    assert resolve_http_proxy_url_for_target("http://specific.host:8080") is not None


def test_unsupported_proxy_protocol(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "socks5://my-proxy:1080")
    monkeypatch.delenv("NO_PROXY", raising=False)

    with pytest.raises(ValueError) as exc_info:
        resolve_http_proxy_url_for_target("http://google.com")

    assert UNSUPPORTED_PROXY_PROTOCOL_MESSAGE in str(exc_info.value)
