from pi_mono.coding_agent.core.tools.render_utils import (
    get_text_output,
    render_tool_path,
    shorten_path,
)
from pi_mono.coding_agent.core.tools.tool_renderers import render_tool_call, render_tool_result


def test_shorten_path_expands_home() -> None:
    assert shorten_path("/home/user/file") == "/home/user/file"
    assert shorten_path("~/file").startswith("~")


def test_render_tool_path_resolves_relative(tmp_path) -> None:
    cwd = str(tmp_path)
    rendered = render_tool_path("foo.txt", cwd)
    assert "foo.txt" in rendered


def test_get_text_output_extracts_text() -> None:
    result = {"content": [{"type": "text", "text": "hello"}]}
    assert get_text_output(result) == "hello"


def test_get_text_output_image_placeholder_when_hidden() -> None:
    result = {
        "content": [
            {"type": "text", "text": "note"},
            {"type": "image", "mimeType": "image/png", "data": "abc"},
        ]
    }
    assert get_text_output(result, show_images=True) == "note"
    assert get_text_output(result, show_images=False) == "note\n[image: image/png]"


def test_render_tool_call_read() -> None:
    text = render_tool_call("read", {"path": "README.md"}, ".", expanded=False)
    assert "read" in text
    assert "README.md" in text


def test_render_tool_result_edit_diff() -> None:
    result = {
        "content": [{"type": "text", "text": "ok"}],
        "details": {"diff": "@@\n-old\n+new"},
    }
    text = render_tool_result("edit", {"path": "a.py"}, result, ".", expanded=False, is_error=False)
    assert "old" in text or "new" in text
