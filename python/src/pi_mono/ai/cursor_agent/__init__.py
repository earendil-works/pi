from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import shutil
import subprocess
import time
from typing import Any, Optional, TypedDict, cast

from pi_mono.ai.env_api_keys import get_env_api_key
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    StreamOptions,
    TextContent,
)
from pi_mono.utils.event_stream import AssistantMessageEventStream
from pi_mono.utils.shell import track_detached_child_pid, untrack_detached_child_pid

CURSOR_AGENT_DEFAULT_PATH = "agent"
CURSOR_AGENT_DISCOVERY_TIMEOUT_SECONDS = 15.0
CURSOR_AGENT_STATUS_TIMEOUT_SECONDS = 10.0


class CursorModelDefinition(TypedDict):
    id: str
    name: str
    reasoning: bool
    contextWindow: int
    maxTokens: int


STATIC_MODELS: list[CursorModelDefinition] = [
    {"id": "auto", "name": "Auto", "reasoning": False, "contextWindow": 200000, "maxTokens": 32768},
    {
        "id": "composer-1.5",
        "name": "Composer 1.5",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "composer-1",
        "name": "Composer 1",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "composer-2.5-fast",
        "name": "Composer 2.5 Fast",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "composer-2.5",
        "name": "Composer 2.5",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "sonnet-4.6-thinking",
        "name": "Claude 4.6 Sonnet (Thinking)",
        "reasoning": True,
        "contextWindow": 200000,
        "maxTokens": 32000,
    },
    {
        "id": "sonnet-4.6",
        "name": "Claude 4.6 Sonnet",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32000,
    },
    {
        "id": "sonnet-4.5-thinking",
        "name": "Claude 4.5 Sonnet (Thinking)",
        "reasoning": True,
        "contextWindow": 200000,
        "maxTokens": 32000,
    },
    {
        "id": "sonnet-4.5",
        "name": "Claude 4.5 Sonnet",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32000,
    },
    {
        "id": "opus-4.6-thinking",
        "name": "Claude 4.6 Opus (Thinking)",
        "reasoning": True,
        "contextWindow": 200000,
        "maxTokens": 32000,
    },
    {
        "id": "opus-4.6",
        "name": "Claude 4.6 Opus",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32000,
    },
    {
        "id": "gpt-5.3-codex",
        "name": "GPT-5.3 Codex",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "gpt-5.3-codex-low",
        "name": "GPT-5.3 Codex Low",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "gpt-5.3-codex-high",
        "name": "GPT-5.3 Codex High",
        "reasoning": True,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "gpt-5.3-codex-fast",
        "name": "GPT-5.3 Codex Fast",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "gpt-5.2",
        "name": "GPT-5.2",
        "reasoning": False,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "gpt-5.2-high",
        "name": "GPT-5.2 High",
        "reasoning": True,
        "contextWindow": 200000,
        "maxTokens": 32768,
    },
    {
        "id": "gemini-3-pro",
        "name": "Gemini 3 Pro",
        "reasoning": False,
        "contextWindow": 1000000,
        "maxTokens": 65536,
    },
    {
        "id": "gemini-3-flash",
        "name": "Gemini 3 Flash",
        "reasoning": False,
        "contextWindow": 1000000,
        "maxTokens": 65536,
    },
    {"id": "grok", "name": "Grok", "reasoning": False, "contextWindow": 131072, "maxTokens": 32768},
]

STATIC_MODELS_MAP: dict[str, CursorModelDefinition] = {
    model["id"]: model for model in STATIC_MODELS
}
_DISCOVERED_MODELS_CACHE: list[Model] | None = None
_CACHE_FROM_CLI: bool = False
_CURSOR_AUTH_CACHE: bool | None = None


def resolve_cursor_agent_path() -> str:
    return (
        os.environ.get("CURSOR_AGENT_PATH")
        or os.environ.get("AGENT_PATH")
        or CURSOR_AGENT_DEFAULT_PATH
    )


def check_cursor_agent_available() -> None:
    path = resolve_cursor_agent_path()
    if os.path.isabs(path) or os.sep in path or path.startswith("."):
        if not os.path.isfile(path):
            raise RuntimeError(f"Cursor Agent CLI not found at {path}")
        return
    if shutil.which(path) is None:
        raise RuntimeError(f"Cursor Agent CLI not found: {path} not on PATH")


def _cursor_api_key_from_env() -> str | None:
    return get_env_api_key("cursor")


def _agent_env(api_key: str | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if api_key:
        env["CURSOR_API_KEY"] = api_key
    return env


def _run_agent_sync(
    args: list[str],
    *,
    api_key: str | None = None,
    timeout_seconds: float | None = None,
    cwd: str | None = None,
    capture_output: bool = True,
) -> subprocess.CompletedProcess[str]:
    command = [resolve_cursor_agent_path(), *args]
    return subprocess.run(
        command,
        cwd=cwd,
        env=_agent_env(api_key),
        capture_output=capture_output,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )


def _infer_reasoning(model_id: str) -> bool:
    return bool(re.search(r"(-thinking|-high|-xhigh|-max-high|-max)$", model_id))


def parse_agent_models_output(output: str) -> list[CursorModelDefinition]:
    results: list[CursorModelDefinition] = []
    line_re = re.compile(
        r"^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+?)(?:\s+\((?:current|default|current,\s*default)\))?$"
    )
    for line in output.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("Available") or trimmed.startswith("Tip:"):
            continue
        match = line_re.match(trimmed)
        if not match:
            continue
        model_id = match.group(1).strip()
        name = match.group(2).strip()
        known = STATIC_MODELS_MAP.get(model_id)
        results.append(
            {
                "id": model_id,
                "name": name,
                "reasoning": known["reasoning"] if known else _infer_reasoning(model_id),
                "contextWindow": known["contextWindow"] if known else 200000,
                "maxTokens": known["maxTokens"] if known else 32768,
            }
        )
    return results


def _model_definition_to_model(defn: CursorModelDefinition) -> Model:
    return {
        "id": defn["id"],
        "name": defn["name"],
        "api": "openai-completions",
        "provider": "cursor",
        "baseUrl": "cursor://agent",
        "reasoning": defn["reasoning"],
        "input": ["text"],
        "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0},
        "contextWindow": defn["contextWindow"],
        "maxTokens": defn["maxTokens"],
    }


def _build_static_models() -> list[Model]:
    return [_model_definition_to_model(model) for model in STATIC_MODELS]


def discover_cursor_models(*, refresh: bool = False) -> list[Model]:
    global _DISCOVERED_MODELS_CACHE, _CACHE_FROM_CLI
    if (
        _DISCOVERED_MODELS_CACHE is not None
        and not refresh
        and not (_CACHE_FROM_CLI is False and is_cursor_agent_authenticated())
    ):
        return copy.deepcopy(_DISCOVERED_MODELS_CACHE)

    api_key = _cursor_api_key_from_env()
    try:
        args = ["models"]
        if api_key:
            args = ["--api-key", api_key, *args]
        result = _run_agent_sync(
            args,
            api_key=api_key,
            timeout_seconds=CURSOR_AGENT_DISCOVERY_TIMEOUT_SECONDS,
        )
        if result.returncode == 0:
            parsed = parse_agent_models_output(result.stdout or "")
            if parsed:
                _DISCOVERED_MODELS_CACHE = [_model_definition_to_model(defn) for defn in parsed]
                _CACHE_FROM_CLI = True
                return copy.deepcopy(_DISCOVERED_MODELS_CACHE)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    except Exception:
        pass

    fallback = _build_static_models()
    _DISCOVERED_MODELS_CACHE = copy.deepcopy(fallback)
    _CACHE_FROM_CLI = False
    return fallback


def refresh_cursor_models_cache() -> None:
    global _DISCOVERED_MODELS_CACHE, _CACHE_FROM_CLI
    _DISCOVERED_MODELS_CACHE = None
    _CACHE_FROM_CLI = False


def refresh_cursor_auth_cache() -> None:
    global _CURSOR_AUTH_CACHE
    _CURSOR_AUTH_CACHE = None


def is_cursor_agent_authenticated() -> bool:
    global _CURSOR_AUTH_CACHE
    api_key = _cursor_api_key_from_env()
    if api_key:
        return True

    if _CURSOR_AUTH_CACHE is not None:
        return _CURSOR_AUTH_CACHE

    try:
        result = _run_agent_sync(
            ["status"],
            timeout_seconds=CURSOR_AGENT_STATUS_TIMEOUT_SECONDS,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    except Exception:
        return False

    if result.returncode != 0:
        return False

    output = f"{result.stdout or ''}\n{result.stderr or ''}".lower()
    if "not logged in" in output or "not authenticated" in output or "login required" in output:
        _CURSOR_AUTH_CACHE = False
        return False
    if "logged in" in output or "authenticated" in output or "signed in" in output:
        _CURSOR_AUTH_CACHE = True
        return True
    _CURSOR_AUTH_CACHE = bool(output.strip())
    return _CURSOR_AUTH_CACHE


def login_cursor_account_sync() -> None:
    api_key = _cursor_api_key_from_env()
    args = ["login"]
    if api_key:
        args = ["--api-key", api_key, *args]
    subprocess.run(
        [resolve_cursor_agent_path(), *args],
        env=_agent_env(api_key),
        check=True,
    )


async def login_cursor_account() -> None:
    await asyncio.to_thread(login_cursor_account_sync)
    refresh_cursor_auth_cache()
    refresh_cursor_models_cache()


def logout_cursor_account_sync() -> None:
    api_key = _cursor_api_key_from_env()
    args = ["logout"]
    if api_key:
        args = ["--api-key", api_key, *args]
    subprocess.run(
        [resolve_cursor_agent_path(), *args],
        env=_agent_env(api_key),
        check=True,
    )


async def logout_cursor_account() -> None:
    await asyncio.to_thread(logout_cursor_account_sync)
    refresh_cursor_auth_cache()


def _content_block_to_text(block: dict[str, Any]) -> str:
    block_type = block.get("type")
    if block_type == "text":
        return str(block.get("text", ""))
    if block_type == "image":
        data = str(block.get("data", ""))
        mime_type = str(block.get("mimeType", "image/*"))
        approx_bytes = round((len(data) * 3) / 4)
        return f"[Image: {mime_type}, ~{approx_bytes} bytes - image input is not supported by the Cursor Agent CLI]"
    return ""


def serialize_context(context: Context) -> str:
    lines: list[str] = []

    system_prompt = context.get("systemPrompt")
    if system_prompt:
        lines.append(f"[System]\n{system_prompt}\n")

    for message in context.get("messages", []):
        role = message.get("role")
        if role == "user":
            content = message.get("content")
            if isinstance(content, str):
                text = content
            else:
                text = "\n".join(
                    _content_block_to_text(cast(dict[str, Any], block)) for block in content
                )
            lines.append(f"[User]\n{text}")
        elif role == "assistant":
            content = message.get("content", [])
            if isinstance(content, list):
                text = "\n".join(
                    _content_block_to_text(cast(dict[str, Any], block))
                    for block in content
                    if cast(dict[str, Any], block).get("type") == "text"
                )
                if text.strip():
                    lines.append(f"[Assistant]\n{text}")
        elif role == "toolResult":
            content = message.get("content", [])
            if isinstance(content, list):
                text = "\n".join(
                    _content_block_to_text(cast(dict[str, Any], block)) for block in content
                )
                if text.strip():
                    tool_name = str(message.get("toolName", "tool"))
                    lines.append(f"[Tool result: {tool_name}]\n{text}")

    return "\n\n".join(lines)


def _build_initial_message(model: Model) -> AssistantMessage:
    return {
        "role": "assistant",
        "content": [],
        "api": model.get("api", "openai-completions"),
        "provider": "cursor",
        "model": model["id"],
        "usage": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 0,
            "cost": {
                "input": 0.0,
                "output": 0.0,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
                "total": 0.0,
            },
        },
        "stopReason": "stop",
        "timestamp": int(time.time() * 1000),
    }


def _build_error_message(model: Model, error_message: str) -> AssistantMessage:
    message = _build_initial_message(model)
    message["stopReason"] = "error"
    message["errorMessage"] = error_message
    return message


def stream_cursor_cli(
    model: Model,
    context: Context,
    options: Optional[StreamOptions] = None,
) -> AssistantMessageEventStream:
    event_stream = AssistantMessageEventStream()

    async def run() -> None:
        process: asyncio.subprocess.Process | None = None
        tracked_pid: int | None = None
        try:
            check_cursor_agent_available()
            options_dict = dict(options or {})
            api_key = cast(Optional[str], options_dict.get("apiKey")) or _cursor_api_key_from_env()
            if api_key == "<authenticated>":
                api_key = None
            workspace_path = os.getcwd()
            prompt = serialize_context(context)
            output = _build_initial_message(model)
            agent_args = [
                "--print",
                "--output-format",
                "stream-json",
                "--model",
                model["id"],
                "--workspace",
                workspace_path,
                prompt,
            ]
            if api_key:
                agent_args = ["--api-key", api_key, *agent_args]

            event_stream.push({"type": "start", "partial": output})

            process = await asyncio.create_subprocess_exec(
                resolve_cursor_agent_path(),
                *agent_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_agent_env(api_key),
            )
            if process.pid is not None:
                tracked_pid = process.pid
                track_detached_child_pid(tracked_pid)

            assert process.stdout is not None
            assert process.stderr is not None

            text_block_open = False
            text_block_index = -1

            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    event = line.decode("utf-8").strip()
                    if not event:
                        continue
                    payload = cast(dict[str, Any], json.loads(event))
                except Exception:
                    continue

                if payload.get("type") != "assistant":
                    continue

                message = cast(dict[str, Any], payload.get("message") or {})
                content = message.get("content")
                if not isinstance(content, list):
                    continue

                for block in content:
                    block_dict = cast(dict[str, Any], block)
                    if block_dict.get("type") != "text":
                        continue
                    text = str(block_dict.get("text", ""))
                    if not text.strip():
                        continue
                    if not text_block_open:
                        output["content"].append({"type": "text", "text": ""})
                        text_block_index = len(output["content"]) - 1
                        event_stream.push(
                            {
                                "type": "text_start",
                                "contentIndex": text_block_index,
                                "partial": output,
                            }
                        )
                        text_block_open = True
                    text_block = cast(TextContent, output["content"][text_block_index])
                    text_block["text"] = f"{text_block.get('text', '')}{text}"
                    event_stream.push(
                        {
                            "type": "text_delta",
                            "contentIndex": text_block_index,
                            "delta": text,
                            "partial": output,
                        }
                    )

            return_code = await process.wait()
            stderr_text = ""
            if process.stderr is not None:
                try:
                    stderr_text = (
                        (await process.stderr.read()).decode("utf-8", errors="ignore").strip()
                    )
                except Exception:
                    stderr_text = ""

            if return_code != 0:
                error_text = stderr_text or f"Cursor Agent CLI exited with code {return_code}"
                event_stream.push(
                    {
                        "type": "error",
                        "reason": "error",
                        "error": _build_error_message(model, error_text),
                    }
                )
                return

            event_stream.push({"type": "done", "reason": "stop", "message": output})
        except Exception as exc:
            event_stream.push(
                {"type": "error", "reason": "error", "error": _build_error_message(model, str(exc))}
            )
        finally:
            if tracked_pid is not None:
                untrack_detached_child_pid(tracked_pid)
            if process and process.returncode is None:
                process.terminate()
                try:
                    await process.wait()
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
            event_stream.end()

    asyncio.create_task(run())
    return event_stream


def stream_simple_cursor_cli(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessageEventStream:
    return stream_cursor_cli(model, context, options)
