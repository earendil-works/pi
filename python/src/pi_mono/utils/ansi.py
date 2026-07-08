import re

# Valid string terminator sequences are BEL (\u0007), ESC\ (\u001b\\), and 0x9c (\u009c)
ST = r"(?:\u0007|\u001B\\|\u009C)"

# OSC sequences only: ESC ] ... ST (non-greedy until the first ST)
OSC = r"(?:\u001B\][\s\S]*?" + ST + r")"

# CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :) then final byte
CSI = r"[\u001B\u009B][\[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]"

PATTERN = f"{OSC}|{CSI}"
REGEX = re.compile(PATTERN)


def strip_ansi(value: str) -> str:
    """Strip ANSI escape codes from a string."""
    if not isinstance(value, str):
        raise TypeError(f"Expected a `str`, got `{type(value).__name__}`")

    # Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
    if "\u001b" not in value and "\u009b" not in value:
        return value

    return REGEX.sub("", value)
