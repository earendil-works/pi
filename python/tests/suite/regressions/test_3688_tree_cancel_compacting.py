"""Issue #3688: cancelled tree navigation clears branch-summary compacting state."""

from __future__ import annotations

import textwrap

import pytest

from pi_mono.agent.harness.messages import create_user_message
from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _write_extension(tmp_path, body: str) -> None:
    ext_dir = tmp_path / ".pi" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    ext_file = ext_dir / "tree_cancel.py"
    ext_file.write_text(
        "async def default(pi):\n" + textwrap.indent(body.strip("\n"), "    ") + "\n",
        encoding="utf-8",
    )


@pytest.mark.anyio
async def test_clears_branch_summary_state_when_session_before_tree_cancels(tmp_path) -> None:
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        faux.set_responses([faux_assistant_message("reply")])
        model = faux.get_model()
        assert model is not None

        _write_extension(
            tmp_path,
            """
            async def on_before_tree(_event, _ctx):
                return {"cancel": True}

            pi.on("session_before_tree", on_before_tree)
            """,
        )

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        model_registry = ModelRegistry.create(auth_storage)
        settings_manager = SettingsManager.create(str(tmp_path))

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                agent_dir=str(tmp_path / "agent"),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=settings_manager,
                no_tools="all",
            )
        )
        session = result.session
        await session.bind_extensions()

        first_id = session.session_manager.append_message(create_user_message("first"))
        session.session_manager.append_message(faux_assistant_message("reply"))
        current_leaf_id = session.session_manager.append_message(create_user_message("second"))
        assert session.session_manager.get_leaf_id() == current_leaf_id

        navigation = await session.navigate_tree(first_id, summarize=False)
        assert navigation == {"cancelled": True}
        assert session.is_compacting is False
        assert session.session_manager.get_leaf_id() == current_leaf_id
    finally:
        faux.set_responses([])
