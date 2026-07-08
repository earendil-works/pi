import os
import tempfile

import pytest

from pi_mono.config import CONFIG_DIR_NAME
from pi_mono.coding_agent.core.agent_session import (
    AgentSessionRuntime,
    SessionImportFileNotFoundError,
)
from pi_mono.coding_agent.core.extensions.project_trust_event import emit_project_trust_event
from pi_mono.coding_agent.core.extensions.types import (
    Extension,
    ExtensionRuntime,
    LoadExtensionsResult,
    ProjectTrustEvent,
)
from pi_mono.coding_agent.core.project_trust import ProjectTrustContext, resolve_project_trusted
from pi_mono.coding_agent.core.project_trust import ResolveProjectTrustedOptions
from pi_mono.coding_agent.core.source_info import SourceInfo
from pi_mono.coding_agent.core.trust_manager import ProjectTrustStore


def _make_extension(path: str, handlers: dict) -> Extension:
    return Extension(
        path=path,
        resolved_path=path,
        source_info=SourceInfo(
            path=path,
            source=path,
            scope="project",
            origin="top-level",
        ),
        handlers=handlers,
    )


class _SelectUI:
    def __init__(self, label: str) -> None:
        self._label = label

    async def select(self, _title: str, options: list[str]) -> str | None:
        return self._label if self._label in options else None


@pytest.mark.anyio
async def test_emit_project_trust_event_returns_first_decisive_handler() -> None:
    async def trusted_handler(_event, _ctx):
        return {"trusted": "yes", "remember": True}

    extension = _make_extension("/ext/trust.py", {"project_trust": [trusted_handler]})
    extensions_result = LoadExtensionsResult(
        extensions=[extension],
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
    assert result.trusted == "yes"
    assert result.remember is True


@pytest.mark.anyio
async def test_resolve_project_trusted_uses_extension_result() -> None:
    with tempfile.TemporaryDirectory() as agent_dir:
        project_cwd = os.path.join(agent_dir, "project")
        os.makedirs(os.path.join(project_cwd, CONFIG_DIR_NAME, "extensions"))
        trust_store = ProjectTrustStore(agent_dir)

        async def deny_handler(_event, _ctx):
            return {"trusted": "no", "remember": True}

        extension = _make_extension("/ext/deny.py", {"project_trust": [deny_handler]})
        extensions_result = LoadExtensionsResult(
            extensions=[extension],
            errors=[],
            runtime=ExtensionRuntime(),
        )
        trusted = await resolve_project_trusted(
            ResolveProjectTrustedOptions(
                cwd=project_cwd,
                trust_store=trust_store,
                project_trust_context=ProjectTrustContext(has_ui=False),
                extensions_result=extensions_result,
            )
        )
        assert trusted is False
        assert trust_store.get(project_cwd) is False


@pytest.mark.anyio
async def test_import_from_jsonl_raises_for_missing_file() -> None:
    class _SessionManager:
        def get_session_dir(self) -> str:
            return "/tmp"

    class _Session:
        cwd = "/tmp"
        session_file = None
        session_manager = _SessionManager()

    runtime = AgentSessionRuntime(
        session=_Session(),  # type: ignore[arg-type]
        services=object(),
        diagnostics=[],
    )
    with pytest.raises(SessionImportFileNotFoundError):
        await runtime.import_from_jsonl("/tmp/does-not-exist-session.jsonl")
