import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.coding_agent.modes.print_mode import PrintModeOptions, run_print_mode
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager


@pytest.mark.anyio
async def test_print_mode_outputs_faux_response(tmp_path, capsys):
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        faux.set_responses([faux_assistant_message("print-mode-ok")])
        model = faux.get_model()
        assert model is not None

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        model_registry = ModelRegistry.create(auth_storage)

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                no_extensions=True,
                no_tools="all",
            )
        )
        runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
        exit_code = await run_print_mode(
            runtime,
            PrintModeOptions(mode="text", initial_message="hello"),
        )
        captured = capsys.readouterr()
        assert exit_code == 0
        assert "print-mode-ok" in captured.out
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_print_mode_fails_without_model(tmp_path, capsys):
    auth_storage = AuthStorage.create()
    model_registry = ModelRegistry.create(auth_storage)
    model_registry.refresh()

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
            auth_storage=auth_storage,
            model_registry=model_registry,
            no_extensions=True,
            no_tools="all",
        )
    )
    result.session.agent.state.model = None
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    exit_code = await run_print_mode(
        runtime,
        PrintModeOptions(mode="text", initial_message="hello"),
    )
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.err
