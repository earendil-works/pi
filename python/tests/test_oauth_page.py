from pi_mono.ai.utils.oauth.oauth_page import oauth_error_html, oauth_success_html


def test_oauth_success_html_escapes_user_content():
    html = oauth_success_html('<script>alert("x")</script>')
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


def test_oauth_error_html_includes_details():
    html = oauth_error_html("Failed", 'detail & "quoted"')
    assert "Authentication failed" in html
    assert "detail &amp; &quot;quoted&quot;" in html
