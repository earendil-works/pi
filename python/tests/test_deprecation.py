from pi_mono.utils.deprecation import (
    warn_deprecation,
    clear_deprecation_warnings_for_tests,
)


def test_warn_deprecation(capsys):
    clear_deprecation_warnings_for_tests()

    warn_deprecation("feature_a is deprecated")
    # Capturing stderr output
    captured = capsys.readouterr()
    assert "Deprecation warning: feature_a is deprecated" in captured.err
    assert "\033[33m" in captured.err  # check yellow color escape

    # Calling again with same message should not emit warning again
    warn_deprecation("feature_a is deprecated")
    captured2 = capsys.readouterr()
    assert captured2.err == ""


def test_clear_deprecation_warnings(capsys):
    clear_deprecation_warnings_for_tests()
    warn_deprecation("feature_b is deprecated")
    capsys.readouterr()

    # Clear and call again -> should emit warning again
    clear_deprecation_warnings_for_tests()
    warn_deprecation("feature_b is deprecated")
    captured = capsys.readouterr()
    assert "Deprecation warning: feature_b is deprecated" in captured.err
