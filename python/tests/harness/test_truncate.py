from pi_mono.agent.harness.utils.truncate import truncateHead, truncateTail


def byte_length(content: str) -> int:
    return len(content.encode("utf-8", errors="surrogatepass"))


def buffer_tail(content: str, max_bytes: int) -> str:
    b = content.encode("utf-8", errors="surrogatepass")
    if len(b) <= max_bytes:
        return content
    start = len(b) - max_bytes
    while start < len(b) and (b[start] & 0xC0) == 0x80:
        start += 1
    return b[start:].decode("utf-8", errors="surrogatepass")


def assert_matches_buffer_tail(input_str: str, max_byte_values=None):
    total_bytes = byte_length(input_str)
    if max_byte_values is None:
        values = list(range(total_bytes + 5))
    else:
        values = max_byte_values
    for max_bytes in values:
        result = truncateTail(input_str, {"maxBytes": max_bytes, "maxLines": 10})
        expected = buffer_tail(input_str, max_bytes)
        if result["content"] != expected:
            raise AssertionError(
                f"tail mismatch input={repr(input_str)} maxBytes={max_bytes} "
                f"expected={repr(expected)} actual={repr(result['content'])}"
            )
        output_bytes = byte_length(result["content"])
        if output_bytes > max_bytes:
            raise AssertionError(
                f"tail output exceeded byte limit input={repr(input_str)} "
                f"maxBytes={max_bytes} outputBytes={output_bytes}"
            )


def sampled_byte_limits(input_str: str) -> list[int]:
    total_bytes = byte_length(input_str)
    candidates = [
        0,
        1,
        2,
        3,
        4,
        5,
        8,
        (total_bytes // 2) - 1,
        total_bytes // 2,
        (total_bytes // 2) + 1,
        total_bytes - 8,
        total_bytes - 5,
        total_bytes - 4,
        total_bytes - 3,
        total_bytes - 2,
        total_bytes - 1,
        total_bytes,
        total_bytes + 1,
        total_bytes + 4,
    ]
    filtered = sorted(list(set([v for v in candidates if v >= 0])))
    return filtered


def test_counts_utf8_bytes_without_node_buffer():
    content = "aé🙂\nb"
    result = truncateHead(content, {"maxBytes": 100, "maxLines": 10})

    assert result["truncated"] is False
    assert result["totalBytes"] == byte_length(content)
    assert result["outputBytes"] == byte_length(content)
    assert result["totalBytes"] == 9


def test_truncates_head_on_utf8_byte_limits_without_partial_lines():
    content = "éé\nabc"
    result = truncateHead(content, {"maxBytes": 4, "maxLines": 10})

    assert result["content"] == "éé"
    assert result["truncated"] is True
    assert result["truncatedBy"] == "bytes"
    assert result["outputBytes"] == 4
    assert result["firstLineExceedsLimit"] is False


def test_reports_head_truncation_when_the_first_line_exceeds_the_byte_limit():
    result = truncateHead("éé\nabc", {"maxBytes": 3, "maxLines": 10})

    assert result["content"] == ""
    assert result["truncated"] is True
    assert result["truncatedBy"] == "bytes"
    assert result["firstLineExceedsLimit"] is True


def test_truncates_tail_on_utf8_boundaries_when_only_a_partial_last_line_fits():
    result = truncateTail("aé🙂b", {"maxBytes": 5, "maxLines": 10})

    assert result["content"] == "🙂b"
    assert result["truncated"] is True
    assert result["truncatedBy"] == "bytes"
    assert result["lastLinePartial"] is True
    assert result["outputBytes"] == 5


def test_truncates_an_oversized_single_line_with_a_trailing_newline():
    input_str = f"{'X' * 300_000}\n"
    result = truncateTail(input_str, {"maxBytes": 1024, "maxLines": 100})

    assert result["content"] == "X" * 1024
    assert result["outputBytes"] == 1024
    assert result["outputLines"] == 1
    assert result["lastLinePartial"] is True
    assert result["truncatedBy"] == "bytes"


def test_drops_an_oversized_trailing_character_when_it_cannot_fit_in_tail_byte_limit():
    result = truncateTail("abc🙂", {"maxBytes": 3, "maxLines": 10})

    assert result["content"] == ""
    assert result["truncated"] is True
    assert result["truncatedBy"] == "bytes"
    assert result["lastLinePartial"] is True
    assert result["outputBytes"] == 0


def test_matches_buffer_tail_truncation_semantics_for_surrogate_edge_cases():
    inputs = ["a\ud83d", "\ude42b", "a\ude42b", "\ud83d\ud83d\ude42", "\ud83d\ude42\ude42", "👩‍💻"]
    for input_str in inputs:
        assert_matches_buffer_tail(input_str)


def test_matches_buffer_tail_truncation_semantics_across_deterministic_fuzz_cases():
    alphabet = [
        "a",
        "\u007f",
        "\u0080",
        "é",
        "\u07ff",
        "\u0800",
        "中",
        "\ud7ff",
        "\ud800",
        "\ud83d",
        "\udc00",
        "\ude42",
        "🙂",
        "\ue000",
        "\uffff",
    ]

    def check_exhaustive(prefix: str, depth: int):
        assert_matches_buffer_tail(prefix, sampled_byte_limits(prefix))
        if depth == 0:
            return
        for character in alphabet:
            check_exhaustive(prefix + character, depth - 1)

    check_exhaustive("", 3)

    seed = 0x12345678

    def random():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 0x100000000

    for _ in range(1000):
        input_str = ""
        length = int(random() * 80)
        for _ in range(length):
            input_str += alphabet[int(random() * len(alphabet))]
        assert_matches_buffer_tail(input_str, sampled_byte_limits(input_str))
