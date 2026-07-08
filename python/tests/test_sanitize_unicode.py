from pi_mono.utils.sanitize_unicode import sanitize_surrogates


def test_sanitize_surrogates_preserves_valid_text():
    # ASCII text
    assert sanitize_surrogates("Hello World") == "Hello World"
    # German umlauts
    assert sanitize_surrogates("äöüß") == "äöüß"
    # Chinese/Japanese characters
    assert sanitize_surrogates("你好 こんにちは") == "你好 こんにちは"


def test_sanitize_surrogates_preserves_valid_emojis():
    # Valid emoji (properly paired surrogate in JS, single code point in Python)
    assert sanitize_surrogates("Hello 🙈 World") == "Hello 🙈 World"
    assert sanitize_surrogates("👍 ❤️ 🤔 🚀") == "👍 ❤️ 🤔 🚀"


def test_sanitize_surrogates_removes_unpaired_high_surrogates():
    # Unpaired high surrogate 0xD83D (55357)
    high_surrogate = "\ud83d"
    text = f"Text {high_surrogate} here"
    assert sanitize_surrogates(text) == "Text  here"


def test_sanitize_surrogates_removes_unpaired_low_surrogates():
    # Unpaired low surrogate 0xDE48 (56904)
    low_surrogate = "\ude48"
    text = f"Text {low_surrogate} here"
    assert sanitize_surrogates(text) == "Text  here"


def test_sanitize_surrogates_removes_multiple_unpaired_surrogates():
    # Mix of high and low unpaired surrogates
    text = "Start \ud83d middle \ude48 end"
    assert sanitize_surrogates(text) == "Start  middle  end"


def test_sanitize_surrogates_handles_empty_string():
    assert sanitize_surrogates("") == ""


def test_sanitize_surrogates_handles_mixed_emojis_and_unpaired_surrogates():
    text = "Valid 🙈 and unpaired high \ud83d and low \ude48 and thumbs up 👍"
    expected = "Valid 🙈 and unpaired high  and low  and thumbs up 👍"
    assert sanitize_surrogates(text) == expected
