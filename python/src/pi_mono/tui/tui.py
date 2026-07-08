"""Core TUI engine with differential rendering.

Ported from TypeScript's tui.ts - the main terminal UI engine managing:
- Input routing and listeners
- Overlay stack and focus management
- Differential rendering loop comparing previous vs new lines
- Hardware cursor positioning for IME support
"""

from __future__ import annotations

import asyncio
import os
import pathlib
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, List, Literal, Optional, Protocol, Set, Union

from .keys import is_key_release, matches_key
from .terminal_image import (
    CellDimensions,
    delete_kitty_image,
    get_capabilities,
    is_image_line,
    set_cell_dimensions,
)
from .terminal_colors import (
    TerminalColorScheme,
    is_osc11_background_color_response,
    parse_osc11_background_color,
    parse_terminal_color_scheme_report,
)
from .utils import (
    extract_segments,
    normalize_terminal_output,
    slice_by_column,
    slice_with_width,
    truncate_to_width,
    visible_width,
    wrap_text_with_ansi,
)

KITTY_SEQUENCE_PREFIX = "\x1b_G"
CURSOR_MARKER = "\x1b_pi:c\x07"


@dataclass
class _PendingOsc11BackgroundQuery:
    settled: bool
    future: asyncio.Future[Any]
    timer: Any | None


def extract_kitty_image_ids(line: str) -> List[int]:
    """Extract Kitty image IDs from a line."""
    sequence_start = line.find(KITTY_SEQUENCE_PREFIX)
    if sequence_start == -1:
        return []

    params_start = sequence_start + len(KITTY_SEQUENCE_PREFIX)
    params_end = line.find(";", params_start)
    if params_end == -1:
        return []

    params = line[params_start:params_end]
    for param in params.split(","):
        parts = param.split("=", 1)
        if len(parts) != 2:
            continue
        key, value = parts
        if key != "i":
            continue
        try:
            id = int(value)
            if id > 0 and id <= 0xFFFFFFFF:
                return [id]
        except ValueError:
            continue
    return []


# =============================================================================
# Type Definitions & Protocols
# =============================================================================


class Component(Protocol):
    """Component interface - all components must implement this."""

    def render(self, width: int) -> List[str]:
        """Render the component to lines for the given viewport width."""
        ...

    def handle_input(self, data: str) -> None:
        """Optional handler for keyboard input when component has focus."""
        ...

    wants_key_release: bool
    """If True, component receives key release events (Kitty protocol)."""

    def invalidate(self) -> None:
        """Invalidate any cached rendering state."""
        ...


class Focusable(Protocol):
    """Interface for components that can receive focus and display a hardware cursor."""

    focused: bool
    """Set by TUI when focus changes. Component should emit CURSOR_MARKER when True."""


def is_focusable(component: Optional[Component]) -> bool:
    """Type guard to check if a component implements Focusable."""
    return component is not None and hasattr(component, "focused")


# Cursor position marker - APC (Application Program Command) sequence
CURSOR_MARKER = "\x1b_pi:c\x07"


OverlayAnchor = Literal[  # type: ignore[valid-type]
    "center",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "top-center",
    "bottom-center",
    "left-center",
    "right-center",
]


@dataclass
class OverlayMargin:
    """Margin configuration for overlays."""

    top: int = 0
    right: int = 0
    bottom: int = 0
    left: int = 0


SizeValue = Union[int, str]  # number or "50%"


def parse_size_value(value: Optional[SizeValue], reference_size: int) -> Optional[int]:
    """Parse a SizeValue into absolute value given a reference size."""
    if value is None:
        return None
    if isinstance(value, int):
        return value
    # Parse percentage string like "50%"
    if isinstance(value, str):
        match = re.match(r"^(\d+(?:\.\d+)?)%$", value)
        if match:
            return int((reference_size * float(match.group(1))) / 100)
    return None


def is_termux_session() -> bool:
    """Check if running in Termux."""
    return bool(os.environ.get("TERMUX_VERSION"))


@dataclass
class OverlayOptions:
    """Options for overlay positioning and sizing."""

    # Sizing
    width: Optional[SizeValue] = None
    min_width: Optional[int] = None
    max_height: Optional[SizeValue] = None

    # Positioning - anchor-based
    anchor: Optional[OverlayAnchor] = None
    offset_x: Optional[int] = None
    offset_y: Optional[int] = None

    # Positioning - percentage or absolute
    row: Optional[SizeValue] = None
    col: Optional[SizeValue] = None

    # Margin from terminal edges
    margin: Optional[Union[OverlayMargin, int]] = None

    # Visibility
    visible: Optional[Callable[[int, int], bool]] = None
    non_capturing: bool = False


@dataclass
class OverlayUnfocusOptions:
    """Options for OverlayHandle.unfocus."""

    target: Optional[Component] = None


@dataclass
class OverlayHandle:
    """Handle returned by show_overlay for controlling the overlay."""

    hide: Callable[[], None]
    set_hidden: Callable[[bool], None]
    is_hidden: Callable[[], bool]
    focus: Callable[[], None]
    unfocus: Callable[[Optional[OverlayUnfocusOptions]], None]
    is_focused: Callable[[], bool]


@dataclass
class OverlayStackEntry:
    """Internal overlay stack entry."""

    component: Component
    options: Optional[OverlayOptions] = None
    pre_focus: Optional[Component] = None
    hidden: bool = False
    focus_order: int = 0


class EligibleOverlayFocusRestoreState:
    status: str = "eligible"
    overlay: OverlayStackEntry


class BlockedOverlayFocusRestoreState:
    status: str = "blocked"
    overlay: OverlayStackEntry
    blocked_by: Component
    resume: "OverlayBlockedFocusResume"


OverlayBlockedFocusResume = Union[
    Literal["restore-overlay"],
    dict,  # { "status": "focus-target", "target": Component | None }
]

OverlayFocusRestoreState = Union[
    Literal["inactive"],
    EligibleOverlayFocusRestoreState,
    BlockedOverlayFocusRestoreState,
]

OverlayFocusRestorePolicy = Union[Literal["clear"], Literal["preserve"]]


# =============================================================================
# Container Component
# =============================================================================


class Container:
    """Container - a component that contains other components."""

    def __init__(self):
        self.children: List[Component] = []

    def add_child(self, component: Component) -> None:
        self.children.append(component)

    def remove_child(self, component: Component) -> None:
        if component in self.children:
            self.children.remove(component)

    def clear(self) -> None:
        self.children.clear()

    def invalidate(self) -> None:
        for child in self.children:
            if hasattr(child, "invalidate"):
                child.invalidate()

    def render(self, width: int) -> List[str]:
        lines: List[str] = []
        for child in self.children:
            child_lines = child.render(width)
            if child_lines is None:
                raise TypeError(f"{type(child).__name__}.render() returned None")
            lines.extend(child_lines)
        return lines


# =============================================================================
# Terminal Protocol
# =============================================================================


class Terminal(Protocol):
    """Minimal terminal interface for TUI."""

    def start(self, on_input: Callable[[str], None], on_resize: Callable[[], None]) -> None: ...

    def stop(self) -> None: ...

    def drain_input(self, max_ms: int = 1000, idle_ms: int = 50) -> None: ...

    def write(self, data: str) -> None: ...

    @property
    def columns(self) -> int: ...

    @property
    def rows(self) -> int: ...

    @property
    def kittyProtocolActive(self) -> bool: ...

    def moveBy(self, lines: int) -> None: ...

    def hideCursor(self) -> None: ...

    def showCursor(self) -> None: ...

    def clearLine(self) -> None: ...

    def clearFromCursor(self) -> None: ...

    def clearScreen(self) -> None: ...

    def setTitle(self, title: str) -> None: ...

    def set_progress(self, active: bool) -> None: ...


# =============================================================================
# TUI Main Class
# =============================================================================


class TUI(Container):
    """TUI - Main class for managing terminal UI with differential rendering."""

    MIN_RENDER_INTERVAL_MS = 16
    SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07"

    def __init__(self, terminal: Terminal, show_hardware_cursor: Optional[bool] = None):
        super().__init__()
        self.terminal = terminal
        self.previous_lines: List[str] = []
        self.previous_kitty_image_ids: Set[int] = set()
        self.previous_width = 0
        self.previous_height = 0
        self.focused_component: Optional[Component] = None
        self.input_listeners: Set[Callable[[str], Optional[dict]]] = set()

        # Global callback for debug key (Shift+Ctrl+D)
        self.on_debug: Optional[Callable[[], None]] = None

        self.render_requested = False
        self.render_timer: Optional[Any] = None  # asyncio TimerHandle
        self.last_render_at = 0.0
        self.cursor_row = 0  # Logical cursor row (end of rendered content)
        self.hardware_cursor_row = 0  # Actual terminal cursor row
        self.show_hardware_cursor = os.environ.get("PI_HARDWARE_CURSOR") == "1"
        if show_hardware_cursor is not None:
            self.show_hardware_cursor = show_hardware_cursor
        self.clear_on_shrink = os.environ.get("PI_CLEAR_ON_SHRINK") == "1"
        self.max_lines_rendered = 0
        self.previous_viewport_top = 0
        self.full_redraw_count = 0
        self.stopped = False

        # Overlay stack for modal components rendered on top of base content
        self.focus_order_counter = 0
        self.overlay_stack: List[OverlayStackEntry] = []
        self.overlay_focus_restore: Union[
            Literal["inactive"],
            EligibleOverlayFocusRestoreState,
            BlockedOverlayFocusRestoreState,
        ] = "inactive"

        self.terminal_color_scheme_notifications_enabled = False
        self.terminal_color_scheme_listeners: Set[Callable[[TerminalColorScheme], None]] = set()
        self._pending_osc11_background_replies = 0
        self._pending_osc11_background_queries: List[_PendingOsc11BackgroundQuery] = []

    @property
    def full_redraws(self) -> int:
        return self.full_redraw_count

    def get_show_hardware_cursor(self) -> bool:
        return self.show_hardware_cursor

    def set_show_hardware_cursor(self, enabled: bool) -> None:
        if self.show_hardware_cursor == enabled:
            return
        self.show_hardware_cursor = enabled
        if not enabled:
            self.terminal.hideCursor()
        self.request_render()

    def get_clear_on_shrink(self) -> bool:
        return self.clear_on_shrink

    def set_clear_on_shrink(self, enabled: bool) -> None:
        self.clear_on_shrink = enabled

    # =========================================================================
    # Focus Management
    # =========================================================================

    def set_focus(self, component: Optional[Component]) -> None:
        self._set_focus_internal(component, "clear")

    def _set_focus_internal(
        self,
        component: Optional[Component],
        overlay_focus_restore: OverlayFocusRestorePolicy,
    ) -> None:
        previous_focus = self.focused_component
        next_focus = component

        previous_focused_overlay = None
        if previous_focus:
            for entry in self.overlay_stack:
                if entry.component == previous_focus and self._is_overlay_visible(entry):
                    previous_focused_overlay = entry
                    break

        next_focus_is_overlay = False
        if next_focus:
            for entry in self.overlay_stack:
                if entry.component == next_focus:
                    next_focus_is_overlay = True
                    break

        restore_state = self._get_visible_overlay_focus_restore()

        if next_focus and not next_focus_is_overlay:
            if (
                isinstance(restore_state, BlockedOverlayFocusRestoreState)
                and restore_state.blocked_by == previous_focus
            ):
                if restore_state.resume == "restore-overlay" or not self._is_component_mounted(
                    restore_state.blocked_by
                ):
                    next_focus = self._resolve_blocked_overlay_focus_resume(restore_state)
                else:
                    self.overlay_focus_restore = BlockedOverlayFocusRestoreState()
                    self.overlay_focus_restore.overlay = restore_state.overlay
                    self.overlay_focus_restore.blocked_by = next_focus
                    self.overlay_focus_restore.resume = restore_state.resume
            elif (
                previous_focused_overlay
                and restore_state != "inactive"
                and isinstance(restore_state, EligibleOverlayFocusRestoreState)
                and restore_state.overlay == previous_focused_overlay
                and not self._is_overlay_focus_ancestor(previous_focused_overlay, next_focus)
            ):
                self.overlay_focus_restore = BlockedOverlayFocusRestoreState()
                self.overlay_focus_restore.overlay = previous_focused_overlay
                self.overlay_focus_restore.blocked_by = next_focus
                self.overlay_focus_restore.resume = "restore-overlay"
        elif next_focus is None:
            if (
                isinstance(restore_state, BlockedOverlayFocusRestoreState)
                and restore_state.blocked_by == previous_focus
            ):
                next_focus = self._resolve_blocked_overlay_focus_resume(restore_state)
            elif overlay_focus_restore == "clear":
                self._clear_overlay_focus_restore()

        if is_focusable(self.focused_component):
            self.focused_component.focused = False

        self.focused_component = next_focus

        if is_focusable(next_focus):
            next_focus.focused = True

        focused_overlay = None
        if next_focus:
            for entry in self.overlay_stack:
                if entry.component == next_focus and self._is_overlay_visible(entry):
                    focused_overlay = entry
                    break

        if focused_overlay:
            self.overlay_focus_restore = EligibleOverlayFocusRestoreState()
            self.overlay_focus_restore.overlay = focused_overlay

    def _clear_overlay_focus_restore(self) -> None:
        self.overlay_focus_restore = "inactive"

    def _clear_overlay_focus_restore_for(self, overlay: OverlayStackEntry) -> None:
        if self.overlay_focus_restore != "inactive":
            if isinstance(self.overlay_focus_restore, EligibleOverlayFocusRestoreState):
                if self.overlay_focus_restore.overlay == overlay:
                    self._clear_overlay_focus_restore()
            elif isinstance(self.overlay_focus_restore, BlockedOverlayFocusRestoreState):
                if self.overlay_focus_restore.overlay == overlay:
                    self._clear_overlay_focus_restore()

    def _resolve_blocked_overlay_focus_resume(
        self,
        restore_state: BlockedOverlayFocusRestoreState,
    ) -> Optional[Component]:
        if restore_state.resume == "restore-overlay":
            return restore_state.overlay.component
        self._clear_overlay_focus_restore()
        if isinstance(restore_state.resume, dict):
            return restore_state.resume.get("target")
        return None

    def _get_visible_overlay_focus_restore(self) -> OverlayFocusRestoreState:
        restore_state = self.overlay_focus_restore
        if restore_state == "inactive":
            return "inactive"
        if isinstance(restore_state, EligibleOverlayFocusRestoreState):
            if restore_state.overlay not in self.overlay_stack or not self._is_overlay_visible(
                restore_state.overlay
            ):
                return "inactive"
            return restore_state
        if isinstance(restore_state, BlockedOverlayFocusRestoreState):
            if restore_state.overlay not in self.overlay_stack or not self._is_overlay_visible(
                restore_state.overlay
            ):
                return "inactive"
            return restore_state
        return "inactive"

    def _is_overlay_focus_ancestor(self, entry: OverlayStackEntry, component: Component) -> bool:
        visited: Set[Component] = set()
        current = entry.pre_focus
        while current and current not in visited:
            visited.add(current)
            if current == component:
                return True
            # Find overlay for current
            for overlay in self.overlay_stack:
                if overlay.component == current:
                    current = overlay.pre_focus
                    break
            else:
                current = None
        return False

    def _retarget_overlay_pre_focus(self, removed: OverlayStackEntry) -> None:
        for overlay in self.overlay_stack:
            if overlay != removed and overlay.pre_focus == removed.component:
                overlay.pre_focus = removed.pre_focus

    def _is_component_mounted(self, component: Component) -> bool:
        for child in self.children:
            if self._contains_component(child, component):
                return True
        return False

    def _contains_component(self, root: Component, target: Component) -> bool:
        if root == target:
            return True
        if isinstance(root, Container):
            for child in root.children:
                if self._contains_component(child, target):
                    return True
        return False

    # =========================================================================
    # Overlay Management
    # =========================================================================

    def show_overlay(
        self,
        component: Component,
        options: Optional[OverlayOptions] = None,
    ) -> OverlayHandle:
        entry = OverlayStackEntry(
            component=component,
            options=options,
            pre_focus=self.focused_component,
            hidden=False,
            focus_order=self.focus_order_counter + 1,
        )
        self.focus_order_counter += 1
        self.overlay_stack.append(entry)

        if not options or not options.non_capturing:
            if self._is_overlay_visible(entry):
                self.set_focus(component)

        self.terminal.hideCursor()
        self.request_render()

        def hide() -> None:
            idx = self.overlay_stack.index(entry) if entry in self.overlay_stack else -1
            if idx != -1:
                self._clear_overlay_focus_restore_for(entry)
                self._retarget_overlay_pre_focus(entry)
                self.overlay_stack.pop(idx)
                if self.focused_component == component:
                    top_visible = self._get_topmost_visible_overlay()
                    self.set_focus(top_visible.component if top_visible else entry.pre_focus)
                if not self.overlay_stack:
                    self.terminal.hideCursor()
                self.request_render()

        def set_hidden(hidden: bool) -> None:
            if entry.hidden == hidden:
                return
            entry.hidden = hidden
            if hidden:
                self._clear_overlay_focus_restore_for(entry)
                if self.focused_component == component:
                    top_visible = self._get_topmost_visible_overlay()
                    self.set_focus(top_visible.component if top_visible else entry.pre_focus)
            else:
                if not options or not options.non_capturing:
                    if self._is_overlay_visible(entry):
                        entry.focus_order = self.focus_order_counter + 1
                        self.focus_order_counter += 1
                        self.set_focus(component)
            self.request_render()

        def focus() -> None:
            if entry not in self.overlay_stack or not self._is_overlay_visible(entry):
                return
            entry.focus_order = self.focus_order_counter + 1
            self.focus_order_counter += 1
            self.set_focus(component)
            self.request_render()

        def unfocus(unfocus_options: Optional[OverlayUnfocusOptions] = None) -> None:
            is_focused = self.focused_component == component
            restore_state = self.overlay_focus_restore
            has_pending_restore = restore_state != "inactive" and (
                (
                    isinstance(restore_state, EligibleOverlayFocusRestoreState)
                    and restore_state.overlay == entry
                )
                or (
                    isinstance(restore_state, BlockedOverlayFocusRestoreState)
                    and restore_state.overlay == entry
                )
            )
            if not is_focused and not has_pending_restore:
                return

            if (
                isinstance(restore_state, BlockedOverlayFocusRestoreState)
                and restore_state.overlay == entry
                and self.focused_component == restore_state.blocked_by
            ):
                if unfocus_options:
                    self.overlay_focus_restore = BlockedOverlayFocusRestoreState()
                    self.overlay_focus_restore.overlay = entry
                    self.overlay_focus_restore.blocked_by = restore_state.blocked_by
                    self.overlay_focus_restore.resume = {
                        "status": "focus-target",
                        "target": unfocus_options.target,
                    }
                else:
                    self._clear_overlay_focus_restore()
                self.request_render()
                return

            self._clear_overlay_focus_restore_for(entry)
            if is_focused or unfocus_options:
                top_visible = self._get_topmost_visible_overlay()
                fallback_target = (
                    top_visible.component
                    if top_visible and top_visible != entry
                    else entry.pre_focus
                )
                self.set_focus(unfocus_options.target if unfocus_options else fallback_target)
            self.request_render()

        def is_focused() -> bool:
            return self.focused_component == component

        return OverlayHandle(
            hide=hide,
            set_hidden=set_hidden,
            is_hidden=lambda: entry.hidden,
            focus=focus,
            unfocus=unfocus,
            is_focused=is_focused,
        )

    def hide_overlay(self) -> None:
        if not self.overlay_stack:
            return
        overlay = self.overlay_stack[-1]
        self._clear_overlay_focus_restore_for(overlay)
        self._retarget_overlay_pre_focus(overlay)
        self.overlay_stack.pop()
        if self.focused_component == overlay.component:
            top_visible = self._get_topmost_visible_overlay()
            self.set_focus(top_visible.component if top_visible else overlay.pre_focus)
        if not self.overlay_stack:
            self.terminal.hideCursor()
        self.request_render()

    def has_overlay(self) -> bool:
        return any(self._is_overlay_visible(o) for o in self.overlay_stack)

    def _is_overlay_visible(self, entry: OverlayStackEntry) -> bool:
        if entry.hidden:
            return False
        if entry.options and entry.options.visible:
            return entry.options.visible(self.terminal.columns, self.terminal.rows)
        return True

    def _get_topmost_visible_overlay(self) -> Optional[OverlayStackEntry]:
        topmost = None
        for overlay in self.overlay_stack:
            if overlay.options and overlay.options.non_capturing:
                continue
            if not self._is_overlay_visible(overlay):
                continue
            if not topmost or overlay.focus_order > topmost.focus_order:
                topmost = overlay
        return topmost

    def invalidate(self) -> None:
        super().invalidate()
        for overlay in self.overlay_stack:
            if hasattr(overlay.component, "invalidate"):
                overlay.component.invalidate()

    # =========================================================================
    # Lifecycle
    # =========================================================================

    def start(self) -> None:
        self.stopped = False
        self.terminal.start(
            lambda data: self.handle_input(data),
            lambda: self.request_render(),
        )
        self.terminal.hideCursor()
        if self.terminal_color_scheme_notifications_enabled:
            self.terminal.write("\x1b[?2031h")
        self.query_cell_size()
        self.request_render()

    def add_input_listener(self, listener: Callable[[str], Optional[dict]]) -> Callable[[], None]:
        self.input_listeners.add(listener)
        return lambda: self.input_listeners.discard(listener)

    def remove_input_listener(self, listener: Callable[[str], Optional[dict]]) -> None:
        self.input_listeners.discard(listener)

    def on_terminal_color_scheme_change(
        self, listener: Callable[[TerminalColorScheme], None]
    ) -> Callable[[], None]:
        self.terminal_color_scheme_listeners.add(listener)
        return lambda: self.terminal_color_scheme_listeners.discard(listener)

    def set_terminal_color_scheme_notifications(self, enabled: bool) -> None:
        if self.terminal_color_scheme_notifications_enabled == enabled:
            return
        self.terminal_color_scheme_notifications_enabled = enabled
        if not self.stopped:
            self.terminal.write("\x1b[?2031h" if enabled else "\x1b[?2031l")

    async def query_terminal_background_color(self, *, timeout_ms: int = 100) -> Any | None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        query = _PendingOsc11BackgroundQuery(settled=False, future=future, timer=None)

        def settle(value: Any | None) -> None:
            if query.settled:
                return
            query.settled = True
            if query.timer is not None:
                query.timer.cancel()
                query.timer = None
            if not future.done():
                future.set_result(value)

        query.timer = loop.call_later(timeout_ms / 1000, lambda: settle(None))
        self._pending_osc11_background_queries.append(query)
        self._pending_osc11_background_replies += 1
        self.terminal.write("\x1b]11;?\x07")
        return await future

    async def query_terminal_color_scheme(
        self, *, timeout_ms: int = 100
    ) -> TerminalColorScheme | None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[TerminalColorScheme | None] = loop.create_future()
        settled = False
        timer: Any | None = None

        def settle(scheme: TerminalColorScheme | None) -> None:
            nonlocal settled, timer
            if settled:
                return
            settled = True
            if timer is not None:
                timer.cancel()
                timer = None
            unsubscribe()
            if not future.done():
                future.set_result(scheme)

        unsubscribe = self.on_terminal_color_scheme_change(settle)
        timer = loop.call_later(timeout_ms / 1000, lambda: settle(None))
        self.terminal.write("\x1b[?996n")
        return await future

    def query_cell_size(self) -> None:
        if not get_capabilities().images:
            return
        self.terminal.write("\x1b[16t")

    def stop(self) -> None:
        self.stopped = True
        if self.render_timer:
            self.render_timer.cancel()
            self.render_timer = None

        if self.terminal_color_scheme_notifications_enabled:
            self.terminal.write("\x1b[?2031l")

        if self.previous_lines:
            target_row = len(self.previous_lines)
            line_diff = target_row - self.hardware_cursor_row
            if line_diff > 0:
                self.terminal.write(f"\x1b[{line_diff}B")
            elif line_diff < 0:
                self.terminal.write(f"\x1b[{-line_diff}A")
            self.terminal.write("\r\n")

        self.terminal.showCursor()
        self.terminal.stop()

    async def drain_input(self, max_ms: int = 1000, idle_ms: int = 50) -> None:
        drain = getattr(self.terminal, "drainInput", None) or getattr(
            self.terminal, "drain_input", None
        )
        if drain is None:
            return
        result = drain(max_ms, idle_ms)
        if asyncio.iscoroutine(result):
            await result

    # =========================================================================
    # Rendering
    # =========================================================================

    def _get_loop(self) -> asyncio.AbstractEventLoop | None:
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            try:
                return asyncio.get_event_loop()
            except RuntimeError:
                return None

    def request_render(self, force: bool = False) -> None:
        if force:
            self.previous_lines = []
            self.previous_width = -1
            self.previous_height = -1
            self.cursor_row = 0
            self.hardware_cursor_row = 0
            self.max_lines_rendered = 0
            self.previous_viewport_top = 0
            if self.render_timer:
                self.render_timer.cancel()
                self.render_timer = None
            self.render_requested = True
            # Schedule on next event loop iteration
            loop = self._get_loop()
            if loop is not None:
                loop.call_soon(self._do_render_now)
            return

        if self.render_requested:
            return
        self.render_requested = True
        loop = self._get_loop()
        if loop is not None:
            loop.call_soon(self._schedule_render)

    def _schedule_render(self) -> None:
        if self.stopped or self.render_timer or not self.render_requested:
            return
        elapsed = (time.perf_counter() - self.last_render_at) * 1000
        delay = max(0, self.MIN_RENDER_INTERVAL_MS - elapsed) / 1000.0

        loop = self._get_loop()
        if loop is not None:
            self.render_timer = loop.call_later(delay, self._do_render_now)

    def _do_render_now(self) -> None:
        self.render_timer = None
        if self.stopped or not self.render_requested:
            return
        self.render_requested = False
        self.last_render_at = time.perf_counter()
        self.do_render()

        if self.render_requested:
            self._schedule_render()

    def handle_input(self, data: str) -> None:
        if self._consume_osc11_background_response(data):
            return
        if self._consume_terminal_color_scheme_report(data):
            return

        if self.input_listeners:
            current = data
            for listener in self.input_listeners:
                result = listener(current)
                if result and result.get("consume"):
                    return
                if result and "data" in result:
                    current = result["data"]
            if not current:
                return
            data = current

        if self.consume_cell_size_response(data):
            return

        if matches_key(data, "shift+ctrl+d") and self.on_debug:
            self.on_debug()
            return

        focused_overlay = None
        for entry in self.overlay_stack:
            if entry.component == self.focused_component:
                focused_overlay = entry
                break

        if focused_overlay and not self._is_overlay_visible(focused_overlay):
            top_visible = self._get_topmost_visible_overlay()
            if top_visible:
                self.set_focus(top_visible.component)
            else:
                self._set_focus_internal(focused_overlay.pre_focus, "preserve")

        focus_is_overlay = any(o.component == self.focused_component for o in self.overlay_stack)
        if not focus_is_overlay:
            restore_state = self._get_visible_overlay_focus_restore()
            if isinstance(restore_state, EligibleOverlayFocusRestoreState):
                self.set_focus(restore_state.overlay.component)
            elif (
                isinstance(restore_state, BlockedOverlayFocusRestoreState)
                and restore_state.blocked_by != self.focused_component
            ):
                if restore_state.resume == "restore-overlay":
                    self.set_focus(restore_state.overlay.component)
                else:
                    self._clear_overlay_focus_restore()
                    if isinstance(restore_state.resume, dict):
                        self.set_focus(restore_state.resume.get("target"))

        if self.focused_component and hasattr(self.focused_component, "handle_input"):
            if is_key_release(data) and not self.focused_component.wants_key_release:
                return
            self.focused_component.handle_input(data)
            self.request_render()

    def _consume_osc11_background_response(self, data: str) -> bool:
        if self._pending_osc11_background_replies <= 0:
            return False
        if not is_osc11_background_color_response(data):
            return False

        rgb = parse_osc11_background_color(data)
        self._pending_osc11_background_replies -= 1
        query = (
            self._pending_osc11_background_queries.pop(0)
            if self._pending_osc11_background_queries
            else None
        )
        if query is not None and not query.settled:
            query.settled = True
            if query.timer is not None:
                query.timer.cancel()
                query.timer = None
            if not query.future.done():
                query.future.set_result(rgb)
        return True

    def _consume_terminal_color_scheme_report(self, data: str) -> bool:
        scheme = parse_terminal_color_scheme_report(data)
        if scheme is None:
            return False
        for listener in list(self.terminal_color_scheme_listeners):
            listener(scheme)
        return True

    def consume_cell_size_response(self, data: str) -> bool:
        import re

        match = re.match(r"^\x1b\[6;(\d+);(\d+)t$", data)
        if not match:
            return False

        height_px = int(match.group(1))
        width_px = int(match.group(2))
        if height_px <= 0 or width_px <= 0:
            return True

        set_cell_dimensions(CellDimensions(width_px, height_px))
        self.invalidate()
        self.request_render()
        return True

    def _resolve_overlay_layout(
        self,
        options: Optional[OverlayOptions],
        overlay_height: int,
        term_width: int,
        term_height: int,
    ) -> dict:
        opt = options or {}

        # Parse margin
        if isinstance(opt.margin, int):
            margin = OverlayMargin(opt.margin, opt.margin, opt.margin, opt.margin)
        else:
            margin = opt.margin or OverlayMargin()

        margin_top = max(0, margin.top)
        margin_right = max(0, margin.right)
        margin_bottom = max(0, margin.bottom)
        margin_left = max(0, margin.left)

        avail_width = max(1, term_width - margin_left - margin_right)
        avail_height = max(1, term_height - margin_top - margin_bottom)

        # Resolve width
        width = parse_size_value(opt.width, term_width) or min(80, avail_width)
        if opt.min_width is not None:
            width = max(width, opt.min_width)
        width = max(1, min(width, avail_width))

        # Resolve maxHeight
        max_height = parse_size_value(opt.max_height, term_height)
        if max_height is not None:
            max_height = max(1, min(max_height, avail_height))

        effective_height = (
            min(overlay_height, max_height) if max_height is not None else overlay_height
        )

        # Resolve position
        if opt.row is not None:
            if isinstance(opt.row, str):
                match = opt.row.match(r"^(\d+(?:\.\d+)?)%$")
                if match:
                    max_row = max(0, avail_height - effective_height)
                    percent = float(match.group(1)) / 100
                    row = margin_top + int(max_row * percent)
                else:
                    row = self._resolve_anchor_row(
                        "center", effective_height, avail_height, margin_top
                    )
            else:
                row = opt.row
        else:
            anchor = opt.anchor or "center"
            row = self._resolve_anchor_row(anchor, effective_height, avail_height, margin_top)

        if opt.col is not None:
            if isinstance(opt.col, str):
                match = opt.col.match(r"^(\d+(?:\.\d+)?)%$")
                if match:
                    max_col = max(0, avail_width - width)
                    percent = float(match.group(1)) / 100
                    col = margin_left + int(max_col * percent)
                else:
                    col = self._resolve_anchor_col("center", width, avail_width, margin_left)
            else:
                col = opt.col
        else:
            anchor = opt.anchor or "center"
            col = self._resolve_anchor_col(anchor, width, avail_width, margin_left)

        if opt.offset_y is not None:
            row += opt.offset_y
        if opt.offset_x is not None:
            col += opt.offset_x

        row = max(margin_top, min(row, term_height - margin_bottom - effective_height))
        col = max(margin_left, min(col, term_width - margin_right - width))

        return {"width": width, "row": row, "col": col, "max_height": max_height}

    def _resolve_anchor_row(
        self, anchor: OverlayAnchor, height: int, avail_height: int, margin_top: int
    ) -> int:
        if anchor in ("top-left", "top-center", "top-right"):
            return margin_top
        if anchor in ("bottom-left", "bottom-center", "bottom-right"):
            return margin_top + avail_height - height
        return margin_top + (avail_height - height) // 2

    def _resolve_anchor_col(
        self, anchor: OverlayAnchor, width: int, avail_width: int, margin_left: int
    ) -> int:
        if anchor in ("top-left", "left-center", "bottom-left"):
            return margin_left
        if anchor in ("top-right", "right-center", "bottom-right"):
            return margin_left + avail_width - width
        return margin_left + (avail_width - width) // 2

    def composite_overlays(
        self,
        lines: List[str],
        term_width: int,
        term_height: int,
    ) -> List[str]:
        if not self.overlay_stack:
            return lines

        result = list(lines)
        rendered = []
        min_lines_needed = len(result)

        visible_entries = [e for e in self.overlay_stack if self._is_overlay_visible(e)]
        visible_entries.sort(key=lambda e: e.focus_order)

        for entry in visible_entries:
            component = entry.component
            options = entry.options

            # Get layout with height=0 first
            layout = self._resolve_overlay_layout(options, 0, term_width, term_height)
            width = layout["width"]
            max_height = layout["max_height"]

            # Render component
            overlay_lines = component.render(width)

            # Apply maxHeight
            if max_height is not None and len(overlay_lines) > max_height:
                overlay_lines = overlay_lines[:max_height]

            # Get final position with actual height
            final_layout = self._resolve_overlay_layout(
                options, len(overlay_lines), term_width, term_height
            )
            row = final_layout["row"]
            col = final_layout["col"]

            rendered.append({"overlay_lines": overlay_lines, "row": row, "col": col, "w": width})
            min_lines_needed = max(min_lines_needed, row + len(overlay_lines))

        working_height = max(len(result), term_height, min_lines_needed)

        while len(result) < working_height:
            result.append("")

        viewport_start = max(0, working_height - term_height)

        for r in rendered:
            overlay_lines = r["overlay_lines"]
            row = r["row"]
            col = r["col"]
            w = r["w"]
            for i, overlay_line in enumerate(overlay_lines):
                idx = viewport_start + row + i
                if 0 <= idx < len(result):
                    # Truncate overlay line to declared width
                    if visible_width(overlay_line) > w:
                        truncated = slice_by_column(overlay_line, 0, w, True)
                    else:
                        truncated = overlay_line
                    result[idx] = self._composite_line_at(
                        result[idx], truncated, col, w, term_width
                    )

        return result

    def _composite_line_at(
        self,
        base_line: str,
        overlay_line: str,
        start_col: int,
        overlay_width: int,
        total_width: int,
    ) -> str:
        if is_image_line(base_line):
            return base_line

        after_start = start_col + overlay_width
        base = extract_segments(base_line, start_col, after_start, total_width - after_start, True)
        overlay = slice_with_width(overlay_line, 0, overlay_width, True)

        before_pad = max(0, start_col - base["beforeWidth"])
        overlay_pad = max(0, overlay_width - overlay[1])
        actual_before_width = max(start_col, base["beforeWidth"])
        actual_overlay_width = max(overlay_width, overlay[1])
        after_target = max(0, total_width - actual_before_width - actual_overlay_width)
        after_pad = max(0, after_target - base["afterWidth"])

        r = self.SEGMENT_RESET
        result = (
            base["before"]
            + " " * before_pad
            + r
            + overlay[0]
            + " " * overlay_pad
            + r
            + base["after"]
            + " " * after_pad
        )

        # Verify and truncate if needed
        result_width = visible_width(result)
        if result_width <= total_width:
            return result
        return slice_by_column(result, 0, total_width, True)

    def _apply_line_resets(self, lines: List[str]) -> List[str]:
        reset = self.SEGMENT_RESET
        for i, line in enumerate(lines):
            if not is_image_line(line):
                lines[i] = normalize_terminal_output(line) + reset
        return lines

    def _collect_kitty_image_ids(self, lines: List[str]) -> Set[int]:
        ids = set()
        for line in lines:
            ids.update(extract_kitty_image_ids(line))
        return ids

    def _delete_kitty_images(self, ids: Set[int]) -> str:
        buffer = ""
        for id in ids:
            buffer += delete_kitty_image(id)
        return buffer

    def _expand_last_changed_for_kitty_images(self, first_changed: int, last_changed: int) -> int:
        expanded = last_changed
        for i in range(first_changed, len(self.previous_lines)):
            if extract_kitty_image_ids(self.previous_lines[i]):
                expanded = max(expanded, i)
        return expanded

    def _delete_changed_kitty_images(self, first_changed: int, last_changed: int) -> str:
        if first_changed < 0 or last_changed < first_changed:
            return ""
        ids = set()
        max_line = min(last_changed, len(self.previous_lines) - 1)
        for i in range(first_changed, max_line + 1):
            ids.update(extract_kitty_image_ids(self.previous_lines[i] or ""))
        return self._delete_kitty_images(ids)

    def _extract_cursor_position(self, lines: List[str], height: int) -> Optional[dict]:
        viewport_top = max(0, len(lines) - height)
        for row in range(len(lines) - 1, viewport_top - 1, -1):
            line = lines[row]
            marker_index = line.find(CURSOR_MARKER)
            if marker_index != -1:
                before_marker = line[:marker_index]
                col = visible_width(before_marker)
                # Strip marker
                lines[row] = line[:marker_index] + line[marker_index + len(CURSOR_MARKER) :]
                return {"row": row, "col": col}
        return None

    def do_render(self) -> None:
        if self.stopped:
            return

        width = self.terminal.columns
        height = self.terminal.rows
        width_changed = self.previous_width != 0 and self.previous_width != width
        height_changed = self.previous_height != 0 and self.previous_height != height

        previous_buffer_length = self.previous_viewport_top + (self.previous_height or height)
        prev_viewport_top = (
            max(0, previous_buffer_length - height)
            if height_changed
            else self.previous_viewport_top
        )
        viewport_top = prev_viewport_top
        hardware_cursor_row = self.hardware_cursor_row

        def compute_line_diff(target_row: int) -> int:
            current_screen_row = hardware_cursor_row - prev_viewport_top
            target_screen_row = target_row - viewport_top
            return target_screen_row - current_screen_row

        # Render all components
        new_lines = self.render(width)

        # Composite overlays
        if self.overlay_stack:
            new_lines = self.composite_overlays(new_lines, width, height)

        # Extract cursor position
        cursor_pos = self._extract_cursor_position(new_lines, height)

        # Apply line resets
        new_lines = self._apply_line_resets(new_lines)

        def full_render(clear: bool) -> None:
            self.full_redraw_count += 1
            buffer = "\x1b[?2026h"  # Begin synchronized output
            if clear:
                buffer += self._delete_kitty_images(self.previous_kitty_image_ids)
                buffer += "\x1b[2J\x1b[H\x1b[3J"  # Clear screen, home, clear scrollback
            for i, line in enumerate(new_lines):
                if i > 0:
                    buffer += "\r\n"
                buffer += line
            buffer += "\x1b[?2026l"  # End synchronized output
            self.terminal.write(buffer)
            self.cursor_row = max(0, len(new_lines) - 1)
            self.hardware_cursor_row = self.cursor_row
            if clear:
                self.max_lines_rendered = len(new_lines)
            else:
                self.max_lines_rendered = max(self.max_lines_rendered, len(new_lines))
            buffer_length = max(height, len(new_lines))
            self.previous_viewport_top = max(0, buffer_length - height)
            self._position_hardware_cursor(cursor_pos, len(new_lines))
            self.previous_lines = new_lines
            self.previous_kitty_image_ids = self._collect_kitty_image_ids(new_lines)
            self.previous_width = width
            self.previous_height = height

        debug_redraw = os.environ.get("PI_DEBUG_REDRAW") == "1"

        def log_redraw(reason: str) -> None:
            if not debug_redraw:
                return
            log_path = pathlib.Path.home() / ".pi" / "agent" / "pi-debug.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            msg = f"[{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())}] fullRender: {reason} (prev={len(self.previous_lines)}, new={len(new_lines)}, height={height})\n"
            with open(log_path, "a") as f:
                f.write(msg)

        # First render
        if not self.previous_lines and not width_changed and not height_changed:
            log_redraw("first render")
            full_render(False)
            return

        # Width changes
        if width_changed:
            log_redraw(f"terminal width changed ({self.previous_width} -> {width})")
            full_render(True)
            return

        # Height changes (skip for Termux)
        if height_changed and not is_termux_session():
            log_redraw(f"terminal height changed ({self.previous_height} -> {height})")
            full_render(True)
            return

        # Content shrunk
        if (
            self.clear_on_shrink
            and len(new_lines) < self.max_lines_rendered
            and not self.overlay_stack
        ):
            log_redraw(f"clearOnShrink (maxLinesRendered={self.max_lines_rendered})")
            full_render(True)
            return

        # Find changed lines
        first_changed = -1
        last_changed = -1
        max_lines = max(len(new_lines), len(self.previous_lines))
        for i in range(max_lines):
            old_line = self.previous_lines[i] if i < len(self.previous_lines) else ""
            new_line = new_lines[i] if i < len(new_lines) else ""
            if old_line != new_line:
                if first_changed == -1:
                    first_changed = i
                last_changed = i

        appended_lines = len(new_lines) > len(self.previous_lines)
        if appended_lines:
            if first_changed == -1:
                first_changed = len(self.previous_lines)
            last_changed = len(new_lines) - 1

        if first_changed != -1:
            last_changed = self._expand_last_changed_for_kitty_images(first_changed, last_changed)

        append_start = (
            appended_lines and first_changed == len(self.previous_lines) and first_changed > 0
        )

        # No changes
        if first_changed == -1:
            self._position_hardware_cursor(cursor_pos, len(new_lines))
            self.previous_viewport_top = prev_viewport_top
            self.previous_height = height
            return

        # All changes in deleted lines
        if first_changed >= len(new_lines):
            if len(self.previous_lines) > len(new_lines):
                buffer = "\x1b[?2026h"
                buffer += self._delete_changed_kitty_images(first_changed, last_changed)
                target_row = max(0, len(new_lines) - 1)
                if target_row < prev_viewport_top:
                    log_redraw(
                        f"deleted lines moved viewport up ({target_row} < {prev_viewport_top})"
                    )
                    full_render(True)
                    return
                line_diff = compute_line_diff(target_row)
                if line_diff > 0:
                    buffer += f"\x1b[{line_diff}B"
                elif line_diff < 0:
                    buffer += f"\x1b[{-line_diff}A"
                buffer += "\r"
                extra_lines = len(self.previous_lines) - len(new_lines)
                if extra_lines > height:
                    log_redraw(f"extraLines > height ({extra_lines} > {height})")
                    full_render(True)
                    return
                if extra_lines > 0:
                    buffer += "\x1b[1B"
                for i in range(extra_lines):
                    buffer += "\r\x1b[2K"
                    if i < extra_lines - 1:
                        buffer += "\x1b[1B"
                if extra_lines > 0:
                    buffer += f"\x1b[{extra_lines}A"
                buffer += "\x1b[?2026l"
                self.terminal.write(buffer)
                self.cursor_row = target_row
                self.hardware_cursor_row = target_row
            self._position_hardware_cursor(cursor_pos, len(new_lines))
            self.previous_lines = new_lines
            self.previous_kitty_image_ids = self._collect_kitty_image_ids(new_lines)
            self.previous_width = width
            self.previous_height = height
            self.previous_viewport_top = prev_viewport_top
            return

        # First changed above viewport - full redraw
        if first_changed < prev_viewport_top:
            log_redraw(f"firstChanged < viewportTop ({first_changed} < {prev_viewport_top})")
            full_render(True)
            return

        # Differential rendering
        buffer = "\x1b[?2026h"
        buffer += self._delete_changed_kitty_images(first_changed, last_changed)

        prev_viewport_bottom = prev_viewport_top + height - 1
        move_target_row = first_changed - 1 if append_start else first_changed

        if move_target_row > prev_viewport_bottom:
            current_screen_row = max(0, min(height - 1, hardware_cursor_row - prev_viewport_top))
            move_to_bottom = height - 1 - current_screen_row
            if move_to_bottom > 0:
                buffer += f"\x1b[{move_to_bottom}B"
            scroll = move_target_row - prev_viewport_bottom
            buffer += "\r\n" * scroll
            prev_viewport_top += scroll
            viewport_top += scroll
            hardware_cursor_row = move_target_row

        # Move to first changed line
        line_diff = compute_line_diff(move_target_row)
        if line_diff > 0:
            buffer += f"\x1b[{line_diff}B"
        elif line_diff < 0:
            buffer += f"\x1b[{-line_diff}A"

        buffer += "\r\n" if append_start else "\r"

        # Render only changed lines
        render_end = min(last_changed, len(new_lines) - 1)
        for i in range(first_changed, render_end + 1):
            if i > first_changed:
                buffer += "\r\n"
            buffer += "\x1b[2K"  # Clear line
            line = new_lines[i]
            if not is_image_line(line) and visible_width(line) > width:
                # Write crash log
                crash_dir = pathlib.Path.home() / ".pi" / "agent"
                crash_dir.mkdir(parents=True, exist_ok=True)
                crash_path = crash_dir / "pi-crash.log"
                crash_data = [
                    f"Crash at {time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())}",
                    f"Terminal width: {width}",
                    f"Line {i} visible width: {visible_width(line)}",
                    "",
                    "=== All rendered lines ===",
                    *[
                        f"[{idx}] (w={visible_width(line_str)}) {line_str}"
                        for idx, line_str in enumerate(new_lines)
                    ],
                    "",
                ]
                with open(crash_path, "w") as f:
                    f.write("\n".join(crash_data))
                self.stop()
                raise RuntimeError(
                    f"Rendered line {i} exceeds terminal width ({visible_width(line)} > {width}).\n"
                    f"This is likely caused by a custom TUI component not truncating its output.\n"
                    f"Use visible_width() to measure and truncate_to_width() to truncate lines.\n"
                    f"Debug log written to: {crash_path}"
                )
            buffer += line

        # Track final cursor position
        final_cursor_row = render_end

        # Clear extra lines if content shrank
        if len(self.previous_lines) > len(new_lines):
            if render_end < len(new_lines) - 1:
                move_down = len(new_lines) - 1 - render_end
                buffer += f"\x1b[{move_down}B"
                final_cursor_row = len(new_lines) - 1
            extra_lines = len(self.previous_lines) - len(new_lines)
            for i in range(len(new_lines), len(self.previous_lines)):
                buffer += "\r\n\x1b[2K"
            buffer += f"\x1b[{extra_lines}A"

        buffer += "\x1b[?2026l"

        if os.environ.get("PI_TUI_DEBUG") == "1":
            debug_dir = "/tmp/tui"
            os.makedirs(debug_dir, exist_ok=True)
            debug_path = os.path.join(
                debug_dir, f"render-{int(time.time()*1000)}-{os.urandom(4).hex()}.log"
            )
            debug_data = [
                f"firstChanged: {first_changed}",
                f"viewportTop: {viewport_top}",
                f"cursorRow: {self.cursor_row}",
                f"height: {height}",
                f"lineDiff: {line_diff}",
                f"hardwareCursorRow: {hardware_cursor_row}",
                f"renderEnd: {render_end}",
                f"finalCursorRow: {final_cursor_row}",
                f"cursorPos: {cursor_pos}",
                f"newLines.length: {len(new_lines)}",
                f"previousLines.length: {len(self.previous_lines)}",
                "",
                "=== newLines ===",
                repr(new_lines),
                "",
                "=== previousLines ===",
                repr(self.previous_lines),
                "",
                "=== buffer ===",
                repr(buffer),
            ]
            with open(debug_path, "w") as f:
                f.write("\n".join(debug_data))

        self.terminal.write(buffer)

        self.cursor_row = max(0, len(new_lines) - 1)
        self.hardware_cursor_row = final_cursor_row
        self.max_lines_rendered = max(self.max_lines_rendered, len(new_lines))
        self.previous_viewport_top = max(prev_viewport_top, final_cursor_row - height + 1)

        self._position_hardware_cursor(cursor_pos, len(new_lines))

        self.previous_lines = new_lines
        self.previous_kitty_image_ids = self._collect_kitty_image_ids(new_lines)
        self.previous_width = width
        self.previous_height = height

    def _position_hardware_cursor(
        self,
        cursor_pos: Optional[dict],
        total_lines: int,
    ) -> None:
        if not cursor_pos or total_lines <= 0:
            self.terminal.hideCursor()
            return

        target_row = max(0, min(cursor_pos["row"], total_lines - 1))
        target_col = max(0, cursor_pos["col"])

        row_delta = target_row - self.hardware_cursor_row
        buffer = ""
        if row_delta > 0:
            buffer += f"\x1b[{row_delta}B"
        elif row_delta < 0:
            buffer += f"\x1b[{-row_delta}A"
        buffer += f"\x1b[{target_col + 1}G"

        if buffer:
            self.terminal.write(buffer)

        self.hardware_cursor_row = target_row
        if self.show_hardware_cursor:
            self.terminal.showCursor()
        else:
            self.terminal.hideCursor()


# =============================================================================
# Re-exports from utils and terminal_image
# =============================================================================

__all__ = [
    "Component",
    "Focusable",
    "is_focusable",
    "Container",
    "CURSOR_MARKER",
    "OverlayAnchor",
    "OverlayMargin",
    "OverlayOptions",
    "OverlayHandle",
    "OverlayUnfocusOptions",
    "SizeValue",
    "TUI",
    "visible_width",
    "truncate_to_width",
    "wrap_text_with_ansi",
]
