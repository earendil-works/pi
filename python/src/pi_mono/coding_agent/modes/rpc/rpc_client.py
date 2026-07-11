"""RPC client for programmatic access to the coding agent."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pi_mono.agent.types import AgentEvent, ThinkingLevel
from pi_mono.ai.types import ImageContent
from pi_mono.coding_agent.core.agent_session import SessionStats
from pi_mono.coding_agent.core.bash_executor import BashResult
from pi_mono.coding_agent.modes.rpc.jsonl import JsonlLineReader, serialize_json_line
from pi_mono.coding_agent.modes.rpc.rpc_types import RpcResponse, RpcSessionState, RpcSlashCommand

RpcEventListener = Callable[[AgentEvent], None]


@dataclass
class ModelInfo:
    provider: str
    id: str
    context_window: int
    reasoning: bool


@dataclass
class RpcClientOptions:
    command: list[str] | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    provider: str | None = None
    model: str | None = None
    extra_args: list[str] | None = None
    startup_delay_ms: int = 100
    request_timeout_s: float = 30.0


class RpcClient:
    def __init__(self, options: RpcClientOptions | None = None) -> None:
        self._options = options or RpcClientOptions()
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._event_listeners: list[RpcEventListener] = []
        self._pending_requests: dict[str, asyncio.Future[RpcResponse]] = {}
        self._request_id = 0
        self._stderr = ""
        self._exit_error: RuntimeError | None = None
        self._line_reader = JsonlLineReader(self._handle_line)

    async def start(self) -> None:
        if self._process is not None:
            raise RuntimeError("Client already started")

        self._exit_error = None
        command = self._build_command()
        env = {**os.environ, **(self._options.env or {})}
        self._process = await asyncio.create_subprocess_exec(
            *command,
            cwd=self._options.cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        if self._process.stderr is not None:
            asyncio.create_task(self._consume_stderr(self._process.stderr))

        if self._process.stdout is not None:
            self._reader_task = asyncio.create_task(self._read_stdout(self._process.stdout))

        asyncio.create_task(self._watch_process(self._process))

        if self._options.startup_delay_ms > 0:
            await asyncio.sleep(self._options.startup_delay_ms / 1000)

        if self._process.returncode is not None:
            error = self._exit_error or self._create_process_exit_error(
                self._process.returncode, None
            )
            self._exit_error = error
            raise error

    async def stop(self) -> None:
        process = self._process
        if process is None:
            return

        if self._reader_task is not None and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
        self._reader_task = None

        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

        self._process = None
        self._pending_requests.clear()

    def on_event(self, listener: RpcEventListener) -> Callable[[], None]:
        self._event_listeners.append(listener)

        def unsubscribe() -> None:
            try:
                self._event_listeners.remove(listener)
            except ValueError:
                pass

        return unsubscribe

    def get_stderr(self) -> str:
        return self._stderr

    async def prompt(self, message: str, images: list[ImageContent] | None = None) -> None:
        command: dict[str, Any] = {"type": "prompt", "message": message}
        if images is not None:
            command["images"] = images
        await self._send(command)

    async def steer(self, message: str, images: list[ImageContent] | None = None) -> None:
        command: dict[str, Any] = {"type": "steer", "message": message}
        if images is not None:
            command["images"] = images
        await self._send(command)

    async def follow_up(self, message: str, images: list[ImageContent] | None = None) -> None:
        command: dict[str, Any] = {"type": "follow_up", "message": message}
        if images is not None:
            command["images"] = images
        await self._send(command)

    async def abort(self) -> None:
        await self._send({"type": "abort"})

    async def new_session(self, parent_session: str | None = None) -> dict[str, bool]:
        command: dict[str, Any] = {"type": "new_session"}
        if parent_session is not None:
            command["parentSession"] = parent_session
        response = await self._send(command)
        return self._get_data(response)

    async def get_state(self) -> RpcSessionState:
        response = await self._send({"type": "get_state"})
        return self._get_data(response)

    async def set_model(self, provider: str, model_id: str) -> dict[str, str]:
        response = await self._send(
            {"type": "set_model", "provider": provider, "modelId": model_id}
        )
        return self._get_data(response)

    async def cycle_model(self) -> dict[str, Any] | None:
        response = await self._send({"type": "cycle_model"})
        return self._get_data(response)

    async def get_available_models(self) -> list[ModelInfo]:
        response = await self._send({"type": "get_available_models"})
        data = self._get_data(response)
        models = data.get("models", []) if isinstance(data, dict) else []
        result: list[ModelInfo] = []
        for model in models:
            if not isinstance(model, dict):
                continue
            result.append(
                ModelInfo(
                    provider=str(model.get("provider", "")),
                    id=str(model.get("id", "")),
                    context_window=int(model.get("contextWindow") or 0),
                    reasoning=bool(model.get("reasoning")),
                )
            )
        return result

    async def set_thinking_level(self, level: ThinkingLevel) -> None:
        await self._send({"type": "set_thinking_level", "level": level})

    async def cycle_thinking_level(self) -> dict[str, ThinkingLevel] | None:
        response = await self._send({"type": "cycle_thinking_level"})
        return self._get_data(response)

    async def set_steering_mode(self, mode: str) -> None:
        await self._send({"type": "set_steering_mode", "mode": mode})

    async def set_follow_up_mode(self, mode: str) -> None:
        await self._send({"type": "set_follow_up_mode", "mode": mode})

    async def compact(self, custom_instructions: str | None = None) -> dict[str, Any]:
        command: dict[str, Any] = {"type": "compact"}
        if custom_instructions is not None:
            command["customInstructions"] = custom_instructions
        response = await self._send(command)
        return self._get_data(response)

    async def set_auto_compaction(self, enabled: bool) -> None:
        await self._send({"type": "set_auto_compaction", "enabled": enabled})

    async def set_auto_retry(self, enabled: bool) -> None:
        await self._send({"type": "set_auto_retry", "enabled": enabled})

    async def abort_retry(self) -> None:
        await self._send({"type": "abort_retry"})

    async def bash(self, command: str) -> BashResult:
        response = await self._send({"type": "bash", "command": command})
        return self._get_data(response)

    async def abort_bash(self) -> None:
        await self._send({"type": "abort_bash"})

    async def get_session_stats(self) -> SessionStats:
        response = await self._send({"type": "get_session_stats"})
        return self._get_data(response)

    async def export_html(self, output_path: str | None = None) -> dict[str, str]:
        command: dict[str, Any] = {"type": "export_html"}
        if output_path is not None:
            command["outputPath"] = output_path
        response = await self._send(command)
        return self._get_data(response)

    async def switch_session(self, session_path: str) -> dict[str, bool]:
        response = await self._send({"type": "switch_session", "sessionPath": session_path})
        return self._get_data(response)

    async def fork(self, entry_id: str) -> dict[str, Any]:
        response = await self._send({"type": "fork", "entryId": entry_id})
        return self._get_data(response)

    async def clone(self) -> dict[str, bool]:
        response = await self._send({"type": "clone"})
        return self._get_data(response)

    async def get_fork_messages(self) -> list[dict[str, str]]:
        response = await self._send({"type": "get_fork_messages"})
        data = self._get_data(response)
        messages = data.get("messages", []) if isinstance(data, dict) else []
        return messages  # type: ignore[return-value]

    async def get_entries(
        self, since: str | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": "get_entries"}
        if since is not None:
            payload["since"] = since
        response = await self._send(payload)
        return self._get_data(response)

    async def get_tree(self) -> dict[str, Any]:
        response = await self._send({"type": "get_tree"})
        return self._get_data(response)

    async def get_last_assistant_text(self) -> str | None:
        response = await self._send({"type": "get_last_assistant_text"})
        data = self._get_data(response)
        if isinstance(data, dict):
            text = data.get("text")
            return text if isinstance(text, str) or text is None else str(text)
        return None

    async def set_session_name(self, name: str) -> None:
        await self._send({"type": "set_session_name", "name": name})

    async def get_messages(self) -> list[dict[str, Any]]:
        response = await self._send({"type": "get_messages"})
        data = self._get_data(response)
        messages = data.get("messages", []) if isinstance(data, dict) else []
        return messages  # type: ignore[return-value]

    async def get_commands(self) -> list[RpcSlashCommand]:
        response = await self._send({"type": "get_commands"})
        data = self._get_data(response)
        commands = data.get("commands", []) if isinstance(data, dict) else []
        return commands  # type: ignore[return-value]

    async def wait_for_idle(self, timeout: float = 60.0) -> None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()

        def on_event(event: AgentEvent) -> None:
            if event.get("type") == "agent_end" and not future.done():
                future.set_result(None)

        unsubscribe = self.on_event(on_event)
        try:
            await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as error:
            raise RuntimeError(
                f"Timeout waiting for agent to become idle. Stderr: {self._stderr}"
            ) from error
        finally:
            unsubscribe()

    async def collect_events(self, timeout: float = 60.0) -> list[AgentEvent]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[list[AgentEvent]] = loop.create_future()
        events: list[AgentEvent] = []

        def on_event(event: AgentEvent) -> None:
            events.append(event)
            if event.get("type") == "agent_end" and not future.done():
                future.set_result(list(events))

        unsubscribe = self.on_event(on_event)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as error:
            raise RuntimeError(f"Timeout collecting events. Stderr: {self._stderr}") from error
        finally:
            unsubscribe()

    async def prompt_and_wait(
        self,
        message: str,
        images: list[ImageContent] | None = None,
        timeout: float = 60.0,
    ) -> list[AgentEvent]:
        events_task = asyncio.create_task(self.collect_events(timeout))
        await self.prompt(message, images)
        return await events_task

    def _build_command(self) -> list[str]:
        if self._options.command is not None:
            return list(self._options.command)

        command = [sys.executable, "-m", "pi_mono.coding_agent", "--mode", "rpc"]
        if self._options.provider:
            command.extend(["--provider", self._options.provider])
        if self._options.model:
            command.extend(["--model", self._options.model])
        if self._options.extra_args:
            command.extend(self._options.extra_args)
        return command

    async def _read_stdout(self, stream: asyncio.StreamReader) -> None:
        try:
            while True:
                chunk = await stream.readline()
                if not chunk:
                    self._line_reader.flush()
                    return
                self._line_reader.feed(chunk.decode("utf-8", errors="replace"))
        except asyncio.CancelledError:
            raise

    async def _watch_process(self, process: asyncio.subprocess.Process) -> None:
        returncode = await process.wait()
        if self._process is not process:
            return
        if self._exit_error is None:
            error = self._create_process_exit_error(returncode, None)
            self._exit_error = error
            self._reject_pending_requests(error)

    async def _consume_stderr(self, stream: asyncio.StreamReader) -> None:
        while True:
            chunk = await stream.readline()
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace")
            self._stderr += text

    def _handle_line(self, line: str) -> None:
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            return

        if (
            isinstance(data, dict)
            and data.get("type") == "response"
            and isinstance(data.get("id"), str)
            and data["id"] in self._pending_requests
        ):
            future = self._pending_requests.pop(data["id"])
            future.set_result(data)  # type: ignore[arg-type]
            return

        if isinstance(data, dict):
            for listener in list(self._event_listeners):
                listener(data)  # type: ignore[arg-type]

    def _create_process_exit_error(self, code: int | None, signal: int | None) -> RuntimeError:
        return RuntimeError(
            f"Agent process exited (code={code} signal={signal}). Stderr: {self._stderr}"
        )

    def _reject_pending_requests(self, error: RuntimeError) -> None:
        for future in self._pending_requests.values():
            if not future.done():
                future.set_exception(error)
        self._pending_requests.clear()

    async def _send(self, command: dict[str, Any]) -> RpcResponse:
        process = self._process
        if process is None or process.stdin is None:
            raise RuntimeError("Client not started")
        if self._exit_error is not None:
            raise self._exit_error
        if process.returncode is not None:
            error = self._create_process_exit_error(process.returncode, None)
            self._exit_error = error
            raise error

        request_id = f"req_{self._request_id}"
        self._request_id += 1
        full_command = {**command, "id": request_id}
        loop = asyncio.get_running_loop()
        future: asyncio.Future[RpcResponse] = loop.create_future()
        self._pending_requests[request_id] = future

        try:
            process.stdin.write(serialize_json_line(full_command).encode("utf-8"))
            await process.stdin.drain()
        except Exception as error:
            self._pending_requests.pop(request_id, None)
            write_error = RuntimeError(
                f"Agent process stdin is not writable: {error}. Stderr: {self._stderr}"
            )
            self._exit_error = write_error
            raise write_error from error

        try:
            return await asyncio.wait_for(future, timeout=self._options.request_timeout_s)
        except asyncio.TimeoutError as error:
            self._pending_requests.pop(request_id, None)
            raise RuntimeError(
                f"Timeout waiting for response to {command['type']}. Stderr: {self._stderr}"
            ) from error

    def _get_data(self, response: RpcResponse) -> Any:
        if not response.get("success"):
            error = response.get("error")
            raise RuntimeError(str(error) if error is not None else "RPC command failed")
        return response.get("data")
