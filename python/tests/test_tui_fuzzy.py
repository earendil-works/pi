from pi_mono.tui.fuzzy import fuzzy_match, fuzzy_filter


def test_fuzzy_match_empty_query():
    result = fuzzy_match("", "anything")
    assert result.matches is True
    assert result.score == 0.0


def test_fuzzy_match_query_longer_than_text():
    result = fuzzy_match("longquery", "short")
    assert result.matches is False


def test_fuzzy_match_exact_match():
    result = fuzzy_match("test", "test")
    assert result.matches is True
    assert result.score < 0.0


def test_fuzzy_match_character_order():
    match_in_order = fuzzy_match("abc", "aXbXc")
    assert match_in_order.matches is True

    match_out_of_order = fuzzy_match("abc", "cba")
    assert match_out_of_order.matches is False


def test_fuzzy_match_case_insensitivity():
    result1 = fuzzy_match("ABC", "abc")
    assert result1.matches is True

    result2 = fuzzy_match("abc", "ABC")
    assert result2.matches is True


def test_fuzzy_match_consecutive_vs_scattered():
    consecutive = fuzzy_match("foo", "foobar")
    scattered = fuzzy_match("foo", "f_o_o_bar")

    assert consecutive.matches is True
    assert scattered.matches is True
    assert consecutive.score < scattered.score


def test_fuzzy_match_word_boundary():
    at_boundary = fuzzy_match("fb", "foo-bar")
    not_at_boundary = fuzzy_match("fb", "afbx")

    assert at_boundary.matches is True
    assert not_at_boundary.matches is True
    assert at_boundary.score < not_at_boundary.score


def test_fuzzy_match_swapped_alpha_numeric():
    result = fuzzy_match("codex52", "gpt-5.2-codex")
    assert result.matches is True


def test_fuzzy_filter_empty_query():
    items = ["apple", "banana", "cherry"]
    result = fuzzy_filter(items, "", lambda x: x)
    assert result == items


def test_fuzzy_filter_filtering():
    items = ["apple", "banana", "cherry"]
    result = fuzzy_filter(items, "an", lambda x: x)
    assert "banana" in result
    assert "apple" not in result
    assert "cherry" not in result


def test_fuzzy_filter_sorting():
    items = ["a_p_p", "app", "application"]
    result = fuzzy_filter(items, "app", lambda x: x)
    assert result[0] == "app"


def test_fuzzy_filter_exact_priority():
    items = ["clone", "cl"]
    result = fuzzy_filter(items, "cl", lambda x: x)
    assert result == ["cl", "clone"]


def test_fuzzy_filter_custom_get_text():
    items = [
        {"name": "foo", "id": 1},
        {"name": "bar", "id": 2},
        {"name": "foobar", "id": 3},
    ]
    result = fuzzy_filter(items, "foo", lambda item: item["name"])
    assert len(result) == 2
    names = [r["name"] for r in result]
    assert "foo" in names
    assert "foobar" in names
