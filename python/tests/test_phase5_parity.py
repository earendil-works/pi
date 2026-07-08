"""Phase 5 parity tests ported from high-value TypeScript suites."""

from __future__ import annotations

import os
import tempfile
from typing import Any

import pytest

from pi_mono.agent.harness.messages import create_user_message
from pi_mono.coding_agent.cli.args import parse_args
from pi_mono.coding_agent.core.extensions.project_trust_event import emit_project_trust_event
from pi_mono.coding_agent.core.extensions.types import (
    Extension,
    ExtensionRuntime,
    LoadExtensionsResult,
    ProjectTrustEvent,
)
from pi_mono.coding_agent.core.project_trust import ProjectTrustContext
from pi_mono.coding_agent.core.source_info import SourceInfo
from pi_mono.coding_agent.core.trust_manager import (
    ProjectTrustStore,
    has_trust_requiring_project_resources,
)
from pi_mono.coding_agent.modes.rpc.rpc_mode import RpcMode, build_error_response, parse_rpc_command
from pi_mono.config import CONFIG_DIR_NAME
from pi_mono.core.session_manager import SessionManager


def _assistant_message(*, text: str = "hi", usage: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "api": "anthropic-messages",
        "provider": "anthropic",
        "model": "test",
        "usage": usage
        or {
            "input": 1,
            "output": 1,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 2,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
        "stopReason": "stop",
        "timestamp": 2,
    }


class TestArgsParity:
    """Ported from packages/coding-agent/test/args.test.ts."""

    def test_version_and_help_flags(self) -> None:
        assert parse_args(["--version"]).version is True
        assert parse_args(["-v"]).version is True
        assert parse_args(["--help"]).help is True
        assert parse_args(["-h"]).help is True

    def test_print_flag_with_yaml_frontmatter_prompt(self) -> None:
        prompt = "---\ntitle: hello\n---\nSay hi."
        parsed = parse_args(["-p", prompt])
        assert parsed.print_mode is True
        assert parsed.messages == [prompt]
        assert parsed.unknown_flags == {}

    def test_print_does_not_consume_options_as_prompts(self) -> None:
        parsed = parse_args(["-p", "--provider", "openai", "Say hi."])
        assert parsed.print_mode is True
        assert parsed.provider == "openai"
        assert parsed.messages == ["Say hi."]

    def test_continue_and_resume_flags(self) -> None:
        assert parse_args(["--continue"]).continue_session is True
        assert parse_args(["-c"]).continue_session is True
        assert parse_args(["--resume"]).resume is True
        assert parse_args(["-r"]).resume is True

    def test_flag_values(self) -> None:
        parsed = parse_args(
            [
                "--provider",
                "openai",
                "--model",
                "gpt-4o",
                "--api-key",
                "sk-test",
                "--system-prompt",
                "You are helpful",
                "--append-system-prompt",
                "Context A",
                "--append-system-prompt",
                "Context B",
                "--mode",
                "rpc",
                "--session",
                "/tmp/session.jsonl",
                "--session-id",
                "orchestrated",
                "--fork",
                "abcd1234",
                "--export",
                "out.jsonl",
                "--thinking",
                "high",
                "--models",
                "gpt-4o,claude-sonnet",
            ]
        )
        assert parsed.provider == "openai"
        assert parsed.model == "gpt-4o"
        assert parsed.api_key == "sk-test"
        assert parsed.system_prompt == "You are helpful"
        assert parsed.append_system_prompt == ["Context A", "Context B"]
        assert parsed.mode == "rpc"
        assert parsed.session == "/tmp/session.jsonl"
        assert parsed.session_id == "orchestrated"
        assert parsed.fork == "abcd1234"
        assert parsed.export == "out.jsonl"
        assert parsed.thinking == "high"
        assert parsed.models == ["gpt-4o", "claude-sonnet"]

    def test_name_flag(self) -> None:
        assert parse_args(["--name", "my-session"]).name == "my-session"
        assert parse_args(["-n", "quick"]).name == "quick"
        assert parse_args(["--name", ""]).name == ""
        missing = parse_args(["--name"])
        assert any(item["message"] == "--name requires a value" for item in missing.diagnostics)

    def test_no_session_flag(self) -> None:
        assert parse_args(["--no-session"]).no_session is True

    def test_extension_and_skill_flags(self) -> None:
        parsed = parse_args(
            [
                "--extension",
                "./ext1.py",
                "-e",
                "./ext2.py",
                "--skill",
                "./skill-a",
                "--skill",
                "./skill-b",
                "--prompt-template",
                "./one",
                "--prompt-template",
                "./two",
                "--theme",
                "./dark.json",
                "--theme",
                "./light.json",
            ]
        )
        assert parsed.extensions == ["./ext1.py", "./ext2.py"]
        assert parsed.skills == ["./skill-a", "./skill-b"]
        assert parsed.prompt_templates == ["./one", "./two"]
        assert parsed.themes == ["./dark.json", "./light.json"]

    def test_disable_resource_flags(self) -> None:
        parsed = parse_args(
            [
                "--no-extensions",
                "-e",
                "foo.py",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
            ]
        )
        assert parsed.no_extensions is True
        assert parsed.extensions == ["foo.py"]
        assert parsed.no_skills is True
        assert parsed.no_prompt_templates is True
        assert parsed.no_themes is True
        assert parsed.no_context_files is True
        assert parse_args(["-nc"]).no_context_files is True

    def test_project_approval_flags(self) -> None:
        assert parse_args(["--approve"]).project_trust_override is True
        assert parse_args(["-a"]).project_trust_override is True
        assert parse_args(["--no-approve"]).project_trust_override is False
        assert parse_args(["-na"]).project_trust_override is False

    def test_tool_flags(self) -> None:
        parsed = parse_args(
            [
                "--no-tools",
                "--tools",
                "read,bash",
                "--exclude-tools",
                "grep",
                "--no-builtin-tools",
            ]
        )
        assert parsed.no_tools is True
        assert parsed.tools == ["read", "bash"]
        assert parsed.exclude_tools == ["grep"]
        assert parsed.no_builtin_tools is True
        assert parse_args(["-nt"]).no_tools is True
        assert parse_args(["-nbt"]).no_builtin_tools is True
        assert parse_args(["-t", "read,bash"]).tools == ["read", "bash"]
        assert parse_args(["-xt", "read,bash"]).exclude_tools == ["read", "bash"]

    def test_messages_file_args_and_unknown_flags(self) -> None:
        parsed = parse_args(["hello", "world"])
        assert parsed.messages == ["hello", "world"]

        parsed = parse_args(["@README.md", "@src/main.py"])
        assert parsed.file_args == ["README.md", "src/main.py"]

        parsed = parse_args(["@file.txt", "explain this", "@image.png"])
        assert parsed.file_args == ["file.txt", "image.png"]
        assert parsed.messages == ["explain this"]

        parsed = parse_args(["--unknown-flag", "message"])
        assert parsed.messages == []
        assert parsed.unknown_flags.get("unknown-flag") == "message"

        parsed = parse_args(["--unknown-flag"])
        assert parsed.unknown_flags.get("unknown-flag") is True

        parsed = parse_args(["--unknown-flag=value"])
        assert parsed.unknown_flags.get("unknown-flag") == "value"

    def test_complex_flag_combination(self) -> None:
        parsed = parse_args(
            [
                "--provider",
                "anthropic",
                "--model",
                "claude-sonnet",
                "--print",
                "--thinking",
                "high",
                "@prompt.md",
                "Do the task",
            ]
        )
        assert parsed.provider == "anthropic"
        assert parsed.model == "claude-sonnet"
        assert parsed.print_mode is True
        assert parsed.thinking == "high"
        assert parsed.file_args == ["prompt.md"]
        assert parsed.messages == ["Do the task"]


class TestRpcParity:
    """Ported from packages/coding-agent/test/suite/regressions/5868-rpc-unknown-command-id.test.ts."""

    def test_unknown_command_preserves_request_id(self) -> None:
        response = build_error_response("test", "foobar", "Unknown command: foobar")
        assert response == {
            "id": "test",
            "type": "response",
            "command": "foobar",
            "success": False,
            "error": "Unknown command: foobar",
        }

    @pytest.mark.anyio
    async def test_rpc_mode_unknown_command_returns_error_with_id(self, tmp_path: Any) -> None:
        from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
        from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                session_manager=SessionManager.in_memory(str(tmp_path)),
            )
        )
        runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
        mode = RpcMode(runtime)

        response = await mode.handle_command(parse_rpc_command('{"id":"test","type":"foobar"}'))
        assert response is not None
        assert response["id"] == "test"
        assert response["success"] is False
        assert response["error"] == "Unknown command: foobar"


class TestTrustManagerParity:
    """Ported from packages/coding-agent/test/trust-manager.test.ts."""

    def test_stores_decisions_and_inherits_from_parent_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            agent_dir = os.path.join(temp_dir, "agent")
            parent_dir = os.path.join(temp_dir, "trusted-parent")
            child_dir = os.path.join(parent_dir, "project")
            os.makedirs(agent_dir)
            os.makedirs(child_dir)

            store = ProjectTrustStore(agent_dir)
            assert store.get(child_dir) is None
            store.set(parent_dir, True)
            assert store.get(child_dir) is True
            store.set(child_dir, False)
            assert store.get(child_dir) is False
            store.set(child_dir, None)
            assert store.get(child_dir) is True

    def test_detects_trust_requiring_project_resources(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            original_home = os.environ.get("HOME")
            cwd = os.path.join(temp_dir, "project")
            os.makedirs(cwd)
            os.environ["HOME"] = temp_dir
            try:
                os.makedirs(os.path.join(temp_dir, CONFIG_DIR_NAME, "agent"), exist_ok=True)
                os.makedirs(os.path.join(temp_dir, ".agents", "skills"), exist_ok=True)
                assert has_trust_requiring_project_resources(temp_dir) is False
                assert has_trust_requiring_project_resources(cwd) is False

                settings_path = os.path.join(temp_dir, CONFIG_DIR_NAME, "settings.json")
                with open(settings_path, "w", encoding="utf-8") as handle:
                    handle.write("{}")
                assert has_trust_requiring_project_resources(temp_dir) is True
                os.remove(settings_path)

                project_config = os.path.join(cwd, CONFIG_DIR_NAME)
                os.makedirs(project_config, exist_ok=True)
                with open(
                    os.path.join(project_config, "settings.json"), "w", encoding="utf-8"
                ) as handle:
                    handle.write("{}")
                assert has_trust_requiring_project_resources(cwd) is True

                import shutil

                shutil.rmtree(project_config)
                os.makedirs(os.path.join(cwd, ".agents", "skills"), exist_ok=True)
                assert has_trust_requiring_project_resources(cwd) is True
            finally:
                if original_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = original_home


class TestExtensionsParity:
    """Ported from packages/coding-agent/test/extensions-runner.test.ts (project_trust)."""

    @pytest.mark.anyio
    async def test_project_trust_skips_undecided_handlers(self) -> None:
        async def undecided_handler(
            _event: ProjectTrustEvent, _ctx: ProjectTrustContext
        ) -> dict[str, Any]:
            return {"trusted": "undecided", "remember": True}

        async def decided_handler(
            _event: ProjectTrustEvent, _ctx: ProjectTrustContext
        ) -> dict[str, Any]:
            return {"trusted": "no", "remember": True}

        extensions_result = LoadExtensionsResult(
            extensions=[
                Extension(
                    path="/undecided.py",
                    resolved_path="/undecided.py",
                    source_info=SourceInfo(
                        path="/undecided.py",
                        source="/undecided.py",
                        scope="project",
                        origin="top-level",
                    ),
                    handlers={"project_trust": [undecided_handler]},
                ),
                Extension(
                    path="/decided.py",
                    resolved_path="/decided.py",
                    source_info=SourceInfo(
                        path="/decided.py",
                        source="/decided.py",
                        scope="project",
                        origin="top-level",
                    ),
                    handlers={"project_trust": [decided_handler]},
                ),
            ],
            errors=[],
            runtime=ExtensionRuntime(),
        )
        result, errors = await emit_project_trust_event(
            extensions_result,
            ProjectTrustEvent(type="project_trust", cwd="/tmp/project"),
            ProjectTrustContext(has_ui=False),
        )
        assert errors == []
        assert result is not None
        assert result.trusted == "no"
        assert result.remember is True


class TestSessionManagerParity:
    """Ported from packages/coding-agent/test/session-manager/*.test.ts."""

    def test_labels_set_get_clear_and_last_wins(self) -> None:
        session = SessionManager.in_memory()
        msg_id = session.append_message(create_user_message("hello"))

        assert session.get_label(msg_id) is None
        label_id = session.append_label_change(msg_id, "checkpoint")
        assert session.get_label(msg_id) == "checkpoint"

        entries = session.get_entries()
        label_entry = next(entry for entry in entries if entry.get("type") == "label")
        assert label_entry["id"] == label_id
        assert label_entry["targetId"] == msg_id
        assert label_entry["label"] == "checkpoint"

        session.append_label_change(msg_id, None)
        assert session.get_label(msg_id) is None

        session.append_label_change(msg_id, "first")
        session.append_label_change(msg_id, "second")
        last_label_id = session.append_label_change(msg_id, "third")
        assert session.get_label(msg_id) == "third"
        last_label_entry = next(
            entry for entry in session.get_entries() if entry.get("id") == last_label_id
        )
        tree = session.get_tree()
        msg_node = next(node for node in tree if node["entry"]["id"] == msg_id)
        assert msg_node["labelTimestamp"] == last_label_entry["timestamp"]

    def test_labels_are_included_in_tree_nodes(self) -> None:
        session = SessionManager.in_memory()
        msg1_id = session.append_message(create_user_message("hello"))
        msg2_id = session.append_message(_assistant_message())

        msg1_label_id = session.append_label_change(msg1_id, "start")
        msg2_label_id = session.append_label_change(msg2_id, "response")

        entries = session.get_entries()
        msg1_label_entry = next(entry for entry in entries if entry.get("id") == msg1_label_id)
        msg2_label_entry = next(entry for entry in entries if entry.get("id") == msg2_label_id)
        tree = session.get_tree()

        msg1_node = next(node for node in tree if node["entry"]["id"] == msg1_id)
        assert msg1_node["label"] == "start"
        assert msg1_node["labelTimestamp"] == msg1_label_entry["timestamp"]

        msg2_node = msg1_node["children"][0]
        assert msg2_node["entry"]["id"] == msg2_id
        assert msg2_node["label"] == "response"
        assert msg2_node["labelTimestamp"] == msg2_label_entry["timestamp"]

    def test_custom_entries_in_tree_and_session_context(self) -> None:
        session = SessionManager.in_memory()
        msg_id = session.append_message(create_user_message("hello"))
        custom_id = session.append_custom_entry("my_data", {"foo": "bar"})
        msg2_id = session.append_message(_assistant_message())

        entries = session.get_entries()
        assert len(entries) == 3
        custom_entry = next(entry for entry in entries if entry.get("type") == "custom")
        assert custom_entry["customType"] == "my_data"
        assert custom_entry["data"] == {"foo": "bar"}
        assert custom_entry["id"] == custom_id
        assert custom_entry["parentId"] == msg_id

        path = session.get_branch()
        assert [entry["id"] for entry in path] == [msg_id, custom_id, msg2_id]

        context = session.build_session_context()
        assert len(context["messages"]) == 2
