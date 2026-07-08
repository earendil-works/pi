"""Login dialog for OAuth flows in interactive mode."""

from __future__ import annotations

import asyncio
from typing import Callable

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import key_hint
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.input import Input
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container, TUI
from pi_mono.utils.open_browser import open_browser


class _AbortSignal:
    def __init__(self) -> None:
        self.aborted = False
        self._listeners: list[Callable[[], None]] = []

    def add_event_listener(self, event: str, callback: Callable[[], None]) -> None:
        if event == "abort":
            self._listeners.append(callback)

    def abort(self) -> None:
        if self.aborted:
            return
        self.aborted = True
        for listener in self._listeners:
            listener()


class LoginDialogComponent(Container):
    """OAuth login UI wired to auth_storage.login callbacks."""

    def __init__(
        self,
        ui: TUI,
        provider_id: str,
        on_complete: Callable[[bool, str | None], None],
        *,
        provider_name: str | None = None,
        title: str | None = None,
    ) -> None:
        super().__init__()
        self._ui = ui
        self._on_complete = on_complete
        self._abort_controller = _AbortSignal()
        self._input = Input()
        self._input_resolver: Callable[[str], None] | None = None
        self._input_rejecter: Callable[[BaseException], None] | None = None

        display_name = provider_name or provider_id
        dialog_title = title or f"Login to {display_name}"

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", theme.bold(dialog_title)), padding_x=1, padding_y=0))
        self._content_container = Container()
        self.add_child(self._content_container)
        self.add_child(DynamicBorder())

        self._input.on_submit = self._submit_input
        self._input.on_escape = self.cancel

    @property
    def signal(self) -> _AbortSignal:
        return self._abort_controller

    @property
    def focused(self) -> bool:
        return self._input.focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._input.focused = value

    def cancel(self) -> None:
        self._abort_controller.abort()
        if self._input_rejecter is not None:
            self._input_rejecter(RuntimeError("Login cancelled"))
            self._input_resolver = None
            self._input_rejecter = None
        self._on_complete(False, "Login cancelled")

    def show_auth(self, url: str, instructions: str | None = None) -> None:
        self._content_container.clear()
        self._content_container.add_child(Spacer(1))
        self._content_container.add_child(Text(theme.fg("accent", url), padding_x=1, padding_y=0))
        self._content_container.add_child(
            Text(theme.fg("dim", "Browser should open automatically."), padding_x=1, padding_y=0)
        )
        if instructions:
            self._content_container.add_child(Spacer(1))
            self._content_container.add_child(
                Text(theme.fg("warning", instructions), padding_x=1, padding_y=0)
            )
        open_browser(url)
        self._ui.request_render()

    def show_device_code(self, info: dict[str, object]) -> None:
        self._content_container.clear()
        self._content_container.add_child(Spacer(1))
        verification_uri = str(info.get("verificationUri", ""))
        user_code = str(info.get("userCode", ""))
        self._content_container.add_child(
            Text(theme.fg("accent", verification_uri), padding_x=1, padding_y=0)
        )
        self._content_container.add_child(Spacer(1))
        self._content_container.add_child(
            Text(theme.fg("warning", f"Enter code: {user_code}"), padding_x=1, padding_y=0)
        )
        if verification_uri:
            open_browser(verification_uri)
        self._ui.request_render()

    def _create_input_future(self) -> asyncio.Future[str]:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
        return loop.create_future()

    def show_manual_input(self, prompt: str) -> asyncio.Future[str]:
        future = self._create_input_future()
        self._content_container.add_child(Spacer(1))
        self._content_container.add_child(Text(theme.fg("dim", prompt), padding_x=1, padding_y=0))
        self._content_container.add_child(self._input)
        self._content_container.add_child(
            Text(
                theme.fg("dim", f"({key_hint('tui.select.cancel', 'to cancel')})"),
                padding_x=1,
                padding_y=0,
            )
        )
        self._ui.request_render()

        def resolve(value: str) -> None:
            if not future.done():
                future.set_result(value)

        def reject(error: BaseException) -> None:
            if not future.done():
                future.set_exception(error)

        self._input_resolver = resolve
        self._input_rejecter = reject
        return future

    def show_prompt(self, message: str, placeholder: str | None = None) -> asyncio.Future[str]:
        future = self._create_input_future()
        self._content_container.add_child(Spacer(1))
        self._content_container.add_child(Text(theme.fg("text", message), padding_x=1, padding_y=0))
        if placeholder:
            self._content_container.add_child(
                Text(theme.fg("dim", f"e.g., {placeholder}"), padding_x=1, padding_y=0)
            )
        self._content_container.add_child(self._input)
        self._content_container.add_child(
            Text(
                theme.fg(
                    "dim",
                    f"({key_hint('tui.select.cancel', 'to cancel')}, {key_hint('tui.select.confirm', 'to submit')})",
                ),
                padding_x=1,
                padding_y=0,
            )
        )
        self._input.set_value("")
        self._ui.request_render()

        def resolve(value: str) -> None:
            if not future.done():
                future.set_result(value)

        def reject(error: BaseException) -> None:
            if not future.done():
                future.set_exception(error)

        self._input_resolver = resolve
        self._input_rejecter = reject
        return future

    def show_waiting(self, message: str) -> None:
        self._content_container.add_child(Spacer(1))
        self._content_container.add_child(Text(theme.fg("dim", message), padding_x=1, padding_y=0))
        self._content_container.add_child(
            Text(
                theme.fg("dim", f"({key_hint('tui.select.cancel', 'to cancel')})"),
                padding_x=1,
                padding_y=0,
            )
        )
        self._ui.request_render()

    def show_info(self, lines: list[str]) -> None:
        self._content_container.clear()
        self._content_container.add_child(Spacer(1))
        for line in lines:
            self._content_container.add_child(Text(line, padding_x=1, padding_y=0))
        self._content_container.add_child(Spacer(1))
        self._content_container.add_child(
            Text(
                theme.fg("dim", f"({key_hint('tui.select.cancel', 'to close')})"),
                padding_x=1,
                padding_y=0,
            )
        )
        self._ui.request_render()

    def show_progress(self, message: str) -> None:
        self._content_container.add_child(Text(theme.fg("dim", message), padding_x=1, padding_y=0))
        self._ui.request_render()

    def _replace_input_with_submitted_text(self, value: str) -> None:
        self._content_container.children = [
            Text(f"> {value}", padding_x=1, padding_y=0) if child is self._input else child
            for child in self._content_container.children
        ]

    def _submit_input(self, value: str | None = None) -> None:
        if self._input_resolver is None:
            return
        resolved = self._input.get_value() if value is None else value
        self._replace_input_with_submitted_text(resolved)
        self._input_resolver(resolved)
        self._input_resolver = None
        self._input_rejecter = None

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()
        if kb.matches(data, "tui.select.cancel"):
            self.cancel()
            return
        self._input.handle_input(data)
