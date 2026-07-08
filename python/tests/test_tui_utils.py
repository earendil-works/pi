import re
from pi_mono.tui.utils import (
    visible_width,
    wrap_text_with_ansi,
    normalize_terminal_output,
    truncate_to_width,
    slice_by_column,
    extract_segments,
)


def test_visible_width_counts_tabs_inline_and_skips_ansi():
    assert visible_width("\t\x1b[31m界\x1b[0m") == 5


def test_visible_width_keeps_thai_and_lao_am_clusters():
    assert visible_width("ำ") == 1
    assert visible_width("ຳ") == 1
    assert visible_width("กำ") == 2
    assert visible_width("ກຳ") == 2


def test_normalize_terminal_output_thai_and_lao_am():
    assert normalize_terminal_output("ำ") == "ํา"
    assert normalize_terminal_output("ຳ") == "ໍາ"
    assert visible_width(normalize_terminal_output("ำabc")) == visible_width("ำabc")
    assert visible_width(normalize_terminal_output("ຳabc")) == visible_width("ຳabc")


def test_truncate_to_width_keeps_output_within_width():
    text = "🙂界" * 10000
    truncated = truncate_to_width(text, 40, "…")
    assert visible_width(truncated) <= 40
    assert truncated.endswith("…\x1b[0m")


def test_truncate_to_width_preserves_ansi_styling():
    text = f"\x1b[31m{'hello ' * 1000}\x1b[0m"
    truncated = truncate_to_width(text, 20, "…")
    assert visible_width(truncated) <= 20
    assert "\x1b[31m" in truncated
    assert truncated.endswith("\x1b[0m…\x1b[0m")


def test_truncate_to_width_handles_malformed_ansi():
    text = f"abc\x1bnot-ansi {'🙂' * 1000}"
    truncated = truncate_to_width(text, 20, "…")
    assert visible_width(truncated) <= 20


def test_truncate_to_width_clips_wide_ellipsis():
    assert truncate_to_width("abcdef", 1, "🙂") == ""
    assert truncate_to_width("abcdef", 2, "🙂") == "\x1b[0m🙂\x1b[0m"
    assert visible_width(truncate_to_width("abcdef", 2, "🙂")) <= 2


def test_truncate_to_width_original_fits():
    assert truncate_to_width("a", 2, "🙂") == "a"
    assert truncate_to_width("界", 2, "🙂") == "界"


def test_truncate_to_width_does_not_duplicate_ansi_wrapped_text():
    text = f"\x1b[38;2;102;102;102m{'~/projects/pi-mono/python (branch)'}\x1b[39m"
    truncated = truncate_to_width(text, 80, "\x1b[38;2;102;102;102m...\x1b[39m")
    assert truncated == text
    assert visible_width(truncated) <= 80


def test_truncate_to_width_pads_output():
    truncated = truncate_to_width("🙂界🙂界🙂界", 8, "…", True)
    assert visible_width(truncated) == 8


def test_truncate_to_width_adds_trailing_reset():
    truncated = truncate_to_width(f"\x1b[31m{'hello' * 100}", 10, "")
    assert visible_width(truncated) <= 10
    assert truncated.endswith("\x1b[0m")


def test_truncate_to_width_contiguous_prefix():
    truncated = truncate_to_width("🙂\t界 \x1b_abc\x07", 7, "…", True)
    assert truncated == "🙂\t\x1b[0m…\x1b[0m "


def test_wrap_text_with_ansi_underline_styling_not_preceding():
    underline_on = "\x1b[4m"
    underline_off = "\x1b[24m"
    url = "https://example.com/very/long/path/that/will/wrap"
    text = f"read this thread {underline_on}{url}{underline_off}"

    wrapped = wrap_text_with_ansi(text, 40)
    assert wrapped[0] == "read this thread"
    assert wrapped[1].startswith(underline_on)
    assert "https://" in wrapped[1]


def test_wrap_text_with_ansi_underline_styling_no_whitespace_before_reset():
    underline_on = "\x1b[4m"
    underline_off = "\x1b[24m"
    text = f"{underline_on}underlined text here {underline_off}more"

    wrapped = wrap_text_with_ansi(text, 18)
    assert f" {underline_off}" not in wrapped[0]


def test_wrap_text_with_ansi_underline_styling_no_bleed():
    underline_on = "\x1b[4m"
    underline_off = "\x1b[24m"
    url = "https://example.com/very/long/path/that/will/definitely/wrap"
    text = f"prefix {underline_on}{url}{underline_off} suffix"

    wrapped = wrap_text_with_ansi(text, 30)
    for i in range(1, len(wrapped) - 1):
        line = wrapped[i]
        if underline_on in line:
            assert line.endswith(underline_off)
            assert not line.endswith("\x1b[0m")


def test_wrap_text_with_ansi_background_color_preservation():
    bg_blue = "\x1b[44m"
    reset = "\x1b[0m"
    text = f"{bg_blue}hello world this is blue background text{reset}"

    wrapped = wrap_text_with_ansi(text, 15)
    for line in wrapped:
        assert bg_blue in line

    for i in range(len(wrapped) - 1):
        assert not wrapped[i].endswith("\x1b[0m")


def test_wrap_text_with_ansi_background_with_underline():
    underline_on = "\x1b[4m"
    underline_off = "\x1b[24m"
    reset = "\x1b[0m"
    text = (
        f"\x1b[41mprefix {underline_on}UNDERLINED_CONTENT_THAT_WRAPS{underline_off} suffix{reset}"
    )

    wrapped = wrap_text_with_ansi(text, 20)
    for line in wrapped:
        assert "[41m" in line or ";41m" in line or "[41;" in line

    for i in range(len(wrapped) - 1):
        line = wrapped[i]
        if ("[4m" in line or "[4;" in line or ";4m" in line) and underline_off not in line:
            assert line.endswith(underline_off)
            assert not line.endswith("\x1b[0m")


def test_wrap_text_with_ansi_basic():
    text = "hello world this is a test"
    wrapped = wrap_text_with_ansi(text, 10)
    assert len(wrapped) > 1
    for line in wrapped:
        assert visible_width(line) <= 10


def test_wrap_text_with_ansi_ignores_osc133():
    text = "\x1b]133;A\x07hello\x1b]133;B\x07"
    assert visible_width(text) == 5


def test_wrap_text_with_ansi_ignores_osc_terminated_with_st():
    text = "\x1b]133;A\x1b\\hello\x1b]133;B\x1b\\"
    assert visible_width(text) == 5


def test_wrap_text_with_ansi_treats_regional_indicators_as_width_2():
    assert visible_width("🇨") == 2
    assert visible_width("🇨🇳") == 2


def test_wrap_text_with_ansi_truncates_trailing_whitespace():
    two_spaces = wrap_text_with_ansi("  ", 1)
    assert visible_width(two_spaces[0]) <= 1


def test_wrap_text_with_ansi_preserves_color_codes():
    red = "\x1b[31m"
    reset = "\x1b[0m"
    text = f"{red}hello world this is red{reset}"

    wrapped = wrap_text_with_ansi(text, 10)
    for i in range(1, len(wrapped)):
        assert wrapped[i].startswith(red)
    for i in range(len(wrapped) - 1):
        assert not wrapped[i].endswith("\x1b[0m")


def test_wrap_text_with_ansi_osc8_hyperlinks_reopen():
    url = "https://example.com"
    input_str = f"\x1b]8;;{url}\x1b\\0123456789\x1b]8;;\x1b\\"
    lines = wrap_text_with_ansi(input_str, 6)

    for line in lines:
        stripped = (
            line.replace("\x1b]8;;", "").replace("\x1b\\", "").replace("\x1b[", "").replace("m", "")
        )
        if stripped.strip():
            assert url in line


def test_wrap_text_with_ansi_osc8_hyperlinks_close_before_break():
    url = "https://example.com"
    input_str = f"\x1b]8;;{url}\x1b\\0123456789\x1b]8;;\x1b\\"
    lines = wrap_text_with_ansi(input_str, 6)

    for i in range(len(lines) - 1):
        line = lines[i]
        if url in line:
            assert line.endswith("\x1b]8;;\x1b\\")


def test_wrap_text_with_ansi_osc8_hyperlinks_preserves_bel():
    url = f"https://example.com/oauth/{'a' * 32}"
    input_str = f"\x1b]8;;{url}\x07{url}\x1b]8;;\x07"
    lines = wrap_text_with_ansi(input_str, 20)

    assert len(lines) > 1
    for line in lines:
        assert f"\x1b]8;;{url}\x07" in line
        assert f"\x1b]8;;{url}\x1b\\" not in line
    for line in lines[:-1]:
        assert line.endswith("\x1b]8;;\x07")


def test_wrap_text_with_ansi_osc8_hyperlinks_no_extra_emits():
    url = "https://example.com"
    input_str = f"before \x1b]8;;{url}\x1b\\link\x1b]8;;\x1b\\ after"
    lines = wrap_text_with_ansi(input_str, 80)

    assert len(lines) == 1
    open_count = len(re.findall(r"\x1b\]8;;https:[^\x1b]+\x1b\\", lines[0]))
    close_count = len(re.findall(r"\x1b\]8;;\x1b\\", lines[0]))
    assert open_count == 1
    assert close_count == 1


def test_regression_regional_indicators_width_singleton():
    for cp in range(0x1F1E6, 0x1F200):
        regional_indicator = chr(cp)
        assert visible_width(regional_indicator) == 2


def test_regression_regional_indicators_width_flag_pairs():
    samples = ["🇯🇵", "🇺🇸", "🇬🇧", "🇨🇳", "🇩🇪", "🇫🇷"]
    for flag in samples:
        assert visible_width(flag) == 2


def test_regression_regional_indicators_width_common_emoji_intermediates():
    samples = ["👍", "👍🏻", "✅", "⚡", "⚡️", "👨", "👨‍💻", "🏳️‍🌈"]
    for sample in samples:
        assert visible_width(sample) == 2


def test_slice_by_column():
    text = "abc\x1b[31mdef\x1b[0mghi"
    # Column 3 to 6 is "def" with prepended "\x1b[31m". Slicing stops before processing trailing SGR \x1b[0m.
    assert slice_by_column(text, 3, 3) == "\x1b[31mdef"


def test_extract_segments():
    text = "abc\x1b[31mdef\x1b[0mghi"
    segs = extract_segments(text, 3, 6, 3)
    assert segs["before"] == "abc"
    assert segs["beforeWidth"] == 3
    # The reset \x1b[0m is at column 6, so "after" content "ghi" is reset and has no active SGR.
    assert segs["after"] == "ghi"
    assert segs["afterWidth"] == 3
