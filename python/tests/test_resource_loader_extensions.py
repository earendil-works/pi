from __future__ import annotations

import pytest

from pi_mono.core.settings_manager import SettingsManager
from pi_mono.coding_agent.core.resource_loader import DefaultResourceLoader, DefaultResourceLoaderOptions


@pytest.mark.anyio
async def test_resource_loader_loads_configured_extensions(tmp_path) -> None:
    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    extension_file = tmp_path / "demo.py"
    extension_file.write_text(
        "async def default(pi):\n"
        "    async def _on_start(event, ctx):\n"
        "        return None\n"
        "    pi.on('session_start', _on_start)\n",
        encoding="utf-8",
    )

    settings_manager = SettingsManager.create(cwd, str(agent_dir))
    settings_manager.set_project_extension_paths([str(extension_file)])

    loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd,
            agent_dir=str(agent_dir),
            settings_manager=settings_manager,
        )
    )
    await loader.reload()

    extensions = loader.get_extensions().extensions
    assert len(extensions) == 1
    assert extensions[0].path.endswith("demo.py")
