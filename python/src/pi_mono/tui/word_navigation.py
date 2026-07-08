import re
from typing import Callable, Iterable, Iterator, Optional


class SegmentData:
    """
    Represents word-segment data returned by the word segmenter,
    emulating the JavaScript Intl.SegmentData structure.
    """

    def __init__(self, segment: str, index: int, input_str: str, is_word_like: bool):
        self.segment = segment
        self.index = index
        self.input = input_str
        self.isWordLike = is_word_like


class WordNavigationOptions:
    """
    Options for word navigation functions.
    """

    def __init__(
        self,
        segment: Optional[Callable[[str], Iterable[SegmentData]]] = None,
        is_atomic_segment: Optional[Callable[[str], bool]] = None,
    ):
        self.segment = segment
        self.is_atomic_segment = is_atomic_segment


# Match CJK unified ideographs in pairs first, then general Unicode word characters (\w+),
# whitespace (\s+), or any single character.
SEGMENT_RE = re.compile(r"([\u4e00-\u9fff]{1,2})|(\w+)|(\s+)|(.)", re.DOTALL)


def default_segment(text: str) -> Iterator[SegmentData]:
    """
    Default segmenter that emulates Intl.Segmenter with granularity="word".
    """
    for match in SEGMENT_RE.finditer(text):
        segment = match.group(0)
        is_word = (match.group(1) is not None) or (match.group(2) is not None)
        yield SegmentData(
            segment=segment,
            index=match.start(),
            input_str=text,
            is_word_like=is_word,
        )


PUNCTUATION_REGEX = re.compile(r"[(){}[\]<>.,;:'\"!?+\-=*/\\|&%^$#@~`]")


def is_whitespace_char(char: str) -> bool:
    """
    Check if a character/string is whitespace.
    """
    return bool(char and char.isspace())


def find_word_backward(
    text: str, cursor: int, options: Optional[WordNavigationOptions] = None
) -> int:
    """
    Find the cursor position after moving one word backward from `cursor` in `text`.
    Skips trailing whitespace, then stops at the next word/punctuation boundary.

    Pure function - does not mutate any state.
    """
    if cursor <= 0:
        return 0

    text_before_cursor = text[:cursor]
    segment_fn = options.segment if options else None
    is_atomic = options.is_atomic_segment if options else None

    if segment_fn:
        segments = list(segment_fn(text_before_cursor))
    else:
        segments = list(default_segment(text_before_cursor))

    new_cursor = cursor

    # Skip trailing whitespace
    while (
        segments
        and not (is_atomic(segments[-1].segment) if is_atomic else False)
        and is_whitespace_char(segments[-1].segment)
    ):
        new_cursor -= len(segments.pop().segment)

    if not segments:
        return new_cursor

    last = segments[-1]

    if is_atomic and is_atomic(last.segment):
        # Skip one atomic segment.
        new_cursor -= len(last.segment)
    elif last.isWordLike:
        # Skip inside one word-like segment, preserving ASCII punctuation boundaries.
        segment = last.segment
        matches = list(PUNCTUATION_REGEX.finditer(segment))
        if not matches:
            new_cursor -= len(segment)
        else:
            last_match = matches[-1]
            new_cursor -= len(segment) - last_match.end()
    else:
        # Skip non-word non-whitespace run (punctuation)
        while (
            segments
            and not (is_atomic(segments[-1].segment) if is_atomic else False)
            and not segments[-1].isWordLike
            and not is_whitespace_char(segments[-1].segment)
        ):
            new_cursor -= len(segments.pop().segment)

    return new_cursor


def find_word_forward(
    text: str, cursor: int, options: Optional[WordNavigationOptions] = None
) -> int:
    """
    Find the cursor position after moving one word forward from `cursor` in `text`.
    Skips leading whitespace, then stops at the next word/punctuation boundary.

    Pure function - does not mutate any state.
    """
    if cursor >= len(text):
        return len(text)

    text_after_cursor = text[cursor:]
    segment_fn = options.segment if options else None
    is_atomic = options.is_atomic_segment if options else None

    if segment_fn:
        segments = segment_fn(text_after_cursor)
    else:
        segments = default_segment(text_after_cursor)

    iterator = iter(segments)
    current_segment = next(iterator, None)
    new_cursor = cursor

    # Skip leading whitespace
    while (
        current_segment is not None
        and not (is_atomic(current_segment.segment) if is_atomic else False)
        and is_whitespace_char(current_segment.segment)
    ):
        new_cursor += len(current_segment.segment)
        current_segment = next(iterator, None)

    if current_segment is None:
        return new_cursor

    if is_atomic and is_atomic(current_segment.segment):
        # Skip one atomic segment.
        new_cursor += len(current_segment.segment)
    elif current_segment.isWordLike:
        # Skip inside one word-like segment, preserving ASCII punctuation boundaries.
        match = PUNCTUATION_REGEX.search(current_segment.segment)
        if match is not None:
            new_cursor += match.start()
        else:
            new_cursor += len(current_segment.segment)
    else:
        # Skip non-word non-whitespace run (punctuation)
        while (
            current_segment is not None
            and not (is_atomic(current_segment.segment) if is_atomic else False)
            and not current_segment.isWordLike
            and not is_whitespace_char(current_segment.segment)
        ):
            new_cursor += len(current_segment.segment)
            current_segment = next(iterator, None)

    return new_cursor
