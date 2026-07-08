"""Text measurement and rendering utilities for TUI.

Ported from TypeScript's utils.ts with:
- unicodedata.east_asian_width for cell width calculations
- Pure Python grapheme segmentation (no external deps)
- ANSI escape code handling preserved

Note: Python's re module doesn't support \\p{...} Unicode property escapes,
so we use unicodedata.category() checks instead.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Callable, List, Optional, Tuple

# =============================================================================
# Unicode Property Helpers
# =============================================================================

# Unicode categories for zero-width / non-printing characters
_ZERO_WIDTH_CATEGORIES = {
    "Cc",
    "Cf",
    "Cn",
    "Co",
    "Cs",
    "Mn",
    "Mc",
    "Me",
}  # Control, Format, Unassigned, Private Use, Surrogate, Marks
_LEADING_NON_PRINTING_CATEGORIES = {"Cc", "Cf", "Cn", "Co", "Cs", "Mn", "Mc", "Me"}

# Extended Pictographic (emoji) - we check this via codepoint ranges
# Main emoji ranges for fast detection
_EMOJI_RANGES = [
    (0x1F000, 0x1FBFF),  # Emoji and Pictograph
    (0x2300, 0x23FF),  # Misc Technical
    (0x2600, 0x27BF),  # Misc Symbols, Dingbats
    (0x2B50, 0x2B55),  # Stars/circles
    (0x1F1E6, 0x1F1FF),  # Regional indicators (flags)
    (0x1F300, 0x1F5FF),  # Misc Symbols and Pictographs
    (0x1F600, 0x1F64F),  # Emoticons
    (0x1F680, 0x1F6FF),  # Transport and Map
    (0x1F700, 0x1F77F),  # Alchemical Symbols
    (0x1F780, 0x1F7FF),  # Geometric Shapes Extended
    (0x1F800, 0x1F8FF),  # Supplemental Arrows-C
    (0x1F900, 0x1F9FF),  # Supplemental Symbols and Pictographs
    (0x1FA00, 0x1FA6F),  # Chess Symbols
    (0x1FA70, 0x1FAFF),  # Symbols and Pictographs Extended-A
    (0xE0020, 0xE007F),  # Tag characters
]

# Fullwidth/Halfwidth forms range
_FULLWIDTH_RANGE = (0xFF00, 0xFFEF)

# Thai/Lao AM vowels
_THAI_LAO_AM_CHARS = {0x0E33, 0x0EB3}

# ZWJ and VS16
_ZWJ = "\u200d"
_VS16 = "\ufe0f"


def _is_zero_width_char(ch: str) -> bool:
    """Check if character is zero-width (Default_Ignorable, Control, Mark, Surrogate)."""
    cat = unicodedata.category(ch)
    return cat in _ZERO_WIDTH_CATEGORIES


def _is_leading_non_printing_char(ch: str) -> bool:
    """Check if character is leading non-printing (Control, Format, Mark, Surrogate)."""
    cat = unicodedata.category(ch)
    return cat in _LEADING_NON_PRINTING_CATEGORIES


def _is_extended_pictographic(cp: int) -> bool:
    """Check if codepoint is Extended_Pictographic (emoji)."""
    for start, end in _EMOJI_RANGES:
        if start <= cp <= end:
            return True
    return False


def _strip_leading_non_printing(text: str) -> str:
    """Strip leading non-printing characters."""
    i = 0
    while i < len(text) and _is_leading_non_printing_char(text[i]):
        i += 1
    return text[i:]


# =============================================================================
# Unicode Grapheme Segmentation (Pure Python)
# =============================================================================

# Hangul syllable ranges for grapheme segmentation
_HANGUL_SYLLABLE_START = 0xAC00
_HANGUL_SYLLABLE_END = 0xD7A3
_HANGUL_L_BASE = 0x1100
_HANGUL_V_BASE = 0x1161
_HANGUL_T_BASE = 0x11A7
_HANGUL_L_COUNT = 19
_HANGUL_V_COUNT = 21
_HANGUL_T_COUNT = 28
_HANGUL_N_COUNT = _HANGUL_V_COUNT * _HANGUL_T_COUNT
_HANGUL_S_COUNT = _HANGUL_L_COUNT * _HANGUL_N_COUNT

# Unicode category sets for grapheme boundary rules
_CONTROL_CATEGORIES = {"Cc", "Cf", "Cn", "Co", "Cs"}
_MARK_CATEGORIES = {"Mn", "Mc", "Me", "Sk"}

# Cache for grapheme breaking
_GRAPHEME_CACHE: dict[str, List[str]] = {}
_MAX_GRAPHEME_CACHE_SIZE = 512

# Width cache
_WIDTH_CACHE: dict[str, int] = {}
_MAX_WIDTH_CACHE_SIZE = 512

# ANSI tracker singleton for extract_segments
_pooled_style_tracker: Optional["AnsiCodeTracker"] = None


def _get_grapheme_clusters(text: str) -> List[str]:
    """Segment text into grapheme clusters using Unicode TR29 rules (simplified).

    This is a pure Python implementation that handles:
    - Hangul syllable composition
    - Extended grapheme clusters (Mark, ZWJ sequences)
    - Regional indicator pairs
    - Emoji sequences

    Note: This is a simplified implementation. For production use,
    consider using the `uniseg` library if available.
    """
    if text in _GRAPHEME_CACHE:
        return _GRAPHEME_CACHE[text]

    if len(text) <= 1:
        return [text] if text else []

    clusters: List[str] = []
    i = 0

    while i < len(text):
        # Check for Hangul syllable composition
        cp = ord(text[i])

        if _HANGUL_SYLLABLE_START <= cp <= _HANGUL_SYLLABLE_END:
            # Precomposed Hangul syllable - treat as single grapheme
            clusters.append(text[i])
            i += 1
            continue

        # Start a new grapheme cluster
        cluster = text[i]
        i += 1

        # Extend cluster with marks, ZWJ sequences, etc.
        while i < len(text):
            next_cp = ord(text[i])
            next_char = text[i]
            prev_char = text[i - 1]

            # Check for extending marks (Mn, Mc, Me)
            if unicodedata.category(next_char) in _MARK_CATEGORIES:
                cluster += next_char
                i += 1
                continue

            # Check for ZWJ (Zero Width Joiner) sequences
            if next_char == _ZWJ:
                cluster += next_char
                i += 1
                # Include the next grapheme after ZWJ
                if i < len(text):
                    cluster += text[i]
                    i += 1
                continue

            # Check for emoji presentation selector (VS16)
            if next_char == _VS16:
                cluster += next_char
                i += 1
                continue

            # Check for Regional Indicator pairs (flags)
            # Two consecutive regional indicators form one grapheme
            if 0x1F1E6 <= ord(prev_char) <= 0x1F1FF and 0x1F1E6 <= next_cp <= 0x1F1FF:
                cluster += next_char
                i += 1
                continue

            # Check for Hangul L+V or LV+T composition
            # This is simplified - full implementation would need L/V/T tracking
            break

        clusters.append(cluster)

    # Manage cache size
    if len(_GRAPHEME_CACHE) >= _MAX_GRAPHEME_CACHE_SIZE:
        # Remove first entry (simple FIFO)
        first_key = next(iter(_GRAPHEME_CACHE))
        del _GRAPHEME_CACHE[first_key]
    _GRAPHEME_CACHE[text] = clusters

    return clusters


def grapheme_segment(text: str):
    """Yield grapheme clusters for editor/input cursor movement."""
    yield from _get_grapheme_clusters(text)


# =============================================================================
# East Asian Width & Grapheme Width Calculation
# =============================================================================


def _east_asian_width(cp: int) -> int:
    """Get east Asian width for a codepoint using unicodedata."""
    try:
        width_char = chr(cp)
        width = unicodedata.east_asian_width(width_char)
        if width in ("W", "F"):  # Wide or Fullwidth
            return 2
        if width in ("H", "Na", "N", "A"):  # Halfwidth, Narrow, Neutral, Ambiguous
            return 1
        return 1
    except (ValueError, OverflowError):
        return 1


def _could_be_emoji(segment: str) -> bool:
    """Fast heuristic to check if a grapheme could be an emoji."""
    if not segment:
        return False
    cp = ord(segment[0])
    return (
        (0x1F000 <= cp <= 0x1FBFF)  # Emoji and Pictograph
        or (0x2300 <= cp <= 0x23FF)  # Misc Technical
        or (0x2600 <= cp <= 0x27BF)  # Misc Symbols, Dingbats
        or (0x2B50 <= cp <= 0x2B55)  # Specific stars/circles
        or _VS16 in segment  # Contains VS16
        or len(segment) > 2  # Multi-codepoint sequences (ZWJ, skin tones)
    )


def grapheme_width(segment: str) -> int:
    """Calculate the terminal width of a single grapheme cluster."""
    if segment == "\t":
        return 3

    # Zero-width clusters
    if all(_is_zero_width_char(ch) for ch in segment):
        return 0

    # Emoji check with pre-filter
    if _could_be_emoji(segment) and _is_extended_pictographic(ord(segment[0])):
        return 2

    # Get base visible codepoint (strip leading non-printing)
    base = _strip_leading_non_printing(segment)
    if not base:
        return 0

    cp = ord(base[0])

    # Regional indicator symbols (flags) - conservative width 2
    if 0x1F1E6 <= cp <= 0x1F1FF:
        return 2

    width = _east_asian_width(cp)

    # Trailing halfwidth/fullwidth forms and AM vowels that segment with a base
    if len(segment) > 1:
        for char in segment[1:]:
            c = ord(char)
            if 0xFF00 <= c <= 0xFFEF:
                width += _east_asian_width(c)
            elif c in _THAI_LAO_AM_CHARS:  # Thai/Lao AM vowels
                width += 1

    return width


def visible_width(text: str) -> int:
    """Calculate the visible width of a string in terminal columns.

    Handles:
    - ANSI escape codes (stripped)
    - Tabs (converted to 3 spaces)
    - Wide characters (CJK, emoji)
    - Grapheme clusters
    """
    if not text:
        return 0

    # Fast path: pure ASCII printable
    if all(0x20 <= ord(c) <= 0x7E for c in text):
        return len(text)

    # Check cache
    cached = _WIDTH_CACHE.get(text)
    if cached is not None:
        return cached

    # Normalize: tabs to 3 spaces, strip ANSI escape codes
    clean = text.replace("\t", "   ")

    # Strip ANSI escape sequences
    if "\x1b" in clean:
        stripped = []
        i = 0
        while i < len(clean):
            ansi = extract_ansi_code(clean, i)
            if ansi:
                i += ansi[1]
                continue
            stripped.append(clean[i])
            i += 1
        clean = "".join(stripped)

    # Calculate width by grapheme clusters
    width = 0
    for segment in _get_grapheme_clusters(clean):
        width += grapheme_width(segment)

    # Cache result
    if len(_WIDTH_CACHE) >= _MAX_WIDTH_CACHE_SIZE:
        first_key = next(iter(_WIDTH_CACHE))
        del _WIDTH_CACHE[first_key]
    _WIDTH_CACHE[text] = width

    return width


# =============================================================================
# Thai/Lao Normalization
# =============================================================================

_THAI_LAO_AM_REGEX = re.compile(r"[\u0e33\u0eb3]")
_THAI_LAO_AM_GLOBAL_REGEX = re.compile(r"[\u0e33\u0eb3]")


def normalize_terminal_output(text: str) -> str:
    """Normalize Thai/Lao AM vowels for consistent terminal rendering.

    Some terminals render precomposed Thai/Lao AM vowels inconsistently
    during differential repaint. Their compatibility decompositions have
    the same cell width but avoid stale-cell artifacts.
    """
    if not _THAI_LAO_AM_REGEX.search(text):
        return text

    def repl(match: re.Match) -> str:
        char = match.group()
        if char == "\u0e33":  # Thai SARA AM
            return "\u0e4d\u0e32"  # Decomposition: NIKHAHIT + SARA AA
        elif char == "\u0eb3":  # Lao SARA AM
            return "\u0ecd\u0eb2"
        return char

    return _THAI_LAO_AM_GLOBAL_REGEX.sub(repl, text)


# =============================================================================
# ANSI Escape Code Handling
# =============================================================================


def extract_ansi_code(text: str, pos: int) -> Optional[Tuple[str, int]]:
    """Extract ANSI escape sequence at position.

    Returns (code, length) or None if no ANSI code at position.
    Handles CSI, OSC, and APC sequences.
    """
    if pos >= len(text) or text[pos] != "\x1b":
        return None

    if pos + 1 >= len(text):
        return None

    next_char = text[pos + 1]

    # CSI sequence: ESC [ ... m/G/K/H/J
    if next_char == "[":
        j = pos + 2
        while j < len(text) and text[j] not in "mGKHJ":
            j += 1
        if j < len(text):
            return (text[pos : j + 1], j + 1 - pos)
        return None

    # OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
    if next_char == "]":
        j = pos + 2
        while j < len(text):
            if text[j] == "\x07":
                return (text[pos : j + 1], j + 1 - pos)
            if text[j] == "\x1b" and j + 1 < len(text) and text[j + 1] == "\\":
                return (text[pos : j + 2], j + 2 - pos)
            j += 1
        return None

    # APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
    if next_char == "_":
        j = pos + 2
        while j < len(text):
            if text[j] == "\x07":
                return (text[pos : j + 1], j + 1 - pos)
            if text[j] == "\x1b" and j + 1 < len(text) and text[j + 1] == "\\":
                return (text[pos : j + 2], j + 2 - pos)
            j += 1
        return None

    return None


class ActiveHyperlink:
    """Active OSC 8 hyperlink state."""

    def __init__(self, params: str, url: str, terminator: str):
        self.params = params
        self.url = url
        self.terminator = terminator


class AnsiCodeTracker:
    """Track active ANSI SGR codes to preserve styling across line breaks."""

    def __init__(self):
        self.bold = False
        self.dim = False
        self.italic = False
        self.underline = False
        self.blink = False
        self.inverse = False
        self.hidden = False
        self.strikethrough = False
        self.fg_color: Optional[str] = None  # Full code like "31" or "38;5;240"
        self.bg_color: Optional[str] = None  # Full code like "41" or "48;5;240"
        self.active_hyperlink: Optional[ActiveHyperlink] = None

    def process(self, ansi_code: str) -> None:
        """Process an ANSI code and update internal state."""
        # OSC 8 hyperlink
        hyperlink = self._parse_osc8_hyperlink(ansi_code)
        if hyperlink is not None:
            self.active_hyperlink = hyperlink
            return

        if not ansi_code.endswith("m"):
            return

        # Extract parameters between ESC[ and m
        match = re.match(r"\x1b\[([\d;]*)m", ansi_code)
        if not match:
            return

        params = match.group(1)
        if params == "" or params == "0":
            self.reset()
            return

        parts = params.split(";")
        i = 0
        while i < len(parts):
            try:
                code = int(parts[i])
            except (ValueError, IndexError):
                i += 1
                continue

            # Handle 256-color and RGB codes
            if code in (38, 48):
                if i + 1 < len(parts) and parts[i + 1] == "5" and i + 2 < len(parts):
                    # 256 color: 38;5;N or 48;5;N
                    color_code = f"{parts[i]};{parts[i+1]};{parts[i+2]}"
                    if code == 38:
                        self.fg_color = color_code
                    else:
                        self.bg_color = color_code
                    i += 3
                    continue
                elif i + 1 < len(parts) and parts[i + 1] == "2" and i + 4 < len(parts):
                    # RGB color: 38;2;R;G;B or 48;2;R;G;B
                    color_code = ";".join(parts[i : i + 5])
                    if code == 38:
                        self.fg_color = color_code
                    else:
                        self.bg_color = color_code
                    i += 5
                    continue

            # Standard SGR codes
            if code == 0:
                self.reset()
            elif code == 1:
                self.bold = True
            elif code == 2:
                self.dim = True
            elif code == 3:
                self.italic = True
            elif code == 4:
                self.underline = True
            elif code == 5:
                self.blink = True
            elif code == 7:
                self.inverse = True
            elif code == 8:
                self.hidden = True
            elif code == 9:
                self.strikethrough = True
            elif code == 21:
                self.bold = False  # Some terminals
            elif code == 22:
                self.bold = False
                self.dim = False
            elif code == 23:
                self.italic = False
            elif code == 24:
                self.underline = False
            elif code == 25:
                self.blink = False
            elif code == 27:
                self.inverse = False
            elif code == 28:
                self.hidden = False
            elif code == 29:
                self.strikethrough = False
            elif code == 39:
                self.fg_color = None
            elif code == 49:
                self.bg_color = None
            elif (30 <= code <= 37) or (90 <= code <= 97):
                self.fg_color = str(code)
            elif (40 <= code <= 47) or (100 <= code <= 107):
                self.bg_color = str(code)

            i += 1

    def _parse_osc8_hyperlink(self, ansi_code: str) -> Optional[ActiveHyperlink]:
        """Parse OSC 8 hyperlink sequence."""
        if not ansi_code.startswith("\x1b]8;"):
            return None

        terminator: str = "\x07" if ansi_code.endswith("\x07") else "\x1b\\"
        body_end = -1 if terminator == "\x07" else -2
        body = ansi_code[4:body_end]

        separator = body.find(";")
        if separator == -1:
            return None

        params = body[:separator]
        url = body[separator + 1 :]
        if not url:
            return None

        return ActiveHyperlink(params, url, terminator)

    def reset(self) -> None:
        """Full reset - clear all SGR state."""
        self.bold = False
        self.dim = False
        self.italic = False
        self.underline = False
        self.blink = False
        self.inverse = False
        self.hidden = False
        self.strikethrough = False
        self.fg_color = None
        self.bg_color = None
        # SGR reset does not affect OSC 8 hyperlink state

    def clear(self) -> None:
        """Clear all state including hyperlink."""
        self.reset()
        self.active_hyperlink = None

    def get_active_codes(self) -> str:
        """Get all active SGR codes as an ANSI sequence."""
        codes = []
        if self.bold:
            codes.append("1")
        if self.dim:
            codes.append("2")
        if self.italic:
            codes.append("3")
        if self.underline:
            codes.append("4")
        if self.blink:
            codes.append("5")
        if self.inverse:
            codes.append("7")
        if self.hidden:
            codes.append("8")
        if self.strikethrough:
            codes.append("9")
        if self.fg_color:
            codes.append(self.fg_color)
        if self.bg_color:
            codes.append(self.bg_color)

        result = f"\x1b[{';'.join(codes)}m" if codes else ""
        if self.active_hyperlink:
            result += f"\x1b]8;{self.active_hyperlink.params};{self.active_hyperlink.url}{self.active_hyperlink.terminator}"
        return result

    def has_active_codes(self) -> bool:
        """Check if any codes are active."""
        return (
            self.bold
            or self.dim
            or self.italic
            or self.underline
            or self.blink
            or self.inverse
            or self.hidden
            or self.strikethrough
            or self.fg_color is not None
            or self.bg_color is not None
            or self.active_hyperlink is not None
        )

    def get_line_end_reset(self) -> str:
        """Get reset codes for attributes that need closing at line end.

        Underline and active OSC 8 hyperlinks must be closed to prevent
        bleeding into padding or next line.
        """
        result = ""
        if self.underline:
            result += "\x1b[24m"  # Underline off only
        if self.active_hyperlink:
            result += "\x1b]8;;" + self.active_hyperlink.terminator
        return result


def update_tracker_from_text(text: str, tracker: AnsiCodeTracker) -> None:
    """Update tracker state by scanning text for ANSI codes."""
    i = 0
    while i < len(text):
        ansi_result = extract_ansi_code(text, i)
        if ansi_result:
            tracker.process(ansi_result[0])
            i += ansi_result[1]
        else:
            i += 1


def split_into_tokens_with_ansi(text: str) -> List[str]:
    """Split text into tokens while keeping ANSI codes attached.

    Tokens are grouped by whitespace boundaries, with ANSI codes
    attached to the following visible content.
    """
    tokens: List[str] = []
    current = ""
    pending_ansi = ""
    in_whitespace = False
    i = 0

    while i < len(text):
        ansi_result = extract_ansi_code(text, i)
        if ansi_result:
            pending_ansi += ansi_result[0]
            i += ansi_result[1]
            continue

        char = text[i]
        char_is_space = char == " "

        if char_is_space != in_whitespace and current:
            tokens.append(current)
            current = ""

        # Attach pending ANSI codes to this visible character
        if pending_ansi:
            current += pending_ansi
            pending_ansi = ""

        in_whitespace = char_is_space
        current += char
        i += 1

    # Handle remaining pending ANSI codes
    if pending_ansi:
        current += pending_ansi

    if current:
        tokens.append(current)

    return tokens


def wrap_single_line(line: str, width: int) -> List[str]:
    """Wrap a single line preserving ANSI codes across breaks."""
    if not line:
        return [""]

    visible_len = visible_width(line)
    if visible_len <= width:
        return [line]

    wrapped: List[str] = []
    tracker = AnsiCodeTracker()
    tokens = split_into_tokens_with_ansi(line)

    current_line = ""
    current_visible_len = 0

    for token in tokens:
        token_visible_len = visible_width(token)
        is_whitespace = token.strip() == ""

        # Token too long - break it
        if token_visible_len > width and not is_whitespace:
            if current_line:
                line_end_reset = tracker.get_line_end_reset()
                if line_end_reset:
                    current_line += line_end_reset
                wrapped.append(current_line)
                current_line = ""
                current_visible_len = 0

            broken = break_long_word(token, width, tracker)
            for j in range(len(broken) - 1):
                wrapped.append(broken[j])
            current_line = broken[-1]
            current_visible_len = visible_width(current_line)
            continue

        # Check if adding token would exceed width
        total_needed = current_visible_len + token_visible_len

        if total_needed > width and current_visible_len > 0:
            line_to_wrap = current_line.rstrip()
            line_end_reset = tracker.get_line_end_reset()
            if line_end_reset:
                line_to_wrap += line_end_reset
            wrapped.append(line_to_wrap)

            if is_whitespace:
                current_line = tracker.get_active_codes()
                current_visible_len = 0
            else:
                current_line = tracker.get_active_codes() + token
                current_visible_len = token_visible_len
        else:
            current_line += token
            current_visible_len += token_visible_len

        update_tracker_from_text(token, tracker)

    if current_line:
        wrapped.append(current_line)

    return [line.rstrip() for line in wrapped] if wrapped else [""]


def break_long_word(word: str, width: int, tracker: AnsiCodeTracker) -> List[str]:
    """Break a word that's longer than the available width."""
    lines: List[str] = []
    current_line = tracker.get_active_codes()
    current_width = 0

    # Separate ANSI codes from visible content
    i = 0
    segments: List[Tuple[str, str]] = []  # (type, value)

    while i < len(word):
        ansi_result = extract_ansi_code(word, i)
        if ansi_result:
            segments.append(("ansi", ansi_result[0]))
            i += ansi_result[1]
        else:
            end = i
            while end < len(word) and not extract_ansi_code(word, end):
                end += 1
            text_portion = word[i:end]
            for segment in _get_grapheme_clusters(text_portion):
                segments.append(("grapheme", segment))
            i = end

    # Process segments
    for seg_type, value in segments:
        if seg_type == "ansi":
            current_line += value
            tracker.process(value)
            continue

        grapheme = value
        if not grapheme:
            continue

        gw = grapheme_width(grapheme)

        if current_width + gw > width:
            line_end_reset = tracker.get_line_end_reset()
            if line_end_reset:
                current_line += line_end_reset
            lines.append(current_line)
            current_line = tracker.get_active_codes()
            current_width = 0

        current_line += grapheme
        current_width += gw

    if current_line:
        lines.append(current_line)

    return lines if lines else [""]


# =============================================================================
# Public API
# =============================================================================

PUNCTUATION_REGEX = re.compile(r"[(){}[\]<>.,;:'\"!?+\-=*/\\|&%^$#@~`]")


def is_whitespace_char(char: str) -> bool:
    """Check if a character is whitespace."""
    return char.isspace()


def is_punctuation_char(char: str) -> bool:
    """Check if a character is punctuation."""
    return bool(PUNCTUATION_REGEX.match(char))


def wrap_text_with_ansi(text: str, width: int) -> List[str]:
    """Wrap text with ANSI codes preserved.

    Only does word wrapping - NO padding, NO background colors.
    Returns lines where each line is <= width visible chars.
    Active ANSI codes are preserved across line breaks.

    Args:
        text: Text to wrap (may contain ANSI codes and newlines)
        width: Maximum visible width per line

    Returns:
        Array of wrapped lines (NOT padded to width)
    """
    if not text:
        return [""]

    # Handle newlines by processing each line separately
    # Track ANSI state across lines so styles carry over after literal newlines
    input_lines = text.split("\n")
    result: List[str] = []
    tracker = AnsiCodeTracker()

    for input_line in input_lines:
        # Prepend active ANSI codes from previous lines (except for first line)
        prefix = tracker.get_active_codes() if result else ""
        wrapped_lines = wrap_single_line(prefix + input_line, width)
        result.extend(wrapped_lines)
        # Update tracker with codes from this line for next iteration
        update_tracker_from_text(input_line, tracker)

    return result if result else [""]


def apply_background_to_line(line: str, width: int, bg_fn: Callable[[str], str]) -> str:
    """Apply background color to a line, padding to full width."""
    visible_len = visible_width(line)
    padding_needed = max(0, width - visible_len)
    padding = " " * padding_needed
    with_padding = line + padding
    return bg_fn(with_padding)


def truncate_to_width(
    text: str,
    max_width: int,
    ellipsis: str = "...",
    pad: bool = False,
) -> str:
    """Truncate text to fit within maximum visible width, adding ellipsis if needed.

    Properly handles ANSI escape codes (they don't count toward width).

    Args:
        text: Text to truncate (may contain ANSI codes)
        max_width: Maximum visible width
        ellipsis: Ellipsis string to append when truncating
        pad: If True, pad result with spaces to exactly max_width

    Returns:
        Truncated text, optionally padded to exactly max_width
    """
    if max_width <= 0:
        return ""

    if not text:
        return " " * max_width if pad else ""

    ellipsis_width = visible_width(ellipsis)
    if ellipsis_width >= max_width:
        text_width = visible_width(text)
        if text_width <= max_width:
            return text + (" " * (max_width - text_width) if pad else "")
        clipped_ellipsis = truncate_fragment_to_width(ellipsis, max_width)
        if clipped_ellipsis[1] == 0:
            return " " * max_width if pad else ""
        return finalize_truncated_result(
            "", 0, clipped_ellipsis[0], clipped_ellipsis[1], max_width, pad
        )

    if all(0x20 <= ord(c) <= 0x7E for c in text):
        if len(text) <= max_width:
            return text + (" " * (max_width - len(text)) if pad else "")
        target_width = max_width - ellipsis_width
        return finalize_truncated_result(
            text[:target_width], target_width, ellipsis, ellipsis_width, max_width, pad
        )

    target_width = max_width - ellipsis_width
    result = ""
    pending_ansi = ""
    visible_so_far = 0
    kept_width = 0
    keep_contiguous_prefix = True
    overflowed = False
    exhausted_input = False
    has_ansi = "\x1b" in text
    has_tabs = "\t" in text

    if not has_ansi and not has_tabs:
        for segment in _get_grapheme_clusters(text):
            w = grapheme_width(segment)
            if keep_contiguous_prefix and kept_width + w <= target_width:
                result += segment
                kept_width += w
            else:
                keep_contiguous_prefix = False
            visible_so_far += w
            if visible_so_far > max_width:
                overflowed = True
                break
        exhausted_input = not overflowed
    else:
        i = 0
        while i < len(text):
            ansi_result = extract_ansi_code(text, i)
            if ansi_result:
                pending_ansi += ansi_result[0]
                i += ansi_result[1]
                continue

            if text[i] == "\t":
                if keep_contiguous_prefix and kept_width + 3 <= target_width:
                    if pending_ansi:
                        result += pending_ansi
                        pending_ansi = ""
                    result += "\t"
                    kept_width += 3
                else:
                    keep_contiguous_prefix = False
                    pending_ansi = ""
                visible_so_far += 3
                if visible_so_far > max_width:
                    overflowed = True
                    break
                i += 1
                continue

            end = i
            while end < len(text) and text[end] != "\t" and not extract_ansi_code(text, end):
                end += 1

            for segment in _get_grapheme_clusters(text[i:end]):
                w = grapheme_width(segment)
                if keep_contiguous_prefix and kept_width + w <= target_width:
                    if pending_ansi:
                        result += pending_ansi
                        pending_ansi = ""
                    result += segment
                    kept_width += w
                else:
                    keep_contiguous_prefix = False
                    pending_ansi = ""

                visible_so_far += w
                if visible_so_far > max_width:
                    overflowed = True
                    break

            if overflowed:
                break
            i = end

        exhausted_input = i >= len(text)

    if not overflowed and exhausted_input:
        if pad:
            return text + " " * max(0, max_width - visible_so_far)
        return text

    return finalize_truncated_result(result, kept_width, ellipsis, ellipsis_width, max_width, pad)


def truncate_fragment_to_width(text: str, max_width: int) -> Tuple[str, int]:
    """Truncate text fragment to max width, return (text, width)."""
    if max_width <= 0 or not text:
        return "", 0

    if all(0x20 <= ord(c) <= 0x7E for c in text):
        clipped = text[:max_width]
        return clipped, len(clipped)

    result = ""
    width = 0
    for segment in _get_grapheme_clusters(text):
        w = grapheme_width(segment)
        if width + w > max_width:
            break
        result += segment
        width += w

    return result, width


def finalize_truncated_result(
    prefix: str,
    prefix_width: int,
    ellipsis: str,
    ellipsis_width: int,
    max_width: int,
    pad: bool,
) -> str:
    """Finalize truncated result with reset codes and padding."""
    reset = "\x1b[0m"
    visible_width_total = prefix_width + ellipsis_width

    if len(ellipsis) > 0:
        result = f"{prefix}{reset}{ellipsis}{reset}"
    else:
        result = f"{prefix}{reset}"

    if pad:
        result += " " * max(0, max_width - visible_width_total)

    return result


def slice_by_column(line: str, start_col: int, length: int, strict: bool = False) -> str:
    """Extract a range of visible columns from a line."""
    return slice_with_width(line, start_col, length, strict)[0]


def slice_with_width(
    line: str,
    start_col: int,
    length: int,
    strict: bool = False,
) -> Tuple[str, int]:
    """Like slice_by_column but also returns the actual visible width."""
    if length <= 0:
        return "", 0

    end_col = start_col + length
    result = ""
    result_width = 0
    current_col = 0
    i = 0
    pending_ansi = ""

    while i < len(line):
        ansi_result = extract_ansi_code(line, i)
        if ansi_result:
            if current_col >= start_col and current_col < end_col:
                result += ansi_result[0]
            elif current_col < start_col:
                pending_ansi += ansi_result[0]
            i += ansi_result[1]
            continue

        text_end = i
        while text_end < len(line) and not extract_ansi_code(line, text_end):
            text_end += 1

        for segment in _get_grapheme_clusters(line[i:text_end]):
            w = grapheme_width(segment)
            in_range = current_col >= start_col and current_col < end_col
            fits = not strict or current_col + w <= end_col

            if in_range and fits:
                if pending_ansi:
                    result += pending_ansi
                    pending_ansi = ""
                result += segment
                result_width += w

            current_col += w
            if current_col >= end_col:
                break

        i = text_end
        if current_col >= end_col:
            break

    return result, result_width


def extract_segments(
    line: str,
    before_end: int,
    after_start: int,
    after_len: int,
    strict_after: bool = False,
) -> dict[str, str | int]:
    """Extract 'before' and 'after' segments from a line in single pass.

    Used for overlay compositing where we need content before and after
    the overlay region. Preserves styling from before the overlay that
    should affect content after it.
    """
    global _pooled_style_tracker
    if _pooled_style_tracker is None:
        _pooled_style_tracker = AnsiCodeTracker()

    before = ""
    before_width = 0
    after = ""
    after_width = 0
    current_col = 0
    i = 0
    pending_ansi_before = ""
    after_started = False
    after_end = after_start + after_len

    # Track styling state so "after" inherits styling from before the overlay
    _pooled_style_tracker.clear()

    while i < len(line):
        ansi_result = extract_ansi_code(line, i)
        if ansi_result:
            # Track all SGR codes to know styling state at afterStart
            _pooled_style_tracker.process(ansi_result[0])

            # Include ANSI codes in their respective segments
            if current_col < before_end:
                pending_ansi_before += ansi_result[0]
            elif current_col >= after_start and current_col < after_end and after_started:
                after += ansi_result[0]
            i += ansi_result[1]
            continue

        text_end = i
        while text_end < len(line) and not extract_ansi_code(line, text_end):
            text_end += 1

        for segment in _get_grapheme_clusters(line[i:text_end]):
            w = grapheme_width(segment)

            if current_col < before_end:
                if pending_ansi_before:
                    before += pending_ansi_before
                    pending_ansi_before = ""
                before += segment
                before_width += w
            elif current_col >= after_start and current_col < after_end:
                fits = not strict_after or current_col + w <= after_end
                if fits:
                    # On first "after" grapheme, prepend inherited styling from before overlay
                    if not after_started:
                        after += _pooled_style_tracker.get_active_codes()
                        after_started = True
                    after += segment
                    after_width += w

            current_col += w
            if after_len <= 0 and current_col >= before_end:
                break
            if after_len > 0 and current_col >= after_end:
                break

        i = text_end
        if after_len <= 0 and current_col >= before_end:
            break
        if after_len > 0 and current_col >= after_end:
            break

    return {
        "before": before,
        "beforeWidth": before_width,
        "after": after,
        "afterWidth": after_width,
    }


# =============================================================================
# Exports
# =============================================================================

__all__ = [
    "visible_width",
    "truncate_to_width",
    "wrap_text_with_ansi",
    "normalize_terminal_output",
    "extract_ansi_code",
    "grapheme_width",
    "is_whitespace_char",
    "is_punctuation_char",
    "apply_background_to_line",
    "slice_by_column",
    "slice_with_width",
    "extract_segments",
    "AnsiCodeTracker",
    "ActiveHyperlink",
]
