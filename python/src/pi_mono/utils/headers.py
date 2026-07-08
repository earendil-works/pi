from typing import Mapping, Union, Iterable, Tuple, Any


def headers_to_record(
    headers: Union[Mapping[str, str], Iterable[Tuple[str, str]], Any],
) -> dict[str, str]:
    """Convert a Headers object or a mapping to a record (dict of strings)."""
    if headers is None:
        return {}

    if hasattr(headers, "items"):
        return {str(k): str(v) for k, v in headers.items()}

    if hasattr(headers, "entries") and callable(headers.entries):
        try:
            return {str(k): str(v) for k, v in headers.entries()}
        except Exception:
            pass

    # Fallback to iterable of pairs
    try:
        return {str(k): str(v) for k, v in headers}
    except Exception:
        # Fallback to dict casting if possible
        if isinstance(headers, dict):
            return {str(k): str(v) for k, v in headers.items()}
        return {}
