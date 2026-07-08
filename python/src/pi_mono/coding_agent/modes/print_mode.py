"""Print mode (single-shot): send prompts, output result, exit."""

from __future__ import annotations

import json
import signal
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pi_mono.ai.types import ImageContent
from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime, PromptOptions
from pi_mono.coding_agent.core.auth_guidance import (
    format_api_error_message,
    format_no_api_key_found_message,
    format_no_model_selected_message,
)
from pi_mono.core.output_guard import flush_raw_stdout, write_raw_stdout

PrintOutputMode = Literal["text", "json"]


@dataclass
class PrintModeOptions:
    mode: PrintOutputMode
    messages: list[str] | None = None
    initial_message: str | None = None
    initial_images: list[ImageContent] | None = None


async def run_print_mode(runtime_host: AgentSessionRuntime, options: PrintModeOptions) -> int:
    mode = options.mode
    messages = options.messages or []
    initial_message = options.initial_message
    initial_images = options.initial_images
    exit_code = 0
    session = runtime_host.session
    unsubscribe: Callable[[], None] | None = None
    disposed = False
    signal_handlers: list[tuple[int, Any]] = []

    async def dispose_runtime() -> None:
        nonlocal disposed
        if disposed:
            return
        disposed = True
        if unsubscribe is not None:
            unsubscribe()
        await runtime_host.dispose()

    def register_signal_handlers() -> None:
        for signum in (signal.SIGTERM, signal.SIGHUP):
            try:
                previous = signal.getsignal(signum)

                def handler(_signum: int, _frame: object | None, _previous: Any = previous) -> None:
                    import asyncio

                    async def _exit() -> None:
                        await dispose_runtime()
                        raise SystemExit(129 if _signum == signal.SIGHUP else 143)

                    asyncio.create_task(_exit())

                signal.signal(signum, handler)
                signal_handlers.append((signum, previous))
            except (AttributeError, ValueError, OSError):
                pass

    def unregister_signal_handlers() -> None:
        for signum, previous in signal_handlers:
            try:
                signal.signal(signum, previous)
            except (AttributeError, ValueError, OSError):
                pass
        signal_handlers.clear()

    async def rebind_session() -> None:
        nonlocal session, unsubscribe
        session = runtime_host.session
        await session.bind_extensions()

        if unsubscribe is not None:
            unsubscribe()

        def on_event(event: dict[str, object]) -> None:
            if mode == "json":
                write_raw_stdout(f"{json.dumps(event)}\n")

        unsubscribe = session.subscribe(on_event)

    register_signal_handlers()
    runtime_host.set_rebind_session(rebind_session)

    try:
        if mode == "json":
            header = session.session_manager.get_header()
            if header:
                write_raw_stdout(f"{json.dumps(header)}\n")

        await rebind_session()

        if not session.model or session.model.get("id") in (None, "unknown"):
            print(format_no_model_selected_message(), file=sys.stderr)
            return 1
        auth = await session.model_registry.get_api_key_and_headers(session.model)
        if not auth.get("ok") or not auth.get("apiKey"):
            print(
                auth.get("error")
                or format_no_api_key_found_message(session.model.get("provider", "unknown")),
                file=sys.stderr,
            )
            return 1

        if initial_message:
            await session.prompt(
                initial_message,
                PromptOptions(images=initial_images),
            )

        for message in messages:
            await session.prompt(message)

        await session.wait_for_idle()

        if mode == "text":
            state = session.state
            last_message = state.messages[-1] if state.messages else None
            if last_message and last_message.get("role") == "assistant":
                stop_reason = last_message.get("stopReason")
                if stop_reason in ("error", "aborted"):
                    raw_error = last_message.get("errorMessage") or f"Request {stop_reason}"
                    error_message = format_api_error_message(
                        str(raw_error),
                        provider=str(last_message.get("provider") or ""),
                        model_id=str(last_message.get("model") or ""),
                    )
                    print(error_message, file=sys.stderr)
                    exit_code = 1
                else:
                    for content in last_message.get("content", []):
                        if content.get("type") == "text":
                            write_raw_stdout(f"{content.get('text', '')}\n")

        return exit_code
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        unregister_signal_handlers()
        await dispose_runtime()
        await flush_raw_stdout()
