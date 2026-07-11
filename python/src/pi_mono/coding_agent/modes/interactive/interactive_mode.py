"""Interactive TUI mode for the coding agent.

Minimal port of packages/coding-agent/src/modes/interactive/interactive-mode.ts.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import subprocess
import sys
import tempfile
import uuid
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

from pi_mono.agent.types import AgentMessage
from pi_mono.ai.models import get_providers
from pi_mono.ai.oauth import OAuthLoginCallbacks
from pi_mono.ai.types import ImageContent, Model
from pi_mono.ai.utils.oauth import OAuthAuthInfo, OAuthDeviceCodeInfo, OAuthSelectPrompt
from pi_mono.coding_agent.core.cursor_auth import (
    clear_stale_cursor_oauth,
    get_cursor_auth_warning,
)
from pi_mono.coding_agent.core.model_resolver import (
    default_model_per_provider,
    find_exact_model_reference_match,
    resolve_model_scope,
)
from pi_mono.coding_agent.core.slash_commands import (
    BUILTIN_SLASH_COMMANDS as CANONICAL_SLASH_COMMANDS,
)
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import key_display_text
from pi_mono.coding_agent.modes.interactive.interactive_autocomplete import (
    build_interactive_autocomplete_provider,
)
from pi_mono.coding_agent.cli.project_trust import should_prompt_project_trust_in_interactive
from pi_mono.config import (
    APP_NAME,
    VERSION,
    get_agent_dir,
    get_auth_path,
    get_changelog_path,
    get_docs_path,
    get_share_viewer_url,
)
from pi_mono.coding_agent.core.agent_session import (
    AgentSessionEvent,
    AgentSessionRuntime,
    SessionImportFileNotFoundError,
    parse_skill_block,
)
from pi_mono.coding_agent.core.trust_manager import ProjectTrustStore
from pi_mono.coding_agent.utils.tools_manager import ensure_tool
from pi_mono.core.session_cwd import MissingSessionCwdError
from pi_mono.coding_agent.modes.interactive.components.assistant_message import (
    AssistantMessageComponent,
)
from pi_mono.coding_agent.modes.interactive.components.bash_execution import BashExecutionComponent
from pi_mono.coding_agent.modes.interactive.components.bordered_loader import BorderedLoader
from pi_mono.coding_agent.modes.interactive.components.branch_summary_message import (
    BranchSummaryMessageComponent,
)
from pi_mono.coding_agent.modes.interactive.components.compaction_summary_message import (
    CompactionSummaryMessageComponent,
)
from pi_mono.coding_agent.modes.interactive.components.custom_editor import CustomEditor
from pi_mono.coding_agent.modes.interactive.components.custom_message import CustomMessageComponent
from pi_mono.coding_agent.modes.interactive.interactive_extension_ui import (
    InteractiveExtensionUIContext,
)
from pi_mono.coding_agent.core.extensions.types import ExtensionError
from pi_mono.coding_agent.core.extensions.runner import ExtensionRunner
from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.extension_selector import (
    ExtensionSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.components.login_dialog import LoginDialogComponent
from pi_mono.coding_agent.modes.interactive.components.oauth_selector import (
    AuthSelectorProvider,
    OAuthSelectorComponent,
)
from pi_mono.coding_agent.core.footer_data_provider import FooterDataProvider
from pi_mono.coding_agent.core.keybindings import CodingAgentKeybindingsManager
from pi_mono.coding_agent.modes.interactive.components.footer import (
    FooterComponent,
    FooterRenderComponent,
)
from pi_mono.coding_agent.modes.interactive.components.model_selector import ModelSelectorComponent
from pi_mono.coding_agent.modes.interactive.components.scoped_models_selector import (
    ScopedModelsSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.components.skill_invocation_message import (
    SkillInvocationMessageComponent,
)
from pi_mono.coding_agent.modes.interactive.components.session_selector import (
    SessionSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.components.user_message import UserMessageComponent
from pi_mono.coding_agent.modes.interactive.components.user_message_selector import (
    UserMessageSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.components.settings_selector import (
    SettingsSelectorComponent,
    build_settings_config_from_session,
)
from pi_mono.coding_agent.modes.interactive.components.tree_selector import TreeSelectorComponent
from pi_mono.coding_agent.modes.interactive.components.trust_selector import (
    TrustSelection,
    TrustSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.components.tool_execution import ToolExecutionComponent
from pi_mono.coding_agent.modes.interactive.theme.theme import (
    get_editor_theme,
    get_markdown_theme,
    init_theme,
    theme,
)
from pi_mono.coding_agent.modes.interactive.theme.theme_controller import (
    InteractiveThemeController,
)
from pi_mono.core.provider_display_names import BUILT_IN_PROVIDER_DISPLAY_NAMES
from pi_mono.core.session_manager import SessionManager
from pi_mono.tui.components.markdown import Markdown
from pi_mono.tui.components.loader import Loader
from pi_mono.tui.components.editor import EditorOptions
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings, set_keybindings
from pi_mono.tui.keys import matches_key
from pi_mono.tui.terminal import ProcessTerminal
from pi_mono.tui.tui import Container, OverlayOptions, TUI
from pi_mono.utils.changelog import format_changelog_markdown, get_new_entries, parse_changelog
from pi_mono.utils.version_check import LatestPiRelease, check_for_new_pi_version

BEDROCK_PROVIDER_ID = "amazon-bedrock"
BUILT_IN_MODEL_PROVIDERS = frozenset(get_providers())


def is_api_key_login_provider(
    provider_id: str,
    oauth_provider_ids: set[str],
    built_in_provider_ids: set[str] | frozenset[str] = BUILT_IN_MODEL_PROVIDERS,
) -> bool:
    if provider_id in BUILT_IN_PROVIDER_DISPLAY_NAMES:
        return True
    if provider_id in built_in_provider_ids:
        return False
    return provider_id not in oauth_provider_ids


def _is_unknown_model(model: Model[Any] | None) -> bool:
    return bool(
        model
        and model.get("provider") == "unknown"
        and model.get("id") == "unknown"
        and model.get("api") == "unknown"
    )


HELP_TEXT = "\n".join(f"  /{cmd.name} - {cmd.description}" for cmd in CANONICAL_SLASH_COMMANDS)


@dataclass
class InteractiveModeOptions:
    initial_message: str | None = None
    initial_messages: list[str] | None = None
    initial_images: list[ImageContent] | None = None
    theme_name: str = "dark"
    verbose: bool = False


def _message_text(message: AgentMessage | dict[str, Any]) -> str:
    parts: list[str] = []
    for block in message.get("content", []):
        if block.get("type") == "text":
            text = block.get("text", "")
            if text:
                parts.append(text)
    return "\n".join(parts)


def _quote_if_needed(value: str) -> str:
    if value and re.fullmatch(r"[a-zA-Z0-9_\-./~:@]+", value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def format_resume_command(session_manager: SessionManager) -> str | None:
    if not sys.stdout.isatty():
        return None
    if not session_manager.is_persisted():
        return None
    session_file = session_manager.get_session_file()
    if not session_file or not os.path.exists(session_file):
        return None
    args = [APP_NAME]
    if not session_manager.uses_default_session_dir():
        args.extend(["--session-dir", _quote_if_needed(session_manager.get_session_dir())])
    args.extend(["--session", session_manager.get_session_id()])
    return " ".join(args)


class InteractiveMode:
    """Interactive terminal UI wired to AgentSession."""

    def __init__(
        self, runtime_host: AgentSessionRuntime, options: InteractiveModeOptions | None = None
    ) -> None:
        self._runtime_host = runtime_host
        self._options = options or InteractiveModeOptions()
        self._session = runtime_host.session
        self._unsubscribe: Callable[[], None] | None = None
        self._input_waiter: asyncio.Future[str] | None = None
        self._is_initialized = False
        self._is_shutting_down = False
        self._last_sigint_time = 0.0
        self._signal_handlers: list[tuple[int, Any]] = []

        self._theme_name = self._options.theme_name
        self._ui: TUI | None = None
        self._chat_container: Container | None = None
        self._status_container: Container | None = None
        self._footer_container: Container | None = None
        self._footer: FooterComponent | None = None
        self._footer_render: FooterRenderComponent | None = None
        self._editor_container: Container | None = None
        self._streaming_component: AssistantMessageComponent | None = None
        self._loader: Loader | None = None
        self._editor: CustomEditor | None = None
        self._pending_tools: dict[str, ToolExecutionComponent] = {}
        self._expandable_components: list[Any] = []
        self._tool_output_expanded = False
        self._hide_thinking_block = False
        self._output_pad = 1
        self._bash_component: BashExecutionComponent | None = None
        self._changelog_markdown: str | None = None
        self._startup_notices_shown = False
        self._scoped_models_overlay: Any | None = None
        self._model_overlay: Any | None = None
        self._settings_overlay: Any | None = None
        self._sessions_overlay: Any | None = None
        self._tree_overlay: Any | None = None
        self._footer_data: FooterDataProvider | None = None
        self._keybindings_manager: CodingAgentKeybindingsManager | None = None
        self._last_escape_time = 0.0
        self._retry_loader: Loader | None = None
        self._extension_ui_context: InteractiveExtensionUIContext | None = None
        self._theme_controller: InteractiveThemeController | None = None

        self._runtime_host.set_rebind_session(self._rebind_session)

    @property
    def session(self):
        return self._session

    @property
    def ui(self) -> TUI:
        if self._ui is None:
            raise RuntimeError("InteractiveMode UI is not initialized; call init() first")
        return self._ui

    def _ensure_ui(self) -> None:
        if self._ui is not None:
            return
        init_theme(self._theme_name)
        self._ui = TUI(ProcessTerminal(), show_hardware_cursor=True)
        self._chat_container = Container()
        self._status_container = Container()
        self._footer_container = Container()
        self._editor_container = Container()
        self._keybindings_manager = CodingAgentKeybindingsManager.create(str(get_agent_dir()))
        assert self._keybindings_manager is not None
        self._editor = CustomEditor(
            self._ui,
            get_editor_theme(),
            self._keybindings_manager,
            EditorOptions(padding_x=1),
        )
        self._hide_thinking_block = self._session.settings_manager.get_hide_thinking_block()
        self._output_pad = self._session.settings_manager.get_output_pad()
        self._theme_controller = InteractiveThemeController(
            self._ui,
            self._session.settings_manager,
            self._show_error,
            self._on_theme_changed,
        )

    async def init(self) -> None:
        if self._is_initialized:
            return

        await ensure_tool("fd")
        await ensure_tool("rg")
        self._ensure_ui()
        self._register_signal_handlers()
        self._setup_layout()
        self._setup_keybindings()
        self._setup_editor()
        self._setup_editor_keybindings()
        self._setup_input_handlers()
        self._ui.start()
        self._is_initialized = True
        if self._theme_controller is not None:
            await self._theme_controller.apply_from_settings()
        self._changelog_markdown = self._get_changelog_for_display()
        await self._rebind_session()
        self._maybe_warn_stale_cursor_auth()

    def _maybe_warn_stale_cursor_auth(self) -> None:
        warning = get_cursor_auth_warning(self._session.model_registry.auth_storage)
        if warning:
            self._show_status(theme.fg("warning", warning))

    def _show_extension_ui_component(self, component: Container, focus: Container) -> None:
        if self._editor_container is None or self._ui is None:
            return
        self._editor_container.clear()
        self._editor_container.add_child(component)
        self._ui.set_focus(focus)
        self._ui.request_render()

    async def run(self) -> None:
        await self.init()
        asyncio.create_task(self._check_for_new_version())
        if not await self._maybe_resolve_project_trust():
            await self._shutdown()
            return

        if self._options.initial_message:
            await self._handle_prompt(
                self._options.initial_message, images=self._options.initial_images
            )

        for message in self._options.initial_messages or []:
            await self._handle_prompt(message)

        while not self._is_shutting_down:
            user_input = await self._wait_for_user_input()
            if self._is_shutting_down:
                break
            await self._handle_user_input(user_input)

    async def stop(self) -> None:
        if not self._is_initialized:
            return
        if self._loader is not None:
            self._loader.stop()
        if self._model_overlay is not None:
            self._model_overlay.hide()
            self._model_overlay = None
        if self._settings_overlay is not None:
            self._settings_overlay.hide()
            self._settings_overlay = None
        if self._sessions_overlay is not None:
            self._sessions_overlay.hide()
            self._sessions_overlay = None
        if self._tree_overlay is not None:
            self._tree_overlay.hide()
            self._tree_overlay = None
        if self._scoped_models_overlay is not None:
            self._scoped_models_overlay.hide()
            self._scoped_models_overlay = None
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        theme_controller = getattr(self, "_theme_controller", None)
        if theme_controller is not None:
            theme_controller.disable_auto_sync()
        if self._ui is not None:
            self._ui.stop()
        self._unregister_signal_handlers()
        self._is_initialized = False

    async def _drain_terminal_input(self) -> None:
        if self._ui is not None:
            await self._ui.drain_input(1000)

    def _setup_layout(self) -> None:
        assert self._ui is not None
        assert self._chat_container is not None
        assert self._status_container is not None
        assert self._footer_container is not None
        assert self._editor_container is not None
        assert self._editor is not None
        header = Text(
            f"{theme.bold(theme.fg('accent', APP_NAME))}{theme.fg('dim', f' v{VERSION}')}\n"
            f"{theme.fg('dim', 'Type a prompt, /help for commands, Ctrl+C to interrupt')}",
            padding_x=1,
            padding_y=0,
        )
        self._ui.add_child(header)
        self._ui.add_child(Spacer(1))
        self._ui.add_child(self._chat_container)
        self._ui.add_child(self._status_container)
        self._ui.add_child(self._footer_container)
        self._ui.add_child(self._editor_container)
        self._editor_container.add_child(self._editor)
        self._ui.set_focus(self._editor)

    def _setup_editor(self) -> None:
        assert self._editor is not None

        def on_submit(text: str) -> None:
            asyncio.create_task(self._submit_editor_text(text))

        self._editor.on_submit = on_submit

    def _setup_editor_keybindings(self) -> None:
        assert self._editor is not None

        self._editor.on_action("app.tools.expand", self._toggle_tool_expand)
        self._editor.on_action("app.thinking.toggle", self._toggle_thinking_block_visibility)
        self._editor.on_action(
            "app.editor.external", lambda: asyncio.create_task(self._open_external_editor())
        )
        self._editor.on_paste_image = self._paste_clipboard_image

    def _get_cwd(self) -> str:
        return self._session.session_manager.get_cwd()

    def _track_expandable(self, component: Any) -> None:
        if hasattr(component, "set_expanded"):
            component.set_expanded(self._tool_output_expanded)
            self._expandable_components.append(component)

    def _toggle_tool_expand(self) -> None:
        self._tool_output_expanded = not self._tool_output_expanded
        for component in self._expandable_components:
            component.set_expanded(self._tool_output_expanded)
        if self._ui is not None:
            self._ui.request_render()

    def _toggle_thinking_block_visibility(self) -> None:
        self._hide_thinking_block = not self._hide_thinking_block
        self._session.settings_manager.set_hide_thinking_block(self._hide_thinking_block)
        if self._chat_container is None:
            return
        streaming_message = None
        if self._streaming_component is not None:
            streaming_message = self._streaming_component._last_message
        self._render_initial_messages()
        if self._streaming_component is not None and streaming_message is not None:
            self._streaming_component.set_hide_thinking_block(self._hide_thinking_block)
            self._streaming_component.update_content(streaming_message)
            self._chat_container.add_child(self._streaming_component)
        label = "hidden" if self._hide_thinking_block else "visible"
        self._show_status(f"Thinking blocks: {label}")

    def _create_tool_component(
        self,
        tool_name: str,
        tool_call_id: str,
        args: Any,
    ) -> ToolExecutionComponent:
        assert self._ui is not None
        component = ToolExecutionComponent(
            tool_name,
            tool_call_id,
            args,
            ui=self._ui,
            cwd=self._get_cwd(),
            show_images=self._session.settings_manager.get_show_images(),
        )
        self._track_expandable(component)
        return component

    async def _wait_for_idle(self) -> None:
        while self._session.is_streaming:
            await asyncio.sleep(0.05)

    async def _navigate_tree_from_extension(
        self, target_id: str, options: dict[str, Any] | None = None
    ) -> dict[str, bool]:
        del options
        result = await self._session.navigate_tree(target_id)
        if self._chat_container is not None:
            self._chat_container.clear()
        return {"cancelled": bool(result.get("cancelled"))}

    async def _reload_from_extension(self) -> None:
        if self._keybindings_manager is not None:
            self._keybindings_manager.reload()
        await self._session.reload()
        await self._rebind_session()
        self._show_status(theme.fg("success", "Reloaded extensions, skills, prompts, and themes"))

    def _setup_input_handlers(self) -> None:
        assert self._ui is not None
        assert self._editor is not None

        def handle_global_input(data: str) -> dict[str, object] | None:
            kb = get_keybindings()
            if kb.matches(data, "app.interrupt"):
                if self._session.is_retrying:
                    self._session.abort_retry()
                    self._show_status(theme.fg("warning", "Retry cancelled"))
                    return {"consume": True}
                if self._session.is_streaming:
                    self._session.agent.abort()
                    self._show_status(theme.fg("warning", "Interrupted"))
                    return {"consume": True}
                return None
            if kb.matches(data, "app.thinking.cycle"):
                asyncio.create_task(self._cycle_thinking_level())
                return {"consume": True}
            if kb.matches(data, "app.model.cycleForward"):
                asyncio.create_task(self._cycle_model("forward"))
                return {"consume": True}
            if kb.matches(data, "app.model.cycleBackward"):
                asyncio.create_task(self._cycle_model("backward"))
                return {"consume": True}
            if kb.matches(data, "app.model.select"):
                self._show_model_selector()
                return {"consume": True}
            if kb.matches(data, "app.session.tree"):
                self._show_tree_selector()
                return {"consume": True}
            if kb.matches(data, "app.session.resume"):
                self._show_session_selector()
                return {"consume": True}
            if kb.matches(data, "app.session.fork"):
                self._show_user_message_selector()
                return {"consume": True}
            if matches_key(data, "ctrl+c"):
                if self._session.is_streaming:
                    self._session.agent.abort()
                    self._show_status(theme.fg("warning", "Interrupted"))
                    return {"consume": True}
                now = time.monotonic()
                if now - self._last_sigint_time < 0.5:
                    asyncio.create_task(self._shutdown())
                    return {"consume": True}
                self._last_sigint_time = now
                self._editor.set_text("")
                return {"consume": True}
            if matches_key(data, "ctrl+d") and not self._editor.get_text().strip():
                asyncio.create_task(self._shutdown())
                return {"consume": True}
            return None

        self._ui.add_input_listener(handle_global_input)

    def _register_signal_handlers(self) -> None:
        for signum in (signal.SIGTERM, signal.SIGHUP):
            try:
                previous = signal.getsignal(signum)

                def handler(_signum: int, _frame: object | None, _previous: Any = previous) -> None:
                    asyncio.create_task(self._shutdown(from_signal=True, signum=_signum))
                    if callable(_previous) and _previous not in (signal.SIG_DFL, signal.SIG_IGN):
                        _previous(_signum, _frame)  # type: ignore[misc]

                signal.signal(signum, handler)
                self._signal_handlers.append((signum, previous))
            except (AttributeError, ValueError, OSError):
                pass

    def _unregister_signal_handlers(self) -> None:
        for signum, previous in self._signal_handlers:
            try:
                signal.signal(signum, previous)
            except (AttributeError, ValueError, OSError):
                pass
        self._signal_handlers.clear()

    def _setup_keybindings(self) -> None:
        self._keybindings_manager = CodingAgentKeybindingsManager.create(str(get_agent_dir()))
        set_keybindings(self._keybindings_manager)
        if self._editor is not None:
            self._editor._keybindings = self._keybindings_manager  # noqa: SLF001

    async def _rebind_session(self) -> None:
        self._session = self._runtime_host.session
        if self._ui is not None and self._editor is not None:
            self._extension_ui_context = InteractiveExtensionUIContext(
                show_status=self._show_status,
                get_editor_text=self._editor.get_text,
                set_editor_text=self._editor.set_text,
                show_component=self._show_extension_ui_component,
                restore_editor=self._restore_editor,
                tui=self._ui,
            )
        await self._session.bind_extensions(
            mode="interactive",
            ui_context=self._extension_ui_context,
            command_context_actions={
                "waitForIdle": self._wait_for_idle,
                "newSession": self._runtime_host.new_session,
                "fork": self._runtime_host.fork,
                "navigateTree": self._navigate_tree_from_extension,
                "switchSession": self._runtime_host.switch_session,
                "reload": self._reload_from_extension,
            },
            shutdown_handler=lambda: asyncio.create_task(self._shutdown()),
            on_error=self._show_extension_error,
        )
        runner = self._session.extension_runner
        if runner is not None:
            self._setup_extension_shortcuts(runner)
        if self._editor is not None:
            self._editor.set_autocomplete_provider(
                build_interactive_autocomplete_provider(self._session)
            )
        if self._footer is not None:
            self._footer.set_session(self._session)
        elif self._footer_container is not None:
            if self._footer_data is None:
                self._footer_data = FooterDataProvider(self._session.session_manager.get_cwd())
            else:
                self._footer_data.set_cwd(self._session.session_manager.get_cwd())
            self._footer = FooterComponent(self._session, self._footer_data)
            self._footer_render = FooterRenderComponent(self._footer)
            self._footer_container.add_child(self._footer_render)
        if self._unsubscribe is not None:
            self._unsubscribe()
        self._unsubscribe = self._session.subscribe(self._handle_session_event)
        if self._is_initialized and self._chat_container is not None:
            self._render_initial_messages()
        await self._update_available_provider_count()

    async def _update_available_provider_count(self) -> None:
        if self._footer_data is None:
            return
        scoped = self._session.scoped_models
        if scoped:
            models = [item["model"] for item in scoped if isinstance(item.get("model"), dict)]
        else:
            self._session.model_registry.refresh()
            try:
                models = self._session.model_registry.get_available()
            except Exception:
                models = []
        unique_providers = {str(model.get("provider", "")) for model in models}
        self._footer_data.set_available_provider_count(len(unique_providers))

    def _on_theme_changed(self) -> None:
        if self._ui is not None:
            self._ui.request_render()

    def _show_extension_error(self, error: ExtensionError) -> None:
        self._show_status(theme.fg("error", f"Extension error ({error.event}): {error.error}"))

    def _setup_extension_shortcuts(self, runner: ExtensionRunner) -> None:
        if self._editor is None or self._keybindings_manager is None:
            return
        shortcuts = runner.get_shortcuts(self._keybindings_manager.get_effective_config())
        if not shortcuts:
            self._editor.on_extension_shortcut = None
            return

        def on_extension_shortcut(data: str) -> bool:
            for shortcut_str, shortcut in shortcuts.items():
                if not matches_key(data, shortcut_str):
                    continue
                handler = shortcut.handler
                if handler is None:
                    return False
                ctx = runner.create_context()

                async def run_handler(bound_handler=handler, bound_ctx=ctx) -> None:
                    try:
                        result = bound_handler(bound_ctx)
                        if hasattr(result, "__await__"):
                            await result
                    except Exception as err:
                        self._show_status(theme.fg("error", f"Shortcut handler error: {err}"))

                asyncio.create_task(run_handler())
                return True
            return False

        self._editor.on_extension_shortcut = on_extension_shortcut

    def _get_message_renderer(self, custom_type: str) -> Any | None:
        runner = self._session.extension_runner
        if runner is None:
            return None
        return runner.get_message_renderer(custom_type)

    def _handle_session_event(self, event: AgentSessionEvent) -> None:
        event_type = event.get("type")
        if event_type == "message_start":
            message = event.get("message")
            if message and message.get("role") == "assistant":
                self._start_streaming_assistant(message)
            elif message and message.get("role") == "user":
                self._append_user_message(message)
            elif message and message.get("role") == "custom":
                self._add_message_to_chat(message)
        elif event_type == "message_update":
            message = event.get("message")
            if message and message.get("role") == "assistant":
                self._update_streaming_assistant(message)
                for block in message.get("content", []):
                    if block.get("type") != "toolCall":
                        continue
                    tool_call_id = str(block.get("id", ""))
                    if not tool_call_id or tool_call_id in self._pending_tools:
                        continue
                    component = self._create_tool_component(
                        str(block.get("name", "tool")),
                        tool_call_id,
                        block.get("arguments"),
                    )
                    if self._chat_container is not None:
                        self._chat_container.add_child(component)
                    self._pending_tools[tool_call_id] = component
        elif event_type == "message_end":
            message = event.get("message")
            if message and message.get("role") == "assistant":
                self._finish_streaming_assistant(message)
                stop_reason = message.get("stopReason")
                if stop_reason in ("aborted", "error"):
                    error_message = str(message.get("errorMessage") or "Error")
                    if stop_reason == "aborted":
                        retry_attempt = self._session.retry_attempt
                        error_message = (
                            f"Aborted after {retry_attempt} retry attempt"
                            + ("s" if retry_attempt > 1 else "")
                            if retry_attempt > 0
                            else "Operation aborted"
                        )
                    for component in list(self._pending_tools.values()):
                        component.update_result(
                            {"content": [{"type": "text", "text": error_message}], "isError": True},
                            is_partial=False,
                        )
                    self._pending_tools.clear()
                else:
                    for component in self._pending_tools.values():
                        component.set_args_complete()
        elif event_type == "tool_execution_start":
            self._handle_tool_execution_start(event)
        elif event_type == "tool_execution_update":
            self._handle_tool_execution_update(event)
        elif event_type == "tool_execution_end":
            self._handle_tool_execution_end(event)
        elif event_type == "agent_start":
            self._pending_tools.clear()
            self._stop_retry_loader()
            self._set_working(True)
        elif event_type == "agent_end":
            self._set_working(False)
            self._stop_retry_loader()
            if self._streaming_component is not None and self._chat_container is not None:
                self._chat_container.remove_child(self._streaming_component)
                self._streaming_component = None
            self._pending_tools.clear()
        elif event_type == "auto_retry_start":
            self._handle_auto_retry_start(event)
        elif event_type == "auto_retry_end":
            self._handle_auto_retry_end(event)
        if self._footer is not None:
            self._footer.invalidate()
        if self._ui is not None:
            self._ui.request_render()

    def _handle_tool_execution_start(self, event: AgentSessionEvent) -> None:
        if self._chat_container is None:
            return
        tool_call_id = str(event.get("toolCallId", ""))
        if not tool_call_id:
            return
        component = self._pending_tools.get(tool_call_id)
        if component is None:
            component = self._create_tool_component(
                str(event.get("toolName", "tool")),
                tool_call_id,
                event.get("args"),
            )
            self._chat_container.add_child(component)
            self._pending_tools[tool_call_id] = component
        component.mark_execution_started()

    def _handle_tool_execution_update(self, event: AgentSessionEvent) -> None:
        tool_call_id = str(event.get("toolCallId", ""))
        component = self._pending_tools.get(tool_call_id)
        if component is None:
            return
        partial_result = event.get("partialResult")
        if isinstance(partial_result, dict):
            component.update_result({**partial_result, "isError": False}, is_partial=True)

    def _handle_tool_execution_end(self, event: AgentSessionEvent) -> None:
        tool_call_id = str(event.get("toolCallId", ""))
        component = self._pending_tools.get(tool_call_id)
        if component is None:
            return
        result = event.get("result")
        if isinstance(result, dict):
            component.update_result(
                {**result, "isError": bool(event.get("isError"))}, is_partial=False
            )
        self._pending_tools.pop(tool_call_id, None)

    def _append_user_message(self, message: AgentMessage | dict[str, Any]) -> None:
        self._add_message_to_chat(message)

    def _add_message_to_chat(
        self,
        message: AgentMessage | dict[str, Any],
        *,
        populate_history: bool = False,
    ) -> None:
        if self._chat_container is None:
            return
        role = message.get("role")
        if role == "bashExecution":
            assert self._ui is not None
            component = BashExecutionComponent(
                str(message.get("command", "")),
                self._ui,
                exclude_from_context=bool(message.get("excludeFromContext")),
            )
            output = message.get("output")
            if isinstance(output, str) and output:
                component.append_output(output)
            component.set_complete(
                message.get("exitCode"),
                cancelled=bool(message.get("cancelled")),
            )
            self._track_expandable(component)
            self._chat_container.add_child(component)
            return
        if role == "compactionSummary":
            self._chat_container.add_child(Spacer(1))
            component = CompactionSummaryMessageComponent(message)
            self._track_expandable(component)
            self._chat_container.add_child(component)
            return
        if role == "branchSummary":
            self._chat_container.add_child(Spacer(1))
            component = BranchSummaryMessageComponent(message)
            self._track_expandable(component)
            self._chat_container.add_child(component)
            return
        if role == "user":
            text_content = _message_text(message)
            if not text_content.strip():
                return
            if self._chat_container.children:
                self._chat_container.add_child(Spacer(1))
            skill_block = parse_skill_block(text_content)
            if skill_block:
                skill_component = SkillInvocationMessageComponent(skill_block)
                self._track_expandable(skill_component)
                self._chat_container.add_child(skill_component)
                user_message = skill_block.get("userMessage")
                if user_message:
                    self._chat_container.add_child(Spacer(1))
                    self._chat_container.add_child(
                        UserMessageComponent(user_message, output_pad=self._output_pad)
                    )
            else:
                self._chat_container.add_child(
                    UserMessageComponent(text_content, output_pad=self._output_pad)
                )
            if (
                populate_history
                and self._editor is not None
                and hasattr(self._editor, "add_to_history")
            ):
                self._editor.add_to_history(text_content)  # type: ignore[attr-defined]
            return
        if role == "assistant":
            component = AssistantMessageComponent(
                message,
                hide_thinking_block=self._hide_thinking_block,
                output_pad=self._output_pad,
            )
            self._chat_container.add_child(component)
            return
        if role == "custom":
            custom_type = str(message.get("customType", "custom"))
            renderer = self._get_message_renderer(custom_type)
            component = CustomMessageComponent(message, renderer)
            self._track_expandable(component)
            self._chat_container.add_child(component)
            return

    def _render_session_context(
        self,
        session_context: dict[str, Any],
        *,
        populate_history: bool = False,
    ) -> None:
        if self._chat_container is None:
            return
        self._pending_tools.clear()
        rendered_pending_tools: dict[str, ToolExecutionComponent] = {}
        for message in session_context.get("messages", []):
            if message.get("role") == "assistant":
                self._add_message_to_chat(message, populate_history=populate_history)
                for block in message.get("content", []):
                    if block.get("type") != "toolCall":
                        continue
                    tool_call_id = str(block.get("id", ""))
                    if not tool_call_id:
                        continue
                    component = self._create_tool_component(
                        str(block.get("name", "tool")),
                        tool_call_id,
                        block.get("arguments"),
                    )
                    self._chat_container.add_child(component)
                    stop_reason = message.get("stopReason")
                    if stop_reason in ("aborted", "error"):
                        error_message = str(message.get("errorMessage") or "Error")
                        if stop_reason == "aborted":
                            retry_attempt = self._session.retry_attempt
                            error_message = (
                                f"Aborted after {retry_attempt} retry attempt"
                                + ("s" if retry_attempt > 1 else "")
                                if retry_attempt > 0
                                else "Operation aborted"
                            )
                        component.update_result(
                            {"content": [{"type": "text", "text": error_message}], "isError": True},
                            is_partial=False,
                        )
                    else:
                        rendered_pending_tools[tool_call_id] = component
            elif message.get("role") == "toolResult":
                component = rendered_pending_tools.get(str(message.get("toolCallId", "")))
                if component is not None:
                    component.update_result(message, is_partial=False)
                    rendered_pending_tools.pop(str(message.get("toolCallId", "")), None)
            else:
                self._add_message_to_chat(message, populate_history=populate_history)
        self._pending_tools.update(rendered_pending_tools)

    def _render_initial_messages(self) -> None:
        if self._chat_container is None:
            return
        self._chat_container.clear()
        self._expandable_components.clear()
        context = self._session.session_manager.build_session_context()
        self._render_session_context(context, populate_history=True)
        self._show_startup_notices_if_needed()
        if self._footer is not None:
            self._footer.invalidate()
        if self._ui is not None:
            self._ui.request_render()

    def _get_changelog_for_display(self) -> str | None:
        if self._session.agent.state.messages:
            return None
        settings_manager = self._session.settings_manager
        last_version = settings_manager.get_last_changelog_version()
        entries = parse_changelog(get_changelog_path())
        if not last_version:
            settings_manager.set_last_changelog_version(VERSION)
            return None
        new_entries = get_new_entries(entries, last_version)
        if not new_entries:
            return None
        settings_manager.set_last_changelog_version(VERSION)
        return format_changelog_markdown(new_entries)

    def _show_startup_notices_if_needed(self) -> None:
        if (
            self._startup_notices_shown
            or not self._changelog_markdown
            or self._chat_container is None
        ):
            return
        self._startup_notices_shown = True
        if self._chat_container.children:
            self._chat_container.add_child(Spacer(1))
        self._chat_container.add_child(DynamicBorder())
        if self._session.settings_manager.get_collapse_changelog():
            version_match = re.search(r"##\s+\[?(\d+\.\d+\.\d+)\]?", self._changelog_markdown)
            latest_version = version_match.group(1) if version_match else VERSION
            condensed = f"Updated to v{latest_version}. Use {theme.bold('/changelog')} to view full changelog."
            self._chat_container.add_child(Text(condensed, padding_x=1, padding_y=0))
        else:
            self._chat_container.add_child(
                Text(theme.bold(theme.fg("accent", "What's New")), padding_x=1, padding_y=0)
            )
            self._chat_container.add_child(Spacer(1))
            self._chat_container.add_child(
                Markdown(
                    self._changelog_markdown.strip(),
                    1,
                    0,
                    get_markdown_theme(),
                )
            )
            self._chat_container.add_child(Spacer(1))
        self._chat_container.add_child(DynamicBorder())

    async def _check_for_new_version(self) -> None:
        release = await check_for_new_pi_version(VERSION)
        if release:
            self._show_new_version_notification(release)

    def _show_new_version_notification(self, release: LatestPiRelease) -> None:
        if self._chat_container is None:
            return
        version = release.get("version", "")
        self._chat_container.add_child(Spacer(1))
        self._chat_container.add_child(DynamicBorder(lambda text: theme.fg("warning", text)))
        self._chat_container.add_child(
            Text(
                f"{theme.bold(theme.fg('warning', 'Update Available'))}\n"
                f"{theme.fg('muted', f'New version {version} is available.')}",
                padding_x=1,
                padding_y=0,
            )
        )
        note = release.get("note")
        if isinstance(note, str) and note.strip():
            self._chat_container.add_child(
                Text(theme.fg("muted", note.strip()), padding_x=1, padding_y=0)
            )
        if self._ui is not None:
            self._ui.request_render()

    def _start_streaming_assistant(self, message: AgentMessage | dict[str, Any]) -> None:
        if self._chat_container is None:
            return
        self._finish_streaming_assistant(message, finalize=False)
        self._streaming_component = AssistantMessageComponent(
            message,
            hide_thinking_block=self._hide_thinking_block,
            output_pad=self._output_pad,
        )
        self._chat_container.add_child(self._streaming_component)

    def _update_streaming_assistant(self, message: AgentMessage | dict[str, Any]) -> None:
        if self._streaming_component is None:
            self._start_streaming_assistant(message)
            return
        self._streaming_component.update_content(message)

    def _finish_streaming_assistant(
        self,
        message: AgentMessage | dict[str, Any],
        *,
        finalize: bool = True,
    ) -> None:
        if self._streaming_component is None:
            if finalize and self._chat_container is not None:
                text = _message_text(message)
                if text:
                    self._chat_container.add_child(
                        AssistantMessageComponent(
                            message,
                            hide_thinking_block=self._hide_thinking_block,
                            output_pad=self._output_pad,
                        )
                    )
            return

        self._streaming_component.update_content(message)
        self._streaming_component = None

    def _set_working(self, active: bool) -> None:
        if self._ui is None or self._status_container is None:
            return
        if active and self._session.is_streaming:
            if self._retry_loader is not None:
                return
            if self._loader is None:
                self._loader = Loader(
                    self._ui,
                    theme.fg_fn("accent"),
                    theme.fg_fn("muted"),
                    "Working...",
                )
                self._status_container.add_child(self._loader)
                self._loader.start()
            return
        if self._loader is not None:
            self._loader.stop()
            self._status_container.remove_child(self._loader)
            self._loader = None

    def _stop_retry_loader(self) -> None:
        if self._retry_loader is not None:
            self._retry_loader.stop()
            if self._status_container is not None:
                self._status_container.remove_child(self._retry_loader)
            self._retry_loader = None

    def _handle_auto_retry_start(self, event: AgentSessionEvent) -> None:
        if self._ui is None or self._status_container is None:
            return
        self._set_working(False)
        delay_seconds = max(1, int(event.get("delayMs", 0) / 1000))
        attempt = int(event.get("attempt", 0))
        max_attempts = int(event.get("maxAttempts", 0))
        message = f"Retrying ({attempt}/{max_attempts}) in {delay_seconds}s... (Esc to cancel)"
        self._retry_loader = Loader(
            self._ui,
            theme.fg_fn("warning"),
            theme.fg_fn("muted"),
            message,
        )
        self._status_container.clear()
        self._status_container.add_child(self._retry_loader)
        self._retry_loader.start()

    def _handle_auto_retry_end(self, event: AgentSessionEvent) -> None:
        self._stop_retry_loader()
        if not event.get("success") and event.get("finalError"):
            self._show_status(theme.fg("error", str(event.get("finalError"))))

    def _show_status(self, text: str) -> None:
        if self._status_container is None:
            return
        self._status_container.clear()
        self._status_container.add_child(Text(text, padding_x=1, padding_y=0))

    async def _wait_for_user_input(self) -> str:
        loop = asyncio.get_running_loop()
        self._input_waiter = loop.create_future()
        try:
            return await self._input_waiter
        finally:
            self._input_waiter = None

    async def _submit_editor_text(self, text: str) -> None:
        if self._editor is None:
            return
        text = text.strip()
        self._editor.set_text("")
        if not text:
            return
        if self._input_waiter is not None and not self._input_waiter.done():
            self._input_waiter.set_result(text)
            return
        await self._handle_user_input(text)

    async def _handle_user_input(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if text.startswith("!"):
            is_excluded = text.startswith("!!")
            command = text[2:].strip() if is_excluded else text[1:].strip()
            if command:
                await self._handle_bash_command(command, exclude_from_context=is_excluded)
            return
        if text.startswith("/"):
            await self._handle_slash_command(text)
            return
        await self._handle_prompt(text)

    async def _handle_slash_command(self, text: str) -> None:
        if text == "/import" or text.startswith("/import "):
            await self._handle_import_command(text)
            return

        command, _, argument = text[1:].partition(" ")
        command = command.lower()
        argument = argument.strip()

        if command in ("help", "?"):
            self._append_system_message(HELP_TEXT)
            return
        if command in ("exit", "quit"):
            await self._shutdown()
            return
        if command in ("clear", "new"):
            await self._runtime_host.new_session()
            self._render_initial_messages()
            self._show_status(theme.fg("success", "Started new session"))
            return
        if command == "compact":
            await self._session.compact(argument or None)
            self._show_status(theme.fg("success", "Session compacted"))
            return
        if command == "reload":
            await self._reload_from_extension()
            return
        if command == "session":
            stats = self._session.get_session_stats()
            self._append_system_message(
                "\n".join(f"  {key}: {value}" for key, value in stats.items())
            )
            return
        if command == "name":
            if not argument:
                current = self._session.session_name
                self._append_system_message(f"Session name: {current or '(unset)'}")
                return
            self._session.set_session_name(argument)
            self._show_status(theme.fg("success", f"Session name set to {argument}"))
            return
        if command == "copy":
            text = self._session.get_last_assistant_text()
            if not text:
                self._show_status(theme.fg("warning", "No assistant message to copy"))
                return
            try:
                from pi_mono.utils.clipboard import write_clipboard_text

                write_clipboard_text(text)
                self._show_status(theme.fg("success", "Copied last assistant message"))
            except Exception as error:
                self._show_status(theme.fg("error", f"Copy failed: {error}"))
            return
        if command == "export":
            output_path = argument or None
            path = await self._session.export_to_html(output_path)
            self._show_status(theme.fg("success", f"Exported to {path}"))
            return
        if command == "hotkeys":
            hints = [
                f"  {key_display_text('app.model.cycleForward')} next model",
                f"  {key_display_text('app.thinking.cycle')} cycle thinking",
                f"  {key_display_text('app.model.select')} model selector",
                f"  {key_display_text('app.session.tree')} session tree",
                f"  {key_display_text('app.session.resume')} resume session",
            ]
            self._append_system_message("\n".join(hints))
            return
        if command == "fork":
            self._show_user_message_selector()
            return
        if command == "clone":
            result = await self._runtime_host.fork(
                self._session.session_manager.leafId or "", {"position": "at"}
            )
            if not result.get("cancelled") and self._chat_container is not None:
                self._chat_container.clear()
            self._show_status(theme.fg("success", "Session cloned"))
            return
        if command == "model":
            await self._handle_model_command(argument or None)
            return
        if command in ("sessions", "resume"):
            self._show_session_selector()
            return
        if command == "settings":
            self._show_settings_selector()
            return
        if command == "tree":
            self._show_tree_selector(argument or None)
            return
        if command == "trust":
            self._show_trust_selector()
            return
        if command == "login":
            self._show_oauth_selector("login")
            return
        if command == "logout":
            self._show_oauth_selector("logout")
            return
        if command == "changelog":
            self._handle_changelog_command()
            return
        if command == "share":
            await self._handle_share_command()
            return
        if command in ("scoped-models", "scoped_models"):
            self._show_scoped_models_selector()
            return

        if await self._session.try_execute_extension_command(text):
            return

        self._show_status(theme.fg("error", f"Unknown command: /{command}"))

    async def _cycle_thinking_level(self) -> None:
        level = self._session.cycle_thinking_level()
        if level is None:
            self._show_status(theme.fg("warning", "No thinking levels available"))
            return
        self._show_status(theme.fg("success", f"Thinking level: {level}"))

    async def _cycle_model(self, direction: Literal["forward", "backward"]) -> None:
        result = await self._session.cycle_model(direction)
        if result is None:
            self._show_status(theme.fg("warning", "No models available to cycle"))
            return
        model = result["model"]
        self._show_status(theme.fg("success", f"Model: {model.get('provider')}/{model.get('id')}"))

    async def _get_model_candidates(self) -> list[Model[Any]]:
        if self._session.scoped_models:
            return [
                item["model"]
                for item in self._session.scoped_models
                if isinstance(item.get("model"), dict)
            ]
        await asyncio.to_thread(self._session.model_registry.refresh)
        try:
            return self._session.model_registry.get_available()
        except Exception:
            return []

    async def _handle_model_command(self, search: str | None) -> None:
        if not search:
            self._show_model_selector()
            return

        models = await self._get_model_candidates()
        exact_match = find_exact_model_reference_match(search, models)
        if exact_match is not None:
            await self._set_model(exact_match)
            return
        needle = search.lower()
        matches = [
            model
            for model in models
            if needle in f"{model.get('provider', '')}/{model.get('id', '')}".lower()
        ]
        if len(matches) == 1:
            await self._set_model(matches[0])
            return
        if not matches:
            self._show_status(theme.fg("error", f"No model matched: {search}"))
            return

        self._show_model_selector(search)

    def _show_tree_selector(self, initial_search: str | None = None) -> None:
        if self._ui is None:
            return

        branch = self._session.session_manager.get_branch()
        if not branch:
            self._show_status(theme.fg("warning", "No session entries to navigate"))
            return

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            def on_cancel() -> None:
                done()

            async def on_select(entry_id: str) -> None:
                try:
                    result = await self._session.navigate_tree(entry_id)
                except Exception as error:
                    done()
                    self._show_status(theme.fg("error", str(error)))
                    return
                if result.get("cancelled"):
                    done()
                    return
                editor_text = result.get("editorText")
                done()
                if isinstance(editor_text, str) and self._editor is not None:
                    self._editor.set_text(editor_text)
                if self._chat_container is not None:
                    self._chat_container.clear()
                self._render_initial_messages()
                self._show_status(theme.fg("success", "Navigated session branch"))

            def handle_select(entry_id: str) -> None:
                asyncio.create_task(on_select(entry_id))

            selector = TreeSelectorComponent(
                self._ui,
                self._session.session_manager,
                handle_select,
                on_cancel,
                initial_search=initial_search,
                initial_filter_mode=self._session.settings_manager.get_tree_filter_mode(),  # type: ignore[arg-type]
                on_filter_mode_change=self._session.settings_manager.set_tree_filter_mode,
            )
            return selector, selector

        self._show_selector(create)

    def _show_model_selector(self, initial_search: str | None = None) -> None:
        if self._ui is None:
            return

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            def on_select(model: Model[Any]) -> None:
                async def apply_model() -> None:
                    await self._set_model(model)
                    done()

                asyncio.create_task(apply_model())

            def on_cancel() -> None:
                done()
                if self._ui is not None:
                    self._ui.request_render()

            selector = ModelSelectorComponent(
                self._ui,
                self._session.model,
                self._session.settings_manager,
                self._session.model_registry,
                on_select,
                on_cancel,
                scoped_models=self._session.scoped_models,
                initial_search=initial_search,
            )
            return selector, selector

        self._show_selector(create)

    async def _set_model(self, model: Model[Any]) -> None:
        try:
            await self._session.set_model(model)
            if self._footer is not None:
                self._footer.invalidate()
            self._show_status(
                theme.fg("success", f"Model set to {model.get('provider')}/{model.get('id')}")
            )
        except Exception as error:
            self._show_error(str(error))

    def _close_overlay(self, attr: str) -> None:
        overlay = getattr(self, attr, None)
        if overlay is not None:
            overlay.hide()
            setattr(self, attr, None)
        if self._editor is not None and self._ui is not None:
            self._ui.set_focus(self._editor)

    def _show_settings_selector(self) -> None:
        if self._ui is None:
            return

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            class _Callbacks:
                def on_auto_compact_change(self, enabled: bool) -> None:
                    self_outer._session.set_auto_compaction(enabled)
                    if self_outer._footer is not None:
                        self_outer._footer.set_auto_compact_enabled(enabled)

                def on_show_images_change(self, enabled: bool) -> None:
                    self_outer._session.settings_manager.set_show_images(enabled)

                def on_steering_mode_change(self, mode: str) -> None:
                    self_outer._session.set_steering_mode(mode)  # type: ignore[arg-type]

                def on_follow_up_mode_change(self, mode: str) -> None:
                    self_outer._session.set_follow_up_mode(mode)  # type: ignore[arg-type]

                def on_thinking_level_change(self, level: str) -> None:
                    self_outer._session.set_thinking_level(level)  # type: ignore[arg-type]
                    if self_outer._footer is not None:
                        self_outer._footer.invalidate()

                def on_theme_change(self, theme_name: str) -> None:
                    self_outer._session.settings_manager.set_theme(theme_name)
                    if self_outer._theme_controller is not None:
                        asyncio.create_task(self_outer._theme_controller.apply_from_settings())

                def on_theme_preview(self, theme_name: str) -> None:
                    if self_outer._theme_controller is not None:
                        self_outer._theme_controller.preview(theme_name)
                    elif self_outer._ui is not None:
                        init_theme(theme_name)
                        self_outer._ui.invalidate()
                        self_outer._ui.request_render()

                def on_hide_thinking_block_change(self, hidden: bool) -> None:
                    self_outer._hide_thinking_block = hidden
                    self_outer._session.settings_manager.set_hide_thinking_block(hidden)

                def on_show_cache_miss_notices_change(self, show: bool) -> None:
                    self_outer._session.settings_manager.set_show_cache_miss_notices(show)

                def on_output_pad_change(self, padding: int) -> None:
                    self_outer._output_pad = padding
                    self_outer._session.settings_manager.set_output_pad(padding)  # type: ignore[arg-type]
                    if self_outer._chat_container is not None:
                        for child in self_outer._chat_container.children:
                            if hasattr(child, "set_output_pad"):
                                child.set_output_pad(padding)
                    if self_outer._streaming_component is not None:
                        self_outer._streaming_component.set_output_pad(padding)

                def on_collapse_changelog_change(self, collapsed: bool) -> None:
                    self_outer._session.settings_manager.set_collapse_changelog(collapsed)

                def on_quiet_startup_change(self, enabled: bool) -> None:
                    self_outer._session.settings_manager.set_quiet_startup(enabled)

                def on_tree_filter_mode_change(self, mode: str) -> None:
                    self_outer._session.settings_manager.set_tree_filter_mode(mode)  # type: ignore[arg-type]

                def on_cancel(self) -> None:
                    done()

            self_outer = self
            callbacks = _Callbacks()
            config = build_settings_config_from_session(self._session)
            selector = SettingsSelectorComponent(config, callbacks)  # type: ignore[arg-type]
            return selector, selector

        self._show_selector(create)

    def _show_session_selector(self) -> None:
        if self._ui is None:
            return

        session_manager = self._session.session_manager
        cwd = session_manager.get_cwd()
        session_dir = session_manager.get_session_dir()

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            async def on_select(session_path: str) -> None:
                try:
                    result = await self_outer._runtime_host.switch_session(session_path)
                    if result.get("cancelled"):
                        self_outer._show_status(theme.fg("warning", "Resume cancelled"))
                        return
                    if self_outer._chat_container is not None:
                        self_outer._chat_container.clear()
                    self_outer._render_initial_messages()
                    self_outer._show_status(theme.fg("success", "Resumed session"))
                except Exception as error:
                    self_outer._show_status(theme.fg("error", str(error)))
                finally:
                    done()

            def handle_select(session_path: str) -> None:
                asyncio.create_task(on_select(session_path))

            selector = SessionSelectorComponent(
                self_outer._ui,
                lambda on_progress=None: SessionManager.list(cwd, session_dir, on_progress),
                lambda on_progress=None: (
                    SessionManager.list_all(on_progress)
                    if session_manager.uses_default_session_dir()
                    else SessionManager.list_all(session_dir, on_progress)
                ),
                handle_select,
                done,
                current_session_path=self_outer._session.session_file,
            )
            return selector, selector

        self_outer = self
        self._show_selector(create)

    def _show_error(self, text: str) -> None:
        self._show_status(theme.fg("error", text))

    def _restore_editor(self) -> None:
        if self._editor_container is None or self._editor is None or self._ui is None:
            return
        self._editor_container.clear()
        self._editor_container.add_child(self._editor)
        self._ui.set_focus(self._editor)
        self._ui.request_render()

    def _show_selector(
        self,
        create: Callable[[Callable[[], None]], tuple[Container, Container]],
    ) -> None:
        if self._editor_container is None or self._editor is None or self._ui is None:
            return

        def done() -> None:
            self._restore_editor()

        component, focus = create(done)
        self._editor_container.clear()
        self._editor_container.add_child(component)
        self._ui.set_focus(focus)
        self._ui.request_render()

        self._ui.set_focus(focus)
        self._ui.request_render()

    def _show_user_message_selector(self) -> None:
        user_messages = self._session.get_user_messages_for_forking()
        if not user_messages:
            self._show_status(theme.fg("warning", "No messages to fork from"))
            return

        initial_selected_id = user_messages[-1]["entryId"]

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            def on_select(entry_id: str) -> None:
                async def run_fork() -> None:
                    try:
                        result = await self._runtime_host.fork(entry_id)
                        if result.get("cancelled"):
                            done()
                            if self._ui is not None:
                                self._ui.request_render()
                            return
                        if self._chat_container is not None:
                            self._chat_container.clear()
                        await self._rebind_session()
                        selected_text = result.get("selectedText")
                        if isinstance(selected_text, str) and self._editor is not None:
                            self._editor.set_text(selected_text)
                        done()
                        self._show_status(theme.fg("success", "Forked to new session"))
                    except Exception as error:
                        done()
                        self._show_status(theme.fg("error", str(error)))

                asyncio.create_task(run_fork())

            selector = UserMessageSelectorComponent(
                user_messages,
                on_select,
                done,
                initial_selected_id,
            )
            return selector, selector.get_message_list()

        self._show_selector(create)

    async def _maybe_resolve_project_trust(self) -> bool:
        cwd = self._session.cwd
        agent_dir = str(get_agent_dir())
        if not should_prompt_project_trust_in_interactive(
            cwd=cwd,
            agent_dir=agent_dir,
            trust_override=None,
            project_trusted=self._session.settings_manager.is_project_trusted(),
        ):
            return True

        selection = await self._prompt_trust_selector_async()
        if selection is None:
            return True
        trust_store = ProjectTrustStore(agent_dir)
        if selection.updates:
            trust_store.set_many(selection.updates)
        self._session.settings_manager.set_project_trusted(selection.trusted)
        await self._session.reload()
        self._show_status(
            theme.fg(
                "success",
                f"Project trust: {'trusted' if selection.trusted else 'untrusted'}",
            )
        )
        return True

    async def _prompt_trust_selector_async(self) -> TrustSelection | None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[TrustSelection | None] = loop.create_future()
        cwd = self._session.cwd
        trust_store = ProjectTrustStore(str(get_agent_dir()))
        saved_decision = trust_store.get_entry(cwd)

        def on_select(selection: TrustSelection) -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(selection)

        def on_cancel() -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(None)

        selector = TrustSelectorComponent(
            cwd=cwd,
            saved_decision=saved_decision,
            project_trusted=self._session.settings_manager.is_project_trusted(),
            on_select=on_select,
            on_cancel=on_cancel,
        )
        if self._editor_container is None or self._ui is None:
            return None
        self._editor_container.clear()
        self._editor_container.add_child(selector)
        self._ui.set_focus(selector)
        self._ui.request_render()
        return await future

    def _show_trust_selector(self) -> None:
        cwd = self._session.cwd
        trust_store = ProjectTrustStore(str(get_agent_dir()))
        saved_decision = trust_store.get_entry(cwd)

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            def on_select(selection: TrustSelection) -> None:
                if selection.updates:
                    trust_store.set_many(selection.updates)
                done()
                self._show_status(
                    theme.fg(
                        "success",
                        "Saved trust decision: "
                        f"{'trusted' if selection.trusted else 'untrusted'}. "
                        "Restart pi for this to take effect.",
                    )
                )

            def on_cancel() -> None:
                done()

            selector = TrustSelectorComponent(
                cwd=cwd,
                saved_decision=saved_decision,
                project_trusted=self._session.settings_manager.is_project_trusted(),
                on_select=on_select,
                on_cancel=on_cancel,
            )
            return selector, selector

        self._show_selector(create)

    @staticmethod
    def _get_path_command_argument(text: str, command: Literal["/export", "/import"]) -> str | None:
        if text == command:
            return None
        if not text.startswith(f"{command} "):
            return None
        args_string = text[len(command) + 1 :].lstrip()
        if not args_string:
            return None
        first_char = args_string[0]
        if first_char in ('"', "'"):
            closing_quote_index = args_string.find(first_char, 1)
            if closing_quote_index < 0:
                return None
            return args_string[1:closing_quote_index]
        first_whitespace_index = next(
            (index for index, char in enumerate(args_string) if char.isspace()),
            -1,
        )
        if first_whitespace_index < 0:
            return args_string
        return args_string[:first_whitespace_index]

    async def _confirm_extension_action(self, title: str, message: str) -> bool:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()

        def handle_select(option_label: str) -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(option_label == "Yes")

        def handle_cancel() -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(False)

        selector = ExtensionSelectorComponent(
            f"{title}\n{message}",
            ["Yes", "No"],
            handle_select,
            handle_cancel,
        )
        if self._editor_container is None or self._ui is None:
            return False
        self._editor_container.clear()
        self._editor_container.add_child(selector)
        self._ui.set_focus(selector)
        self._ui.request_render()
        return await future

    async def _handle_import_command(self, text: str) -> None:
        input_path = self._get_path_command_argument(text, "/import")
        if not input_path:
            self._show_status(theme.fg("error", "Usage: /import <path.jsonl>"))
            return

        confirmed = await self._confirm_extension_action(
            "Import session",
            f"Replace current session with {input_path}?",
        )
        if not confirmed:
            self._show_status(theme.fg("warning", "Import cancelled"))
            return

        try:
            if self._loader is not None:
                self._loader.stop()
                self._loader = None
            if self._status_container is not None:
                self._status_container.clear()
            result = await self._runtime_host.import_from_jsonl(input_path)
            if result.get("cancelled"):
                self._show_status(theme.fg("warning", "Import cancelled"))
                return
            if self._chat_container is not None:
                self._chat_container.clear()
            await self._rebind_session()
            self._show_status(theme.fg("success", f"Session imported from: {input_path}"))
        except MissingSessionCwdError as error:
            selected_cwd = await self._prompt_missing_session_cwd(error)
            if not selected_cwd:
                self._show_status(theme.fg("warning", "Import cancelled"))
                return
            result = await self._runtime_host.import_from_jsonl(input_path, selected_cwd)
            if result.get("cancelled"):
                self._show_status(theme.fg("warning", "Import cancelled"))
                return
            if self._chat_container is not None:
                self._chat_container.clear()
            await self._rebind_session()
            self._show_status(theme.fg("success", f"Session imported from: {input_path}"))
        except SessionImportFileNotFoundError as error:
            self._show_status(theme.fg("error", f"Failed to import session: {error}"))
        except Exception as error:
            self._show_status(theme.fg("error", f"Failed to import session: {error}"))

    async def _prompt_missing_session_cwd(self, error: MissingSessionCwdError) -> str | None:
        issue = error.issue
        confirmed = await self._confirm_extension_action(
            "Missing session cwd",
            f"{issue.sessionCwd}\n\nContinue in current cwd?\n{issue.fallbackCwd}",
        )
        return issue.fallbackCwd if confirmed else None

    def _get_login_provider_options(
        self, auth_type: Literal["oauth", "api_key"] | None = None
    ) -> list[AuthSelectorProvider]:
        auth_storage = self._session.model_registry.auth_storage
        oauth_providers = auth_storage.get_oauth_providers()
        oauth_provider_ids = {provider.id for provider in oauth_providers}
        options: list[AuthSelectorProvider] = [
            AuthSelectorProvider(id=provider.id, name=provider.name, auth_type="oauth")
            for provider in oauth_providers
        ]

        model_providers = {
            model.get("provider", "") for model in self._session.model_registry.get_all()
        }
        for provider_id in model_providers:
            if not provider_id or not is_api_key_login_provider(provider_id, oauth_provider_ids):
                continue
            options.append(
                AuthSelectorProvider(
                    id=provider_id,
                    name=self._session.model_registry.get_provider_display_name(provider_id),
                    auth_type="api_key",
                )
            )

        if auth_type is not None:
            options = [option for option in options if option.auth_type == auth_type]
        return sorted(options, key=lambda option: option.name.lower())

    def _get_logout_provider_options(self) -> list[AuthSelectorProvider]:
        auth_storage = self._session.model_registry.auth_storage
        options: list[AuthSelectorProvider] = []
        for provider_id in auth_storage.list():
            credential = auth_storage.get(provider_id)
            if not credential:
                continue
            options.append(
                AuthSelectorProvider(
                    id=provider_id,
                    name=self._session.model_registry.get_provider_display_name(provider_id),
                    auth_type=credential.get("type", "api_key"),
                )
            )
        if not any(option.id == "cursor" for option in options):
            from pi_mono.ai.cursor_agent import is_cursor_agent_authenticated

            if is_cursor_agent_authenticated():
                options.append(
                    AuthSelectorProvider(
                        id="cursor",
                        name=self._session.model_registry.get_provider_display_name("cursor"),
                        auth_type="oauth",
                    )
                )
        return sorted(options, key=lambda option: option.name.lower())

    def _show_login_auth_type_selector(self) -> None:
        subscription_label = "Use a subscription"
        api_key_label = "Use an API key"

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            def handle_select(option: str) -> None:
                done()
                auth_type: Literal["oauth", "api_key"] = (
                    "oauth" if option == subscription_label else "api_key"
                )
                self._show_login_provider_selector(auth_type)

            selector = ExtensionSelectorComponent(
                "Select authentication method:",
                [subscription_label, api_key_label],
                handle_select,
                done,
            )
            return selector, selector

        self._show_selector(create)

    def _show_login_provider_selector(self, auth_type: Literal["oauth", "api_key"]) -> None:
        provider_options = self._get_login_provider_options(auth_type)
        if not provider_options:
            self._show_status(
                theme.fg(
                    "warning",
                    (
                        "No subscription providers available."
                        if auth_type == "oauth"
                        else "No API key providers available."
                    ),
                )
            )
            return

        auth_storage = self._session.model_registry.auth_storage

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            def handle_select(provider_id: str) -> None:
                done()
                provider_option = next(
                    (provider for provider in provider_options if provider.id == provider_id),
                    None,
                )
                if provider_option is None:
                    return
                if provider_option.auth_type == "oauth":
                    asyncio.create_task(
                        self._show_cursor_cli_login_dialog(provider_option.name)
                        if provider_option.id == "cursor"
                        else self._show_login_dialog(provider_option.id, provider_option.name)
                    )
                elif provider_option.id == BEDROCK_PROVIDER_ID:
                    self._show_bedrock_setup_dialog(provider_option.id, provider_option.name)
                else:
                    asyncio.create_task(
                        self._show_api_key_login_dialog(provider_option.id, provider_option.name)
                    )

            def handle_cancel() -> None:
                done()
                self._show_login_auth_type_selector()

            selector = OAuthSelectorComponent(
                "login",
                auth_storage,
                provider_options,
                handle_select,
                handle_cancel,
                self._session.model_registry.get_provider_auth_status,
            )
            return selector, selector

        self._show_selector(create)

    def _show_oauth_selector(self, mode: Literal["login", "logout"]) -> None:
        if mode == "login":
            self._show_login_auth_type_selector()
            return

        provider_options = self._get_logout_provider_options()
        if not provider_options:
            self._show_status(
                theme.fg(
                    "warning",
                    "No stored credentials to remove. /logout only removes credentials saved by /login; "
                    "environment variables and models.json config are unchanged.",
                )
            )
            return

        auth_storage = self._session.model_registry.auth_storage

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            async def handle_logout(provider_id: str) -> None:
                done()
                provider_option = next(
                    (provider for provider in provider_options if provider.id == provider_id),
                    None,
                )
                if provider_option is None:
                    return
                try:
                    if provider_option.id == "cursor" and not auth_storage.has("cursor"):
                        from pi_mono.ai.cursor_agent import logout_cursor_account

                        await logout_cursor_account()
                    else:
                        auth_storage.logout(provider_option.id)
                    self._session.model_registry.refresh()
                    if provider_option.auth_type == "oauth":
                        message = f"Logged out of {provider_option.name}"
                    else:
                        message = (
                            f"Removed stored API key for {provider_option.name}. "
                            "Environment variables and models.json config are unchanged."
                        )
                    self._show_status(theme.fg("success", message))
                    if self._footer is not None:
                        self._footer.invalidate()
                except Exception as error:
                    self._show_error(f"Logout failed: {error}")

            def handle_select(provider_id: str) -> None:
                asyncio.create_task(handle_logout(provider_id))

            selector = OAuthSelectorComponent(
                "logout",
                auth_storage,
                provider_options,
                handle_select,
                done,
            )
            return selector, selector

        self._show_selector(create)

    async def _complete_provider_authentication(
        self,
        provider_id: str,
        provider_name: str,
        auth_type: Literal["oauth", "api_key"],
        previous_model: Model[Any] | None,
    ) -> None:
        if provider_id == "cursor" and auth_type == "oauth":
            clear_stale_cursor_oauth(self._session.model_registry.auth_storage)
        self._session.model_registry.refresh()
        action_label = (
            f"Logged in to {provider_name}"
            if auth_type == "oauth"
            else f"Saved API key for {provider_name}"
        )

        selected_model: Model[Any] | None = None
        selection_error: str | None = None
        if _is_unknown_model(previous_model):
            available_models = self._session.model_registry.get_available()
            provider_models = [
                model for model in available_models if model.get("provider") == provider_id
            ]
            if provider_id not in default_model_per_provider:
                selection_error = (
                    f'{action_label}, but no default model is configured for provider "{provider_id}". '
                    "Use /model to select a model."
                )
            elif not provider_models:
                selection_error = f"{action_label}, but no models are available for that provider. Use /model to select a model."
            else:
                default_model_id = default_model_per_provider[provider_id]
                selected_model = next(
                    (model for model in provider_models if model.get("id") == default_model_id),
                    None,
                )
                if selected_model is None:
                    selection_error = (
                        f'{action_label}, but its default model "{default_model_id}" is not available. '
                        "Use /model to select a model."
                    )
                else:
                    try:
                        await self._session.set_model(selected_model)
                    except Exception as error:
                        selected_model = None
                        selection_error = (
                            f"{action_label}, but selecting its default model failed: {error}. "
                            "Use /model to select a model."
                        )

        if self._footer is not None:
            self._footer.invalidate()
        if selected_model is not None:
            self._show_status(
                theme.fg(
                    "success",
                    (
                        f"{action_label}. Selected {selected_model.get('provider')}/{selected_model.get('id')}."
                        if provider_id == "cursor"
                        else f"{action_label}. Selected {selected_model.get('id')}. Credentials saved to {get_auth_path()}"
                    ),
                )
            )
        else:
            saved_suffix = (
                ""
                if provider_id == "cursor" and auth_type == "oauth"
                else f" Credentials saved to {get_auth_path()}"
            )
            self._show_status(theme.fg("success", f"{action_label}.{saved_suffix}"))
            if selection_error:
                self._show_error(selection_error)
        await self._update_available_provider_count()

    def _show_bedrock_setup_dialog(self, provider_id: str, provider_name: str) -> None:
        if self._editor_container is None or self._ui is None:
            return

        dialog = LoginDialogComponent(
            self._ui,
            provider_id,
            lambda _success, _message: self._restore_editor(),
            provider_name=provider_name,
            title="Amazon Bedrock setup",
        )
        dialog.show_info(
            [
                theme.fg(
                    "text", "Amazon Bedrock uses AWS credentials instead of a single API key."
                ),
                theme.fg(
                    "text",
                    "Configure an AWS profile, IAM keys, bearer token, or role-based credentials.",
                ),
                theme.fg("muted", "See:"),
                theme.fg("accent", f"  {Path(get_docs_path()) / 'providers.md'}"),
            ]
        )
        self._editor_container.clear()
        self._editor_container.add_child(dialog)
        self._ui.set_focus(dialog)
        self._ui.request_render()

    async def _show_api_key_login_dialog(self, provider_id: str, provider_name: str) -> None:
        if self._ui is None or self._editor_container is None:
            return

        previous_model = self._session.model
        dialog = LoginDialogComponent(
            self._ui,
            provider_id,
            lambda _success, _message: None,
            provider_name=provider_name,
        )
        self._editor_container.clear()
        self._editor_container.add_child(dialog)
        self._ui.set_focus(dialog)
        self._ui.request_render()

        try:
            api_key = (await dialog.show_prompt("Enter API key:")).strip()
            if not api_key:
                raise ValueError("API key cannot be empty.")
            self._session.model_registry.auth_storage.set(
                provider_id, {"type": "api_key", "key": api_key}
            )
            self._restore_editor()
            await self._complete_provider_authentication(
                provider_id, provider_name, "api_key", previous_model
            )
        except Exception as error:
            self._restore_editor()
            error_msg = str(error)
            if error_msg != "Login cancelled":
                self._show_error(f"Failed to save API key for {provider_name}: {error_msg}")

    async def _show_cursor_cli_login_dialog(self, provider_name: str) -> None:
        from pi_mono.ai.cursor_agent import (
            check_cursor_agent_available,
            login_cursor_account_sync,
            refresh_cursor_auth_cache,
            refresh_cursor_models_cache,
        )

        previous_model = self._session.model
        try:
            check_cursor_agent_available()
        except Exception as error:
            self._show_error(
                f"Cursor Agent CLI not found. Install `agent` or set CURSOR_AGENT_PATH. ({error})"
            )
            return

        if self._ui is not None:
            self._ui.stop()
            sys.stdout.write(
                "\nRunning Cursor Agent CLI login (`agent login`). "
                "Complete the flow in your terminal.\n"
            )
            sys.stdout.flush()
            try:
                await asyncio.to_thread(login_cursor_account_sync)
                refresh_cursor_auth_cache()
                refresh_cursor_models_cache()
            except Exception as error:
                self._show_error(f"Failed to login to {provider_name}: {error}")
                return
            finally:
                self._ui.start()
                self._ui.request_render(force=True)

        await self._complete_provider_authentication(
            "cursor", provider_name, "oauth", previous_model
        )

    def _show_oauth_login_select(
        self,
        dialog: LoginDialogComponent,
        prompt: OAuthSelectPrompt,
    ) -> asyncio.Future[str | None]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str | None] = loop.create_future()

        def restore_dialog() -> None:
            if self._editor_container is None or self._ui is None:
                return
            self._editor_container.clear()
            self._editor_container.add_child(dialog)
            self._ui.set_focus(dialog)
            self._ui.request_render()

        labels = [option["label"] for option in prompt["options"]]

        def handle_select(option_label: str) -> None:
            restore_dialog()
            selected = next(
                (option["id"] for option in prompt["options"] if option["label"] == option_label),
                None,
            )
            if not future.done():
                future.set_result(selected)

        def handle_cancel() -> None:
            restore_dialog()
            if not future.done():
                future.set_result(None)

        selector = ExtensionSelectorComponent(
            prompt["message"], labels, handle_select, handle_cancel
        )
        if self._editor_container is None or self._ui is None:
            if not future.done():
                future.set_result(None)
            return future
        self._editor_container.clear()
        self._editor_container.add_child(selector)
        self._ui.set_focus(selector)
        self._ui.request_render()
        return future

    async def _show_login_dialog(self, provider_id: str, provider_name: str) -> None:
        if self._ui is None or self._editor_container is None:
            return

        provider_info = next(
            (
                provider
                for provider in self._session.model_registry.auth_storage.get_oauth_providers()
                if provider.id == provider_id
            ),
            None,
        )
        previous_model = self._session.model
        uses_callback_server = bool(getattr(provider_info, "uses_callback_server", False))

        dialog = LoginDialogComponent(
            self._ui,
            provider_id,
            lambda _success, _message: None,
            provider_name=provider_name,
        )
        self._editor_container.clear()
        self._editor_container.add_child(dialog)
        self._ui.set_focus(dialog)
        self._ui.request_render()

        loop = asyncio.get_running_loop()
        manual_code_future: asyncio.Future[str] = loop.create_future()

        def resolve_manual(value: str) -> None:
            if not manual_code_future.done():
                manual_code_future.set_result(value)

        def reject_manual(error: BaseException) -> None:
            if not manual_code_future.done():
                manual_code_future.set_exception(error)

        class _LoginCallbacks(OAuthLoginCallbacks):
            def on_auth(self, info: OAuthAuthInfo) -> None:
                dialog.show_auth(info.get("url", ""), info.get("instructions"))
                if uses_callback_server:

                    async def wait_for_manual() -> None:
                        try:
                            value = await dialog.show_manual_input(
                                "Paste redirect URL below, or complete login in browser:"
                            )
                            if value:
                                resolve_manual(value)
                        except Exception as error:
                            reject_manual(
                                error
                                if isinstance(error, BaseException)
                                else RuntimeError(str(error))
                            )

                    asyncio.create_task(wait_for_manual())

            def on_device_code(self, info: OAuthDeviceCodeInfo) -> None:
                dialog.show_device_code(info)
                dialog.show_waiting("Waiting for authentication...")

            async def on_prompt(self, prompt: dict[str, str]) -> str:
                return await dialog.show_prompt(prompt["message"], prompt.get("placeholder"))

            def on_progress(self, message: str) -> None:
                dialog.show_progress(message)

            async def on_select(self, prompt: OAuthSelectPrompt) -> str | None:
                return await self_outer._show_oauth_login_select(dialog, prompt)

            async def on_manual_code_input(self) -> str:
                return await manual_code_future

            @property
            def signal(self) -> Any:
                return dialog.signal

        self_outer = self
        callbacks = _LoginCallbacks()

        try:
            await self._session.model_registry.auth_storage.login(provider_id, callbacks)
            self._restore_editor()
            await self._complete_provider_authentication(
                provider_id, provider_name, "oauth", previous_model
            )
        except Exception as error:
            self._restore_editor()
            error_msg = str(error)
            if error_msg != "Login cancelled":
                self._show_error(f"Failed to login to {provider_name}: {error_msg}")

    def _handle_changelog_command(self) -> None:
        if self._chat_container is None:
            return
        entries = list(reversed(parse_changelog(get_changelog_path())))
        changelog_markdown = (
            format_changelog_markdown(entries) if entries else "No changelog entries found."
        )
        self._chat_container.add_child(Spacer(1))
        self._chat_container.add_child(DynamicBorder())
        self._chat_container.add_child(
            Text(theme.bold(theme.fg("accent", "What's New")), padding_x=1, padding_y=0)
        )
        self._chat_container.add_child(Spacer(1))
        self._chat_container.add_child(Markdown(changelog_markdown, 1, 1, get_markdown_theme()))
        self._chat_container.add_child(DynamicBorder())
        if self._ui is not None:
            self._ui.request_render()

    async def _handle_share_command(self) -> None:
        if self._ui is None or self._editor_container is None:
            return
        try:
            auth_result = subprocess.run(
                ["gh", "auth", "status"],
                capture_output=True,
                text=True,
                check=False,
            )
            if auth_result.returncode != 0:
                self._show_error("GitHub CLI is not logged in. Run 'gh auth login' first.")
                return
        except FileNotFoundError:
            self._show_error(
                "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/"
            )
            return

        tmp_file = Path(tempfile.gettempdir()) / "session.html"
        try:
            await self._session.export_to_html(str(tmp_file))
        except Exception as error:
            self._show_error(f"Failed to export session: {error}")
            return

        loader = BorderedLoader(self._ui, theme, "Creating gist...")
        self._editor_container.clear()
        self._editor_container.add_child(loader)
        self._ui.set_focus(loader)
        self._ui.request_render()

        def restore_editor() -> None:
            loader.dispose()
            self._restore_editor()
            try:
                tmp_file.unlink(missing_ok=True)
            except OSError:
                pass

        proc: subprocess.Popen[str] | None = None

        def on_abort() -> None:
            if proc is not None and proc.poll() is None:
                proc.kill()
            restore_editor()
            self._show_status(theme.fg("warning", "Share cancelled"))

        loader.set_on_abort(on_abort)

        try:
            proc = subprocess.Popen(
                ["gh", "gist", "create", "--public=false", str(tmp_file)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            stdout, stderr = await asyncio.to_thread(proc.communicate)
            if loader.signal.aborted:
                return
            restore_editor()
            if proc.returncode != 0:
                self._show_error(f"Failed to create gist: {stderr.strip() or 'Unknown error'}")
                return
            gist_url = stdout.strip()
            gist_id = gist_url.rsplit("/", 1)[-1] if gist_url else ""
            if not gist_id:
                self._show_error("Failed to parse gist ID from gh output")
                return
            preview_url = get_share_viewer_url(gist_id)
            self._show_status(f"Share URL: {preview_url}\nGist: {gist_url}")
        except Exception as error:
            if not loader.signal.aborted:
                restore_editor()
                self._show_error(f"Failed to create gist: {error}")

    def _show_scoped_models_selector(self) -> None:
        if self._ui is None:
            return
        asyncio.create_task(self._open_scoped_models_selector())

    async def _open_scoped_models_selector(self) -> None:
        if self._ui is None:
            return
        await asyncio.to_thread(self._session.model_registry.refresh)
        all_models = self._session.model_registry.get_available()
        if not all_models:
            self._show_status(theme.fg("warning", "No models available"))
            return

        session_scoped = self._session.scoped_models
        current_enabled_ids: list[str] | None = None
        if session_scoped:
            current_enabled_ids = [
                f"{item['model'].get('provider', '')}/{item['model'].get('id', '')}"
                for item in session_scoped
            ]
        else:
            patterns = self._session.settings_manager.get_enabled_models()
            if patterns:
                scoped = resolve_model_scope(patterns, self._session.model_registry)
                current_enabled_ids = [
                    f"{item.model.get('provider', '')}/{item.model.get('id', '')}"
                    for item in scoped
                ]

        def create(done: Callable[[], None]) -> tuple[Container, Container]:
            def update_session_models(enabled_ids: list[str] | None) -> None:
                if enabled_ids and len(enabled_ids) > 0 and len(enabled_ids) < len(all_models):
                    scoped = resolve_model_scope(enabled_ids, self._session.model_registry)
                    self._session.set_scoped_models(
                        [{"model": item.model, "thinkingLevel": item.thinking_level} for item in scoped]
                    )
                else:
                    self._session.set_scoped_models([])
                if self._ui is not None:
                    self._ui.request_render()

            def on_change(enabled_ids: list[str] | None) -> None:
                update_session_models(enabled_ids)

            def on_persist(enabled_ids: list[str] | None) -> None:
                all_ids = [
                    f"{model.get('provider', '')}/{model.get('id', '')}" for model in all_models
                ]
                if enabled_ids is None or len(enabled_ids) == len(all_ids):
                    self._session.settings_manager.set_enabled_models(None)
                else:
                    self._session.settings_manager.set_enabled_models(list(enabled_ids))
                self._session.settings_manager.save()
                self._show_status(theme.fg("success", "Scoped models saved to settings"))

            selector = ScopedModelsSelectorComponent(
                self._ui,
                all_models,
                current_enabled_ids,
                on_change,
                on_persist,
                done,
            )
            return selector, selector

        self._show_selector(create)

    async def _handle_bash_command(
        self, command: str, *, exclude_from_context: bool = False
    ) -> None:
        if self._ui is None or self._chat_container is None:
            return
        if self._session.is_bash_running:
            self._show_status(
                theme.fg(
                    "warning", "A bash command is already running. Press Esc to cancel it first."
                )
            )
            return

        runner = self._session.extension_runner
        event_result = None
        if runner is not None:
            event_result = await runner.emit_user_bash(
                {
                    "type": "user_bash",
                    "command": command,
                    "excludeFromContext": exclude_from_context,
                    "cwd": self._session.session_manager.get_cwd(),
                }
            )

        if event_result and event_result.get("result") is not None:
            result = event_result["result"]
            component = BashExecutionComponent(
                command, self._ui, exclude_from_context=exclude_from_context
            )
            self._track_expandable(component)
            self._chat_container.add_child(component)
            if result.output:
                component.append_output(result.output)
            component.set_complete(result.exit_code, cancelled=result.cancelled)
            self._session.record_bash_result(
                command, result, exclude_from_context=exclude_from_context
            )
            if self._ui is not None:
                self._ui.request_render()
            return

        component = BashExecutionComponent(
            command, self._ui, exclude_from_context=exclude_from_context
        )
        self._track_expandable(component)
        self._bash_component = component
        self._chat_container.add_child(component)
        if self._ui is not None:
            self._ui.request_render()

        def on_chunk(chunk: str) -> None:
            component.append_output(chunk)
            if self._ui is not None:
                self._ui.request_render()

        try:
            result = await self._session.execute_bash(
                command,
                on_chunk=on_chunk,
                exclude_from_context=exclude_from_context,
                operations=event_result.get("operations") if event_result else None,
            )
            component.set_complete(result.exit_code, cancelled=result.cancelled)
        except Exception as error:
            component.set_complete(1)
            self._show_status(theme.fg("error", str(error)))
        finally:
            self._bash_component = None
            if self._ui is not None:
                self._ui.request_render()

    def _paste_clipboard_image(self) -> None:
        from pi_mono.coding_agent.utils.clipboard_image import (
            MAX_CLIPBOARD_IMAGE_BYTES,
            extension_for_image_mime_type,
            read_clipboard_image,
        )

        try:
            image = read_clipboard_image()
            if image is None:
                return
            if len(image.bytes) > MAX_CLIPBOARD_IMAGE_BYTES:
                limit_mb = MAX_CLIPBOARD_IMAGE_BYTES // (1024 * 1024)
                self._show_status(
                    theme.fg(
                        "warning",
                        f"Clipboard image is too large (max {limit_mb}MB). "
                        "Save it to a file and reference the path instead.",
                    )
                )
                return

            ext = extension_for_image_mime_type(image.mime_type) or "png"
            file_name = f"pi-clipboard-{uuid.uuid4()}.{ext}"
            file_path = os.path.join(tempfile.gettempdir(), file_name)
            with open(file_path, "wb") as handle:
                handle.write(image.bytes)

            if self._editor is not None:
                self._editor.insert_text_at_cursor(file_path)
            if self._ui is not None:
                self._ui.request_render()
        except Exception as error:
            self._show_status(
                theme.fg("warning", f"Could not paste clipboard image: {error}")
            )

    async def _open_external_editor(self) -> None:
        if self._editor is None or self._ui is None:
            return
        editor_cmd = self._session.settings_manager.get_external_editor_command()
        if not editor_cmd:
            self._show_status(
                theme.fg(
                    "warning",
                    "No editor configured. Set externalEditor in settings.json or $VISUAL/$EDITOR.",
                )
            )
            return
        current_text = self._editor.get_expanded_text()
        tmp_file = Path(tempfile.gettempdir()) / f"pi-editor-{int(time.time() * 1000)}.pi.md"
        try:
            tmp_file.write_text(current_text, encoding="utf-8")
            self._ui.stop()
            sys.stdout.write(
                f"Launching external editor: {editor_cmd}\nPi will resume when the editor exits.\n"
            )
            editor_parts = editor_cmd.split()
            editor = editor_parts[0]
            editor_args = editor_parts[1:]
            if sys.platform == "win32":
                process = await asyncio.create_subprocess_shell(
                    subprocess.list2cmdline([editor, *editor_args, str(tmp_file)]),
                    stdin=None,
                    stdout=None,
                    stderr=None,
                )
            else:
                process = await asyncio.create_subprocess_exec(
                    editor,
                    *editor_args,
                    str(tmp_file),
                    stdin=None,
                    stdout=None,
                    stderr=None,
                )
            status = await process.wait()
            if status == 0:
                new_content = tmp_file.read_text(encoding="utf-8").rstrip("\n")
                self._editor.set_text(new_content)
        finally:
            try:
                tmp_file.unlink(missing_ok=True)
            except OSError:
                pass
            self._ui.start()
            self._ui.request_render(force=True)

    def _append_system_message(self, text: str) -> None:
        if self._chat_container is None:
            return
        self._chat_container.add_child(Text(theme.fg("muted", text), padding_x=1, padding_y=0))

    async def _handle_prompt(self, text: str, images: list[ImageContent] | None = None) -> None:
        try:
            from pi_mono.coding_agent.core.agent_session import PromptOptions

            await self._session.prompt(text, PromptOptions(images=images))
        except Exception as error:
            self._show_status(theme.fg("error", str(error)))

    async def _shutdown(self, *, from_signal: bool = False, signum: int | None = None) -> None:
        if self._is_shutting_down:
            return
        self._is_shutting_down = True

        if from_signal:
            theme_controller = getattr(self, "_theme_controller", None)
            if theme_controller is not None:
                theme_controller.disable_auto_sync()
            await self._runtime_host.dispose()
            await self._drain_terminal_input()
            await self.stop()
            sys.exit(129 if signum == signal.SIGHUP else 143)

        await self._drain_terminal_input()
        theme_controller = getattr(self, "_theme_controller", None)
        if theme_controller is not None:
            theme_controller.disable_auto_sync()
        await self.stop()
        await self._runtime_host.dispose()
        resume_command = format_resume_command(self._session.session_manager)
        if resume_command:
            sys.stdout.write(f"{theme.fg('dim', 'To resume this session:')} {resume_command}\n")


async def run_interactive_mode(
    runtime_host: AgentSessionRuntime,
    options: InteractiveModeOptions | None = None,
) -> None:
    mode = InteractiveMode(runtime_host, options)
    try:
        await mode.run()
    finally:
        if not mode._is_shutting_down:
            await mode._drain_terminal_input()
            await mode.stop()
            await runtime_host.dispose()
