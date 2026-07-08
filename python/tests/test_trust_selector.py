from pi_mono.coding_agent.modes.interactive.components.trust_selector import TrustSelectorComponent
from pi_mono.coding_agent.modes.interactive.interactive_mode import InteractiveMode


def test_trust_selector_marks_saved_decision() -> None:
    selected: list[bool] = []

    selector = TrustSelectorComponent(
        cwd="/tmp/project",
        saved_decision=None,
        project_trusted=False,
        on_select=lambda selection: selected.append(selection.trusted),
        on_cancel=lambda: None,
    )
    selector.handle_input("\n")
    assert selected == [True]


def test_get_path_command_argument_supports_quoted_paths() -> None:
    assert (
        InteractiveMode._get_path_command_argument(
            '/import "path with spaces/session.jsonl"', "/import"
        )
        == "path with spaces/session.jsonl"
    )
    assert (
        InteractiveMode._get_path_command_argument("/import john's/session.jsonl", "/import")
        == "john's/session.jsonl"
    )
    assert (
        InteractiveMode._get_path_command_argument("/important /tmp/session.jsonl", "/import")
        is None
    )
