import os
from pi_mono.tui.terminal_image import (
    TerminalCapabilities,
    CellDimensions,
    ImageDimensions,
    is_image_line,
    detect_capabilities,
    encode_kitty,
    delete_kitty_image,
    delete_all_kitty_images,
    render_image,
    set_capabilities,
    set_cell_dimensions,
    reset_capabilities_cache,
    hyperlink,
    get_png_dimensions,
    get_gif_dimensions,
)

ENV_KEYS = [
    "TERM",
    "TERM_PROGRAM",
    "TERMINAL_EMULATOR",
    "COLORTERM",
    "TMUX",
    "KITTY_WINDOW_ID",
    "GHOSTTY_RESOURCES_DIR",
    "WEZTERM_PANE",
    "ITERM_SESSION_ID",
    "WT_SESSION",
    "CMUX_WORKSPACE_ID",
]


class with_env:
    def __init__(self, overrides):
        self.overrides = overrides
        self.saved = {}

    def __enter__(self):
        for key in ENV_KEYS:
            self.saved[key] = os.environ.get(key)
            if key in os.environ:
                del os.environ[key]
        for k, v in self.overrides.items():
            if v is None:
                if k in os.environ:
                    del os.environ[k]
            else:
                os.environ[k] = v

    def __exit__(self, exc_type, exc_val, exc_tb):
        for key in ENV_KEYS:
            val = self.saved[key]
            if val is None:
                if key in os.environ:
                    del os.environ[key]
            else:
                os.environ[key] = val


def test_is_image_line_iterm2():
    iterm2_line = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07"
    assert is_image_line(iterm2_line) is True

    line_with_text = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text"
    assert is_image_line(line_with_text) is True


def test_is_image_line_kitty():
    kitty_line = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\"
    assert is_image_line(kitty_line) is True


def test_is_image_line_negative():
    assert is_image_line("Just plain text") is False
    assert is_image_line("\x1b[31mRed text\x1b[0m") is False


def test_detect_capabilities_default():
    with with_env({}):
        caps = detect_capabilities()
        assert caps.hyperlinks is False
        assert caps.images is None


def test_detect_capabilities_tmux_hyperlinks():
    with with_env({"TMUX": "/tmp/tmux/default,1234,0", "TERM_PROGRAM": "ghostty"}):
        caps = detect_capabilities(lambda: True)
        assert caps.hyperlinks is True
        assert caps.images is None

        caps2 = detect_capabilities(lambda: False)
        assert caps2.hyperlinks is False


def test_detect_capabilities_ghostty():
    with with_env({"TERM_PROGRAM": "ghostty"}):
        caps = detect_capabilities()
        assert caps.hyperlinks is True
        assert caps.images == "kitty"


def test_detect_capabilities_iterm2():
    with with_env({"TERM_PROGRAM": "iterm.app"}):
        caps = detect_capabilities()
        assert caps.hyperlinks is True
        assert caps.images == "iterm2"


def test_kitty_cursor_movement_opt_out():
    seq = encode_kitty("AAAA", {"columns": 2, "rows": 2, "moveCursor": False})
    assert seq.startswith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;")


def test_kitty_delete_suppresses_reply():
    assert delete_kitty_image(42) == "\x1b_Ga=d,d=I,i=42,q=2\x1b\\"
    assert delete_all_kitty_images() == "\x1b_Ga=d,d=A,q=2\x1b\\"


def test_render_image_kitty():
    set_capabilities(TerminalCapabilities("kitty", True, True))
    set_cell_dimensions(CellDimensions(10, 10))
    try:
        res = render_image("AAAA", ImageDimensions(20, 20), {"maxWidthCells": 2})
        assert res is not None
        assert "C=1" not in res["sequence"]
        assert res["rows"] == 2
    finally:
        reset_capabilities_cache()
        set_cell_dimensions(CellDimensions(9, 18))


def test_hyperlink_formatting():
    res = hyperlink("click me", "https://example.com")
    assert res == "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\"


def test_png_dimensions_parsing():
    # Base64 for a 1x1 transparent PNG
    png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    dims = get_png_dimensions(png_b64)
    assert dims is not None
    assert dims.widthPx == 1
    assert dims.heightPx == 1


def test_gif_dimensions_parsing():
    # Base64 for a 1x1 transparent GIF
    gif_b64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    dims = get_gif_dimensions(gif_b64)
    assert dims is not None
    assert dims.widthPx == 1
    assert dims.heightPx == 1
