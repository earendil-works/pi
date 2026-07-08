import copy
from typing import Generic, TypeVar, Optional

T = TypeVar("T")


class UndoStack(Generic[T]):
    """
    Generic undo stack with deep copy semantics.
    Stores copy.deepcopy snapshots of states.
    """

    def __init__(self) -> None:
        self._stack: list[T] = []

    def push(self, state: T) -> None:
        """Push a deep copy of the given state onto the stack."""
        self._stack.append(copy.deepcopy(state))

    def pop(self) -> Optional[T]:
        """Pop and return the most recent snapshot, or None if empty."""
        if not self._stack:
            return None
        return self._stack.pop()

    def clear(self) -> None:
        """Remove all snapshots."""
        self._stack.clear()

    @property
    def length(self) -> int:
        return len(self._stack)
