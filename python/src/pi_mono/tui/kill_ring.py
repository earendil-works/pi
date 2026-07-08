from typing import Optional


class KillRing:
    """
    Ring buffer for Emacs-style kill/yank operations.
    Tracks deleted text entries, merging consecutive edits.
    """

    def __init__(self) -> None:
        self.ring: list[str] = []

    def push(self, text: str, prepend: bool = False, accumulate: bool = False) -> None:
        """
        Add text to the kill ring.

        :param text: The killed text to add
        :param prepend: If accumulating, prepend instead of append
        :param accumulate: Merge with the most recent entry instead of creating a new one
        """
        if not text:
            return

        if accumulate and self.ring:
            last = self.ring.pop()
            self.ring.append(text + last if prepend else last + text)
        else:
            self.ring.append(text)

    def peek(self) -> Optional[str]:
        """Get most recent entry without modifying the ring."""
        return self.ring[-1] if self.ring else None

    def rotate(self) -> None:
        """Move last entry to front (for yank-pop cycling)."""
        if len(self.ring) > 1:
            last = self.ring.pop()
            self.ring.insert(0, last)

    @property
    def length(self) -> int:
        return len(self.ring)
