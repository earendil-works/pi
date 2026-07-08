"""Editor component interface for custom editor implementations.

Ported from TypeScript's editor-component.ts as a Python Protocol.
"""

from __future__ import annotations

from typing import Callable, Optional, Protocol

if False:  # TYPE_CHECKING
    from .autocomplete import AutocompleteProvider


class EditorComponent(Protocol):
    """Interface for custom editor components.

    This allows extensions to provide their own editor implementation
    (e.g., vim mode, emacs mode, custom keybindings) while maintaining
    compatibility with the core application.
    """

    # =========================================================================
    # Core text access (required)
    # =========================================================================

    def get_text(self) -> str:
        """Get the current text content."""
        ...

    def set_text(self, text: str) -> None:
        """Set the text content."""
        ...

    def handle_input(self, data: str) -> None:
        """Handle raw terminal input (key presses, paste sequences, etc.)."""
        ...

    # =========================================================================
    # Callbacks (optional)
    # =========================================================================

    on_submit: Optional[Callable[[str], None]] = None
    """Called when user submits (e.g., Enter key)."""

    on_change: Optional[Callable[[str], None]] = None
    """Called when text changes."""

    # =========================================================================
    # History support (optional)
    # =========================================================================

    def add_to_history(self, text: str) -> None:
        """Add text to history for up/down navigation."""
        ...

    # =========================================================================
    # Advanced text manipulation (optional)
    # =========================================================================

    def insert_text_at_cursor(self, text: str) -> None:
        """Insert text at current cursor position."""
        ...

    def get_expanded_text(self) -> str:
        """Get text with any markers expanded (e.g., paste markers).

        Falls back to get_text() if not implemented.
        """
        ...

    # =========================================================================
    # Autocomplete support (optional)
    # =========================================================================

    def set_autocomplete_provider(self, provider: "AutocompleteProvider") -> None:
        """Set the autocomplete provider."""
        ...

    # =========================================================================
    # Appearance (optional)
    # =========================================================================

    @property
    def border_color(self) -> Optional[Callable[[str], str]]:
        """Border color function."""
        ...

    @border_color.setter
    def border_color(self, value: Optional[Callable[[str], str]]) -> None: ...

    def set_padding_x(self, padding: int) -> None:
        """Set horizontal padding."""
        ...

    def set_autocomplete_max_visible(self, max_visible: int) -> None:
        """Set max visible items in autocomplete dropdown."""
        ...

    # =========================================================================
    # Component interface (from tui.Component)
    # =========================================================================

    def render(self, width: int) -> list[str]:
        """Render the component to lines for the given viewport width."""
        ...

    wants_key_release: bool = False
    """If True, component receives key release events (Kitty protocol)."""

    def invalidate(self) -> None:
        """Invalidate any cached rendering state."""
        ...


# Base class that implements the protocol with default methods
class BaseEditorComponent:
    """Base implementation of EditorComponent with default no-op methods."""

    on_submit: Optional[Callable[[str], None]] = None
    on_change: Optional[Callable[[str], None]] = None

    def get_text(self) -> str:
        return ""

    def set_text(self, text: str) -> None:
        pass

    def handle_input(self, data: str) -> None:
        pass

    def add_to_history(self, text: str) -> None:
        pass

    def insert_text_at_cursor(self, text: str) -> None:
        pass

    def get_expanded_text(self) -> str:
        return self.get_text()

    def set_autocomplete_provider(self, provider: "AutocompleteProvider") -> None:
        pass

    @property
    def border_color(self) -> Optional[Callable[[str], str]]:
        return None

    @border_color.setter
    def border_color(self, value: Optional[Callable[[str], str]]) -> None:
        pass

    def set_padding_x(self, padding: int) -> None:
        pass

    def set_autocomplete_max_visible(self, max_visible: int) -> None:
        pass

    def render(self, width: int) -> list[str]:
        return []

    wants_key_release: bool = False

    def invalidate(self) -> None:
        pass


from pi_mono.tui.tui import Component  # noqa: E402  # re-export for TUI components

__all__ = ["BaseEditorComponent", "Component", "EditorComponent"]
