from pi_mono.utils.syntax_highlight import highlight, render_highlighted_html, supports_language


def test_highlight_escapes_code():
    result = highlight("<script>alert(1)</script>")
    assert "&lt;script&gt;" in result
    assert "<script>" not in result


def test_supports_language_returns_false():
    assert supports_language("python") is False
    assert supports_language("javascript") is False


def test_render_highlighted_html_applies_theme():
    html = '<span class="hljs-keyword">const</span> x'
    rendered = render_highlighted_html(
        html,
        {"keyword": lambda text: f"*{text}"},
    )
    assert rendered == "*const x"
