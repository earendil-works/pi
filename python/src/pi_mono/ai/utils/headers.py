"""HTTP headers utilities."""

from typing import Iterable


def headers_to_record(
    headers: Iterable[tuple[str, str]] | dict[str, str],
) -> dict[str, str]:
    """Convert headers to a plain dict."""
    if isinstance(headers, dict):
        return dict(headers)
    return {key: value for key, value in headers}
