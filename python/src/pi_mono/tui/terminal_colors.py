"""OSC terminal color response parsing."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

TerminalColorScheme = Literal["dark", "light"]


@dataclass(frozen=True)
class RgbColor:
    r: int
    g: int
    b: int


def _hex_to_rgb(hex_color: str) -> RgbColor:
    normalized = hex_color[1:] if hex_color.startswith("#") else hex_color
    return RgbColor(
        r=int(normalized[0:2], 16),
        g=int(normalized[2:4], 16),
        b=int(normalized[4:6], 16),
    )


def _parse_osc_hex_channel(channel: str) -> int | None:
    if not re.fullmatch(r"[0-9a-f]+", channel, flags=re.IGNORECASE):
        return None
    max_value = 16 ** len(channel) - 1
    if max_value <= 0:
        return None
    return round((int(channel, 16) / max_value) * 255)


_OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN = re.compile(
    r"^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$",
    flags=re.IGNORECASE,
)
_COLOR_SCHEME_REPORT_PATTERN = re.compile(r"^\x1b\[\?997;(1|2)n$")


def is_osc11_background_color_response(data: str) -> bool:
    return _OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN.fullmatch(data) is not None


def parse_osc11_background_color(data: str) -> RgbColor | None:
    match = _OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN.fullmatch(data)
    if not match:
        return None

    value = match.group(1).strip()
    if value.startswith("#"):
        hex_value = value[1:]
        if re.fullmatch(r"[0-9a-f]{6}", hex_value, flags=re.IGNORECASE):
            return _hex_to_rgb(value)
        if re.fullmatch(r"[0-9a-f]{12}", hex_value, flags=re.IGNORECASE):
            red = _parse_osc_hex_channel(hex_value[0:4])
            green = _parse_osc_hex_channel(hex_value[4:8])
            blue = _parse_osc_hex_channel(hex_value[8:12])
            if red is None or green is None or blue is None:
                return None
            return RgbColor(r=red, g=green, b=blue)
        return None

    rgb_value = re.sub(r"^rgba?:", "", value, flags=re.IGNORECASE)
    parts = rgb_value.split("/")
    if len(parts) != 3:
        return None
    red = _parse_osc_hex_channel(parts[0])
    green = _parse_osc_hex_channel(parts[1])
    blue = _parse_osc_hex_channel(parts[2])
    if red is None or green is None or blue is None:
        return None
    return RgbColor(r=red, g=green, b=blue)


def parse_terminal_color_scheme_report(data: str) -> TerminalColorScheme | None:
    match = _COLOR_SCHEME_REPORT_PATTERN.fullmatch(data)
    if not match:
        return None
    return "light" if match.group(1) == "2" else "dark"
