from pi_mono.tui.undo_stack import UndoStack


def test_undo_stack_basic():
    stack: UndoStack[dict[str, int]] = UndoStack()
    assert stack.length == 0
    assert stack.pop() is None

    state = {"value": 42}
    stack.push(state)
    assert stack.length == 1

    # Modify original state; it should not affect stack because of deep copy
    state["value"] = 99

    popped = stack.pop()
    assert popped == {"value": 42}
    assert stack.length == 0


def test_undo_stack_clear():
    stack: UndoStack[str] = UndoStack()
    stack.push("a")
    stack.push("b")
    assert stack.length == 2

    stack.clear()
    assert stack.length == 0
    assert stack.pop() is None
