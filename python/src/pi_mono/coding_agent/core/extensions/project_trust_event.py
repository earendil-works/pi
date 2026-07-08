"""Extension project_trust event dispatch."""

from __future__ import annotations

import traceback
from typing import Any

from pi_mono.coding_agent.core.extensions.types import (
    ExtensionError,
    LoadExtensionsResult,
    ProjectTrustEvent,
    ProjectTrustEventResult,
)


async def emit_project_trust_event(
    extensions_result: LoadExtensionsResult,
    event: ProjectTrustEvent,
    ctx: Any,
) -> tuple[ProjectTrustEventResult | None, list[ExtensionError]]:
    errors: list[ExtensionError] = []
    for extension in extensions_result.extensions:
        handlers = extension.handlers.get("project_trust", [])
        if not handlers:
            continue
        for handler in handlers:
            try:
                handler_result = await handler(event, ctx)
                if not isinstance(handler_result, dict):
                    continue
                trusted = handler_result.get("trusted")
                if trusted == "undecided":
                    continue
                if trusted in ("yes", "no"):
                    return (
                        ProjectTrustEventResult(
                            trusted=trusted,
                            remember=handler_result.get("remember"),
                        ),
                        errors,
                    )
            except Exception as error:
                errors.append(
                    ExtensionError(
                        extension_path=extension.path,
                        event=event.type,
                        error=str(error),
                        stack=traceback.format_exc(),
                    )
                )
    return None, errors
