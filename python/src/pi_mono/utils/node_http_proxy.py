import json
import os
import re
import urllib.parse
from typing import Dict, Optional

UNSUPPORTED_PROXY_PROTOCOL_MESSAGE = (
    "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; "
    "use an HTTP or HTTPS proxy URL."
)

DEFAULT_PROXY_PORTS = {
    "ftp": 21,
    "gopher": 70,
    "http": 80,
    "https": 443,
    "ws": 80,
    "wss": 443,
}


def get_proxy_env(key: str) -> str:
    return os.environ.get(key.lower()) or os.environ.get(key.upper()) or ""


def should_proxy_hostname(hostname: str, port: int) -> bool:
    no_proxy = get_proxy_env("no_proxy").lower()
    if not no_proxy:
        return True
    if no_proxy == "*":
        return False

    # Split by commas or spaces
    for proxy in re.split(r"[,\s]+", no_proxy):
        if not proxy:
            continue

        match = re.match(r"^(.+):(\d+)$", proxy)
        if match:
            proxy_hostname = match.group(1)
            proxy_port = int(match.group(2))
        else:
            proxy_hostname = proxy
            proxy_port = 0

        if proxy_port and proxy_port != port:
            continue

        if not (proxy_hostname.startswith(".") or proxy_hostname.startswith("*")):
            if hostname == proxy_hostname:
                return False
        else:
            test_host = proxy_hostname[1:] if proxy_hostname.startswith("*") else proxy_hostname
            if hostname.endswith(test_host):
                return False

    return True


def get_proxy_for_url(target_url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(target_url)
    except Exception:
        return ""
    if not parsed.scheme or not parsed.hostname:
        return ""

    protocol = parsed.scheme
    hostname = parsed.hostname
    port = parsed.port or DEFAULT_PROXY_PORTS.get(protocol, 0)

    if not should_proxy_hostname(hostname, port):
        return ""

    proxy = get_proxy_env(f"{protocol}_proxy") or get_proxy_env("all_proxy")
    if proxy and "://" not in proxy:
        proxy = f"{protocol}://{proxy}"
    return proxy


def resolve_http_proxy_url_for_target(target_url: str) -> Optional[urllib.parse.ParseResult]:
    proxy = get_proxy_for_url(target_url)
    if not proxy:
        return None
    try:
        proxy_url = urllib.parse.urlparse(proxy)
    except Exception as e:
        raise ValueError(f"Invalid proxy URL {json.dumps(proxy)}: {str(e)}")

    if proxy_url.scheme not in ("http", "https"):
        raise ValueError(f"{UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got {proxy_url.scheme}:")

    return proxy_url


def create_http_proxy_agents_for_target(target_url: str) -> Optional[Dict[str, str]]:
    proxy_url = resolve_http_proxy_url_for_target(target_url)
    if not proxy_url:
        return None
    url_str = proxy_url.geturl()
    return {
        "http": url_str,
        "https": url_str,
    }
