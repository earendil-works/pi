from pi_mono.coding_agent.core.agent_session import parse_skill_block


def test_parse_skill_block_with_user_message() -> None:
    text = (
        '<skill name="lint" location="project">\n'
        "Run the linter.\n"
        "</skill>\n\n"
        "Please fix issues."
    )
    block = parse_skill_block(text)
    assert block is not None
    assert block["name"] == "lint"
    assert block["location"] == "project"
    assert "Run the linter." in block["content"]
    assert block["userMessage"] == "Please fix issues."


def test_parse_skill_block_without_user_message() -> None:
    text = '<skill name="lint" location="project">\nRun the linter.\n</skill>'
    block = parse_skill_block(text)
    assert block is not None
    assert block["userMessage"] is None


def test_parse_skill_block_rejects_plain_text() -> None:
    assert parse_skill_block("hello") is None
