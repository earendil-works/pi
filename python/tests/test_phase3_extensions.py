"""Phase 3 extension ecosystem tests."""

from __future__ import annotations

import asyncio
import os
import textwrap
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from pi_mono.agent.agent import Agent
from pi_mono.coding_agent.core.agent_session import AgentSession, AgentSessionConfig, PromptOptions
from pi_mono.coding_agent.core.extensions import (
    ExtensionRunner,
    create_extension_runtime,
    discover_and_load_extensions,
    discover_extensions_in_dir,
    load_extension_from_factory,
)
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
)
from pi_mono.coding_agent.modes.interactive.components.custom_message import CustomMessageComponent
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.event_bus import create_event_bus
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _model() -> dict[str, Any]:
    return {
        "id": "test-model",
        "name": "test-model",
        "api": "openai-completions",
        "provider": "openai",
        "baseUrl": "https://example.com",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128000,
        "maxTokens": 16384,
    }


def _write_extension(tmp_path: Any, name: str, body: str) -> str:
    ext_dir = tmp_path / "extensions"
    ext_dir.mkdir(exist_ok=True)
    ext_file = ext_dir / f"{name}.py"
    normalized_body = textwrap.dedent(body).strip("\n")
    source = "async def default(pi):\n" + textwrap.indent(normalized_body, "    ") + "\n"
    ext_file.write_text(source, encoding="utf-8")
    return str(ext_dir)


async def _make_session(
    tmp_path: Any,
    *,
    extension_paths: list[str] | None = None,
    no_extensions: bool = False,
) -> AgentSession:
    cwd = str(tmp_path)
    agent_dir = str(tmp_path / "agent")
    os.makedirs(agent_dir, exist_ok=True)
    settings_manager = SettingsManager.create(cwd, agent_dir)
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd, agent_dir=agent_dir, settings_manager=settings_manager
        )
    )
    await resource_loader.reload()
    agent = Agent(
        {
            "initialState": {
                "systemPrompt": "test",
                "model": _model(),
                "thinkingLevel": "off",
                "tools": [],
            }
        }
    )
    return AgentSession(
        AgentSessionConfig(
            agent=agent,
            session_manager=SessionManager.in_memory(cwd),
            settings_manager=settings_manager,
            cwd=cwd,
            model_registry=ModelRegistry.in_memory(AuthStorage.create()),
            resource_loader=resource_loader,
            extension_paths=extension_paths,
            no_extensions=no_extensions,
        )
    )


def test_discover_python_extension_file(tmp_path):
    ext_dir = _write_extension(tmp_path, "demo", "pass")
    assert discover_extensions_in_dir(ext_dir) == [f"{ext_dir}/demo.py"]


def test_emit_input_handled_skips_prompt(tmp_path):
    ext_dir = _write_extension(
        tmp_path,
        "input_ext",
        """
        def on_input(event, ctx):
            return {"action": "handled"}
        pi.on("input", on_input)
        """,
    )

    async def run() -> None:
        session = await _make_session(tmp_path, extension_paths=[ext_dir])
        await session.bind_extensions()
        runner = session.extension_runner
        assert runner is not None
        result = await runner.emit_input("hello", None, "interactive", None)
        assert result.get("action") == "handled"

    asyncio.run(run())


def test_before_agent_start_injects_custom_message(tmp_path):
    ext_dir = _write_extension(
        tmp_path,
        "before_start",
        """
        def on_before(event, ctx):
            return {
                "message": {
                    "customType": "hint",
                    "content": "be brief",
                    "display": True,
                },
                "systemPrompt": event["systemPrompt"] + "\\nExtra.",
            }
        pi.on("before_agent_start", on_before)
        """,
    )

    async def run() -> None:
        session = await _make_session(tmp_path, extension_paths=[ext_dir])
        await session.bind_extensions()

        captured: list[Any] = []

        async def fake_prompt(messages: Any, images=None) -> None:
            del images
            captured.append(messages)

        session.agent.prompt = fake_prompt  # type: ignore[method-assign]
        await session.prompt("hello", PromptOptions(expand_templates=False))

        assert len(captured) == 1
        messages = captured[0]
        assert isinstance(messages, list)
        assert messages[0]["role"] == "user"
        assert messages[1]["role"] == "custom"
        assert messages[1]["customType"] == "hint"
        assert session.agent.state.systemPrompt.endswith("Extra.")

    asyncio.run(run())


def test_send_custom_message_appends_without_turn(tmp_path):
    async def run() -> None:
        session = await _make_session(tmp_path, no_extensions=True)
        await session.bind_extensions(no_extensions=True)
        events: list[str] = []

        def listener(event: dict[str, Any]) -> None:
            events.append(str(event.get("type")))

        session.subscribe(listener)
        await session.send_custom_message(
            {
                "customType": "status",
                "content": "ok",
                "display": True,
            }
        )
        assert len(session.agent.state.messages) == 1
        assert session.agent.state.messages[0]["role"] == "custom"
        assert events == ["message_start", "message_end"]

    asyncio.run(run())


def test_extension_actions_append_entry_and_set_label(tmp_path):
    async def run() -> None:
        session = await _make_session(tmp_path, no_extensions=True)
        await session.bind_extensions(no_extensions=True)
        runner = session.extension_runner
        assert runner is not None
        runner._runtime.append_entry("note", {"text": "hello"})
        leaf_id = session.session_manager.get_leaf_id()
        assert leaf_id is not None
        runner._runtime.set_label(leaf_id, "checkpoint")
        assert session.session_manager.get_label(leaf_id) == "checkpoint"

    asyncio.run(run())


def test_tool_call_hook_blocks_execution(tmp_path):
    ext_dir = _write_extension(
        tmp_path,
        "tool_block",
        """
        def on_tool_call(event, ctx):
            if event["toolName"] == "bash":
                return {"block": True, "reason": "blocked by test"}
            return None
        pi.on("tool_call", on_tool_call)
        """,
    )

    async def run() -> None:
        session = await _make_session(tmp_path, extension_paths=[ext_dir])
        await session.bind_extensions()
        assert session.agent.beforeToolCall is not None
        result = await session.agent.beforeToolCall(
            {
                "assistantMessage": {"role": "assistant", "content": []},
                "toolCall": {"type": "toolCall", "id": "1", "name": "bash", "arguments": {}},
                "args": {},
                "context": {"messages": [], "tools": []},
            },
            None,
        )
        assert result is not None
        assert result.get("block") is True

    asyncio.run(run())


def test_emit_before_provider_request(tmp_path):
    ext_dir = _write_extension(
        tmp_path,
        "provider",
        """
        def on_before_provider(event, ctx):
            return {**event["payload"], "modified": True}
        pi.on("before_provider_request", on_before_provider)
        """,
    )

    async def run() -> None:
        load_result = await discover_and_load_extensions([ext_dir], cwd=str(tmp_path))
        runner = ExtensionRunner(
            load_result.extensions,
            load_result.runtime,
            str(tmp_path),
            SessionManager.in_memory(str(tmp_path)),
            ModelRegistry.in_memory(AuthStorage.create()),
        )
        payload = {"messages": []}
        result = await runner.emit_before_provider_request(payload)
        assert result.get("modified") is True

    asyncio.run(run())


def test_emit_before_provider_headers(tmp_path):
    ext_dir = _write_extension(
        tmp_path,
        "headers",
        """
        def on_before_headers(event, ctx):
            event["headers"]["x-trace"] = "1"
        pi.on("before_provider_headers", on_before_headers)
        """,
    )

    async def run() -> None:
        load_result = await discover_and_load_extensions([ext_dir], cwd=str(tmp_path))
        runner = ExtensionRunner(
            load_result.extensions,
            load_result.runtime,
            str(tmp_path),
            SessionManager.in_memory(str(tmp_path)),
            ModelRegistry.in_memory(AuthStorage.create()),
        )
        assert runner.has_handlers("before_provider_headers")
        headers = await runner.emit_before_provider_headers({"Authorization": "Bearer x"})
        assert headers == {"Authorization": "Bearer x", "x-trace": "1"}

    asyncio.run(run())


def test_register_entry_renderer(tmp_path):
    ext_dir = _write_extension(
        tmp_path,
        "entry",
        """
        def render_note(entry, options, theme):
            return f"note:{entry.get('data')}"
        pi.register_entry_renderer("note", render_note)
        """,
    )

    async def run() -> None:
        load_result = await discover_and_load_extensions([ext_dir], cwd=str(tmp_path))
        runner = ExtensionRunner(
            load_result.extensions,
            load_result.runtime,
            str(tmp_path),
            SessionManager.in_memory(str(tmp_path)),
            ModelRegistry.in_memory(AuthStorage.create()),
        )
        renderer = runner.get_entry_renderer("note")
        assert renderer is not None
        assert renderer({"customType": "note", "data": "hi"}, {"expanded": False}, None) == "note:hi"

    asyncio.run(run())


def test_get_shortcuts_skips_builtin_conflicts(tmp_path):
    ext_dir = _write_extension(
        tmp_path,
        "shortcut",
        """
        pi.register_shortcut("ctrl+l", {"handler": lambda ctx: None, "description": "test"})
        """,
    )

    async def run() -> None:
        load_result = await discover_and_load_extensions([ext_dir], cwd=str(tmp_path))
        runner = ExtensionRunner(
            load_result.extensions,
            load_result.runtime,
            str(tmp_path),
            SessionManager.in_memory(str(tmp_path)),
            ModelRegistry.in_memory(AuthStorage.create()),
        )
        shortcuts = runner.get_shortcuts({"app.model.select": "ctrl+l"})
        assert "ctrl+l" not in shortcuts
        assert len(runner.get_shortcut_diagnostics()) == 1

    asyncio.run(run())


def test_custom_message_component_fallback_renderer():
    message = {
        "role": "custom",
        "customType": "status",
        "content": "Build passed",
        "display": True,
    }
    component = CustomMessageComponent(message, renderer=None)
    component.invalidate()
    assert component is not None


def test_custom_message_component_custom_renderer():
    message = {
        "role": "custom",
        "customType": "status",
        "content": "ignored",
        "display": True,
    }

    def renderer(msg, _opts, _theme):
        return f"Rendered: {msg['customType']}"

    component = CustomMessageComponent(message, renderer=renderer)
    component.invalidate()
    assert component is not None


def test_get_context_usage_without_model(tmp_path):
    async def run() -> None:
        session = await _make_session(tmp_path, no_extensions=True)
        session.agent.state.model = None
        assert session.get_context_usage() is None

    asyncio.run(run())


def test_emit_extension_event_forwards_tool_execution(tmp_path):
    seen: list[str] = []

    def factory(pi):
        def on_tool_start(event, _ctx):
            seen.append(event["toolCallId"])

        pi.on("tool_execution_start", on_tool_start)

    async def run() -> None:
        ext_dir = tmp_path / "extensions"
        ext_dir.mkdir()
        runtime = create_extension_runtime()
        extension = await load_extension_from_factory(
            factory,
            str(ext_dir),
            create_event_bus(),
            runtime,
            "<inline-test>",
        )
        runner = ExtensionRunner(
            [extension],
            runtime,
            str(tmp_path),
            SessionManager.in_memory(str(tmp_path)),
            ModelRegistry.in_memory(AuthStorage.create()),
        )
        await runner.emit(
            {
                "type": "tool_execution_start",
                "toolCallId": "call-1",
                "toolName": "bash",
                "args": {},
            }
        )
        assert seen == ["call-1"]

    asyncio.run(run())


def test_sdk_stream_fn_wraps_before_provider_request():
    captured: dict[str, Any] = {}

    async def fake_emit(payload: Any) -> Any:
        captured["payload"] = payload
        return {**payload, "tagged": True}

    runner = MagicMock()
    runner.has_handlers.return_value = True
    runner.emit_before_provider_request = AsyncMock(side_effect=fake_emit)
    extension_runner_ref: list[Any] = [runner]

    async def run() -> None:
        async def on_payload(payload: Any, _model: Any) -> Any:
            current_runner = extension_runner_ref[0]
            if current_runner is None or not current_runner.has_handlers("before_provider_request"):
                return payload
            return await current_runner.emit_before_provider_request(payload)

        result = await on_payload({"messages": []}, _model())
        assert result.get("tagged") is True
        runner.emit_before_provider_request.assert_awaited_once()

    asyncio.run(run())
