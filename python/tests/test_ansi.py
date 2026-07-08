import pytest
from pi_mono.utils.ansi import strip_ansi


def test_strip_ansi_plain():
    assert strip_ansi("hello world") == "hello world"
    assert strip_ansi("") == ""


def test_strip_ansi_type_error():
    with pytest.raises(TypeError):
        strip_ansi(123)  # type: ignore


def test_strip_ansi_color_codes():
    assert strip_ansi("\u001b[31mred\u001b[0m") == "red"
    assert strip_ansi("\u001b[4;32mgreen bold underline\u001b[0m") == "green bold underline"
    assert strip_ansi("\u001b[1m\u001b[31mhello\u001b[0m") == "hello"


def test_strip_ansi_osc_codes():
    # OSC sequence like link: ESC ] 8 ; ; url ESC \ text ESC ] 8 ; ; ESC \
    link = "\u001b]8;;http://example.com\u001b\\link\u001b]8;;\u001b\\"
    assert strip_ansi(link) == "link"
