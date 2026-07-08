from pi_mono.tui.word_navigation import (
    find_word_backward,
    find_word_forward,
    SegmentData,
    WordNavigationOptions,
)


def test_find_word_backward_basic():
    text = "hello world"
    assert find_word_backward(text, 11) == 6
    assert find_word_backward(text, 6) == 0


def test_find_word_backward_dotted():
    text = "foo.bar"
    assert find_word_backward(text, 7) == 4
    assert find_word_backward(text, 4) == 3
    assert find_word_backward(text, 3) == 0


def test_find_word_backward_colon():
    text = "foo:bar"
    assert find_word_backward(text, 7) == 4
    assert find_word_backward(text, 4) == 3
    assert find_word_backward(text, 3) == 0


def test_find_word_backward_path():
    text = "path/to/file"
    assert find_word_backward(text, 12) == 8
    assert find_word_backward(text, 8) == 7
    assert find_word_backward(text, 7) == 5
    assert find_word_backward(text, 5) == 4
    assert find_word_backward(text, 4) == 0


def test_find_word_backward_cjk():
    text = "你好世界 test"
    assert find_word_backward(text, len(text)) == 5
    assert find_word_backward(text, 5) == 2
    assert find_word_backward(text, 2) == 0


def test_find_word_backward_whitespace():
    text = "  hello  "
    assert find_word_backward(text, 9) == 2
    assert find_word_backward(text, 2) == 0


def test_find_word_backward_punctuation_run():
    text = "foo...bar"
    assert find_word_backward(text, 9) == 6
    assert find_word_backward(text, 6) == 3
    assert find_word_backward(text, 3) == 0


def test_find_word_backward_cursor_zero():
    assert find_word_backward("hello", 0) == 0


def test_find_word_forward_basic():
    text = "hello world"
    assert find_word_forward(text, 0) == 5
    assert find_word_forward(text, 5) == 11


def test_find_word_forward_dotted():
    text = "foo.bar"
    assert find_word_forward(text, 0) == 3
    assert find_word_forward(text, 3) == 4
    assert find_word_forward(text, 4) == 7


def test_find_word_forward_colon():
    text = "foo:bar"
    assert find_word_forward(text, 0) == 3
    assert find_word_forward(text, 3) == 4
    assert find_word_forward(text, 4) == 7


def test_find_word_forward_path():
    text = "path/to/file"
    assert find_word_forward(text, 0) == 4
    assert find_word_forward(text, 4) == 5
    assert find_word_forward(text, 5) == 7
    assert find_word_forward(text, 7) == 8
    assert find_word_forward(text, 8) == 12


def test_find_word_forward_cjk():
    text = "你好世界 test"
    first_end = find_word_forward(text, 0)
    assert first_end > 0
    assert first_end <= 4

    pos = 0
    while pos < len(text):
        nxt = find_word_forward(text, pos)
        if nxt == pos:
            break
        pos = nxt
    assert pos == len(text)


def test_find_word_forward_whitespace():
    text = "  hello  "
    assert find_word_forward(text, 0) == 7
    assert find_word_forward(text, 7) == 9


def test_find_word_forward_punctuation_run():
    text = "foo...bar"
    assert find_word_forward(text, 0) == 3
    assert find_word_forward(text, 3) == 6
    assert find_word_forward(text, 6) == 9


def test_find_word_forward_cursor_end():
    assert find_word_forward("hello", 5) == 5


def test_atomic_segments():
    marker = "[paste #1 +5 lines]"
    text = f"hello {marker} world"

    def is_atomic(s: str) -> bool:
        return s == marker

    segment_map = {
        text: [
            SegmentData("hello", 0, text, True),
            SegmentData(" ", 5, text, False),
            SegmentData(marker, 6, text, True),
            SegmentData(" ", 25, text, False),
            SegmentData("world", 26, text, True),
        ],
        text[: len(text)]: [
            SegmentData("hello", 0, text, True),
            SegmentData(" ", 5, text, False),
            SegmentData(marker, 6, text, True),
            SegmentData(" ", 25, text, False),
            SegmentData("world", 26, text, True),
        ],
        text[:26]: [
            SegmentData("hello", 0, text, True),
            SegmentData(" ", 5, text, False),
            SegmentData(marker, 6, text, True),
            SegmentData(" ", 25, text, False),
        ],
        text[6:]: [
            SegmentData(marker, 0, text, True),
            SegmentData(" ", 19, text, False),
            SegmentData("world", 20, text, True),
        ],
    }

    opts = WordNavigationOptions(
        segment=lambda inp: segment_map.get(inp, []),
        is_atomic_segment=is_atomic,
    )

    assert find_word_backward(text, len(text), opts) == 26
    assert find_word_backward(text, 26, opts) == 6
    assert find_word_forward(text, 6, opts) == 6 + len(marker)
