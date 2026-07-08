"""OpenAI Codex Responses API provider."""

from __future__ import annotations

import asyncio
import base64
import json
import platform
import re
import time
from typing import Any, AsyncIterator

import httpx

from pi_mono.ai.models import clamp_thinking_level
from pi_mono.ai.providers.openai_prompt_cache import clamp_openai_prompt_cache_key
from pi_mono.ai.providers.openai_responses_shared import (
    ConvertResponsesMessagesOptions,
    ConvertResponsesToolsOptions,
    OpenAIResponsesStreamOptions,
    convert_responses_messages,
    convert_responses_tools,
    process_responses_stream,
)
from pi_mono.ai.providers.simple_options import build_base_options
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    StreamOptions,
    Usage,
)
from pi_mono.ai.utils.event_stream import AssistantMessageEventStream
from pi_mono.ai.utils.headers import headers_to_record

DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api"
JWT_CLAIM_PATH = "https://api.openai.com/auth"
DEFAULT_MAX_RETRIES = 0
BASE_DELAY_MS = 1000
DEFAULT_MAX_RETRY_DELAY_MS = 60_000
DEFAULT_SSE_HEADER_TIMEOUT_MS = 10_000
CODEX_TOOL_CALL_PROVIDERS = {"openai", "openai-codex", "opencode"}
CODEX_RESPONSE_STATUSES = {
    "completed",
    "incomplete",
    "failed",
    "cancelled",
    "queued",
    "in_progress",
}


class OpenAICodexResponsesOptions(dict):
    """Stream options for OpenAI Codex Responses API."""


def _is_terminal_rate_limit_error(error_text: str) -> bool:
    return bool(
        re.search(
            r"GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|"
            r"insufficient_quota|out of budget|quota exceeded|billing",
            error_text,
            re.IGNORECASE,
        )
    )


def _is_retryable_error(status: int, error_text: str) -> bool:
    if status == 429 and _is_terminal_rate_limit_error(error_text):
        return False
    if status in (429, 500, 502, 503, 504):
        return True
    return bool(
        re.search(
            r"rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused",
            error_text,
            re.IGNORECASE,
        )
    )


def _get_retry_after_delay_ms(headers: httpx.Headers) -> int | None:
    retry_after_ms = headers.get("retry-after-ms")
    if retry_after_ms is not None:
        millis = float(retry_after_ms)
        if millis == millis:
            return max(0, int(millis))

    retry_after = headers.get("retry-after")
    if not retry_after:
        return None

    try:
        seconds = float(retry_after)
        if seconds == seconds:
            return max(0, int(seconds * 1000))
    except ValueError:
        pass

    try:
        date_ms = int(time.mktime(time.strptime(retry_after[:25], "%a, %d %b %Y %H:%M:%S")) * 1000)
        return max(0, date_ms - int(time.time() * 1000))
    except (ValueError, OverflowError):
        return None


def _cap_retry_delay_ms(delay_ms: int, options: StreamOptions | None) -> int:
    max_retry_delay_ms = (
        options.get("maxRetryDelayMs", DEFAULT_MAX_RETRY_DELAY_MS)
        if options
        else DEFAULT_MAX_RETRY_DELAY_MS
    )
    return min(delay_ms, max_retry_delay_ms) if max_retry_delay_ms > 0 else delay_ms


async def _sleep(ms: int, signal: Any | None = None) -> None:
    if signal and signal.get("aborted"):
        raise RuntimeError("Request was aborted")
    await asyncio.sleep(ms / 1000)


def _normalize_timeout_ms(value: Any) -> int | None:
    if value is None:
        return None
    timeout = float(value)
    if timeout != timeout or timeout < 0:
        raise ValueError(f"Invalid timeoutMs: {value!r}")
    return int(timeout)


def _resolve_codex_url(base_url: str | None = None) -> str:
    raw = base_url.strip() if base_url and base_url.strip() else DEFAULT_CODEX_BASE_URL
    normalized = raw.rstrip("/")
    if normalized.endswith("/codex/responses"):
        return normalized
    if normalized.endswith("/codex"):
        return f"{normalized}/responses"
    return f"{normalized}/codex/responses"


def _extract_account_id(token: str) -> str:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("Invalid token")
        payload = parts[1]
        padding = "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload + padding))
        account_id = decoded.get(JWT_CLAIM_PATH, {}).get("chatgpt_account_id")
        if not account_id:
            raise ValueError("No account ID in token")
        return str(account_id)
    except Exception as error:
        raise RuntimeError("Failed to extract accountId from token") from error


def _build_base_codex_headers(
    init_headers: dict[str, str] | None,
    additional_headers: dict[str, str] | None,
    account_id: str,
    token: str,
) -> dict[str, str]:
    headers = dict(init_headers or {})
    headers.update(additional_headers or {})
    headers["Authorization"] = f"Bearer {token}"
    headers["chatgpt-account-id"] = account_id
    headers["originator"] = "pi"
    headers["User-Agent"] = f"pi ({platform.system()} {platform.release()}; {platform.machine()})"
    return headers


def _build_sse_headers(
    init_headers: dict[str, str] | None,
    additional_headers: dict[str, str] | None,
    account_id: str,
    token: str,
    session_id: str | None = None,
) -> dict[str, str]:
    headers = _build_base_codex_headers(init_headers, additional_headers, account_id, token)
    headers["OpenAI-Beta"] = "responses=experimental"
    headers["accept"] = "text/event-stream"
    headers["content-type"] = "application/json"
    if session_id:
        headers["session-id"] = session_id
        headers["x-client-request-id"] = session_id
    return headers


def _get_service_tier_cost_multiplier(model_id: str, service_tier: str | None) -> float:
    if service_tier == "flex":
        return 0.5
    if service_tier == "priority":
        return 2.5 if model_id == "gpt-5.5" else 2.0
    return 1.0


def _apply_service_tier_pricing(usage: Usage, service_tier: str | None, model_id: str) -> None:
    multiplier = _get_service_tier_cost_multiplier(model_id, service_tier)
    if multiplier == 1.0:
        return
    usage["cost"]["input"] *= multiplier
    usage["cost"]["output"] *= multiplier
    usage["cost"]["cacheRead"] *= multiplier
    usage["cost"]["cacheWrite"] *= multiplier
    usage["cost"]["total"] = (
        usage["cost"]["input"]
        + usage["cost"]["output"]
        + usage["cost"]["cacheRead"]
        + usage["cost"]["cacheWrite"]
    )


def _resolve_codex_service_tier(
    response_service_tier: str | None,
    request_service_tier: str | None,
) -> str | None:
    if response_service_tier == "default" and request_service_tier in ("flex", "priority"):
        return request_service_tier
    return response_service_tier or request_service_tier


def _build_request_body(
    model: Model[str],
    context: Context,
    options: StreamOptions | None = None,
) -> dict[str, Any]:
    messages = convert_responses_messages(
        model,
        context,
        CODEX_TOOL_CALL_PROVIDERS,
        ConvertResponsesMessagesOptions(include_system_prompt=False),
    )

    body: dict[str, Any] = {
        "model": model["id"],
        "store": False,
        "stream": True,
        "instructions": context.get("systemPrompt") or "You are a helpful assistant.",
        "input": messages,
        "text": {"verbosity": (options or {}).get("textVerbosity", "low")},
        "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": clamp_openai_prompt_cache_key(
            options.get("sessionId") if options else None
        ),
        "tool_choice": "auto",
        "parallel_tool_calls": True,
    }

    if options and options.get("temperature") is not None:
        body["temperature"] = options["temperature"]
    if options and options.get("serviceTier") is not None:
        body["service_tier"] = options["serviceTier"]
    if context.get("tools"):
        body["tools"] = convert_responses_tools(
            context["tools"], ConvertResponsesToolsOptions(strict=None)
        )

    reasoning_effort = options.get("reasoningEffort") if options else None
    if reasoning_effort is not None:
        thinking_map = model.get("thinkingLevelMap", {})
        effort = (
            thinking_map.get("off", "none")
            if reasoning_effort == "none"
            else thinking_map.get(reasoning_effort, reasoning_effort)
        )
        if effort is not None:
            body["reasoning"] = {
                "effort": effort,
                "summary": (options or {}).get("reasoningSummary", "auto"),
            }

    return body


class CodexApiError(RuntimeError):
    def __init__(
        self, message: str, code: str | None = None, payload: dict[str, Any] | None = None
    ):
        super().__init__(message)
        self.code = code
        self.payload = payload


class CodexProtocolError(RuntimeError):
    def __init__(self, message: str, payload: Any | None = None):
        super().__init__(message)
        self.payload = payload


def _normalize_codex_status(status: Any) -> str | None:
    if isinstance(status, str) and status in CODEX_RESPONSE_STATUSES:
        return status
    return None


async def _map_codex_events(
    events: AsyncIterator[dict[str, Any]],
) -> AsyncIterator[dict[str, Any]]:
    async for event in events:
        event_type = event.get("type")
        if not isinstance(event_type, str):
            continue

        if event_type == "error":
            code = event.get("code") or ""
            message = event.get("message") or ""
            raise CodexApiError(
                f"Codex error: {message or code or json.dumps(event)}",
                code=code or None,
                payload=event,
            )

        if event_type == "response.failed":
            response = event.get("response") if isinstance(event.get("response"), dict) else {}
            error = response.get("error") if isinstance(response.get("error"), dict) else {}
            raise CodexApiError(
                error.get("message") or "Codex response failed",
                code=error.get("code"),
                payload=event,
            )

        if event_type in ("response.done", "response.completed", "response.incomplete"):
            response = event.get("response")
            if isinstance(response, dict):
                normalized = {**response, "status": _normalize_codex_status(response.get("status"))}
                yield {**event, "type": "response.completed", "response": normalized}
            else:
                yield {**event, "type": "response.completed"}
            return

        yield event


async def _parse_sse(
    response: httpx.Response, signal: Any | None = None
) -> AsyncIterator[dict[str, Any]]:
    buffer = ""
    async for chunk in response.aiter_text():
        if signal and signal.get("aborted"):
            raise RuntimeError("Request was aborted")
        buffer += chunk
        while "\n\n" in buffer:
            part, buffer = buffer.split("\n\n", 1)
            data_lines = [line[5:].strip() for line in part.split("\n") if line.startswith("data:")]
            if not data_lines:
                continue
            data = "\n".join(data_lines).strip()
            if not data or data == "[DONE]":
                continue
            try:
                yield json.loads(data)
            except json.JSONDecodeError as error:
                raise CodexProtocolError(
                    f"Invalid Codex SSE JSON: {error}", payload=data
                ) from error


async def _parse_error_response(response: httpx.Response) -> dict[str, str | None]:
    raw = response.text
    message = raw or response.reason_phrase or "Request failed"
    friendly_message: str | None = None
    try:
        parsed = json.loads(raw)
        err = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(err, dict):
            code = err.get("code") or err.get("type") or ""
            if (
                re.search(r"usage_limit_reached|usage_not_included|rate_limit_exceeded", code, re.I)
                or response.status_code == 429
            ):
                plan = f" ({err['plan_type'].lower()} plan)" if err.get("plan_type") else ""
                resets_at = err.get("resets_at")
                when = ""
                if isinstance(resets_at, (int, float)):
                    mins = max(0, round((resets_at * 1000 - int(time.time() * 1000)) / 60000))
                    when = f" Try again in ~{mins} min."
                friendly_message = f"You have hit your ChatGPT usage limit{plan}.{when}".strip()
            message = err.get("message") or friendly_message or message
    except json.JSONDecodeError:
        pass
    return {"message": message, "friendlyMessage": friendly_message}


def stream_openai_codex_responses(
    model: Model[str],
    context: Context,
    options: StreamOptions | None = None,
) -> AssistantMessageEventStream:
    stream = AssistantMessageEventStream()

    async def run() -> None:
        output: AssistantMessage = {
            "role": "assistant",
            "content": [],
            "api": "openai-codex-responses",
            "provider": model["provider"],
            "model": model["id"],
            "usage": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 0,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            },
            "stopReason": "stop",
            "timestamp": int(time.time() * 1000),
        }

        try:
            api_key = options.get("apiKey") if options else None
            if not api_key:
                raise ValueError(f"No API key for provider: {model['provider']}")

            account_id = _extract_account_id(api_key)
            body = _build_request_body(model, context, options)
            if options and options.get("onPayload"):
                next_body = await options["onPayload"](body, model)
                if next_body is not None:
                    body = next_body

            sse_headers = _build_sse_headers(
                model.get("headers"),
                options.get("headers") if options else None,
                account_id,
                api_key,
                options.get("sessionId") if options else None,
            )
            body_json = json.dumps(body)
            max_retries = (
                options.get("maxRetries", DEFAULT_MAX_RETRIES) if options else DEFAULT_MAX_RETRIES
            )
            response: httpx.Response | None = None
            last_error: Exception | None = None

            for attempt in range(max_retries + 1):
                if options and options.get("signal", {}).get("aborted"):
                    raise RuntimeError("Request was aborted")

                try:
                    timeout = httpx.Timeout(
                        DEFAULT_SSE_HEADER_TIMEOUT_MS / 1000,
                        read=None,
                    )
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        response = await client.post(
                            _resolve_codex_url(model.get("baseUrl")),
                            headers=sse_headers,
                            content=body_json,
                        )

                    if options and options.get("onResponse"):
                        await options["onResponse"](
                            {
                                "status": response.status_code,
                                "headers": headers_to_record(response.headers),
                            },
                            model,
                        )

                    if response.is_success:
                        break

                    error_text = response.text
                    if attempt < max_retries and _is_retryable_error(
                        response.status_code, error_text
                    ):
                        retry_after_delay_ms = _get_retry_after_delay_ms(response.headers)
                        if retry_after_delay_ms is None:
                            delay_ms = BASE_DELAY_MS * (2**attempt)
                        elif response.status_code == 429:
                            delay_ms = _cap_retry_delay_ms(retry_after_delay_ms, options)
                        else:
                            delay_ms = retry_after_delay_ms
                        await _sleep(delay_ms, options.get("signal") if options else None)
                        continue

                    info = await _parse_error_response(response)
                    raise RuntimeError(info.get("friendlyMessage") or info["message"])
                except Exception as error:
                    if isinstance(error, RuntimeError) and str(error) == "Request was aborted":
                        raise
                    last_error = error if isinstance(error, Exception) else RuntimeError(str(error))
                    if attempt < max_retries and "usage limit" not in str(last_error):
                        await _sleep(
                            BASE_DELAY_MS * (2**attempt), options.get("signal") if options else None
                        )
                        continue
                    raise last_error

            if response is None or not response.is_success:
                raise last_error or RuntimeError("Failed after retries")

            stream.push({"type": "start", "partial": output})
            events = _map_codex_events(
                _parse_sse(response, options.get("signal") if options else None)
            )
            await process_responses_stream(
                events,
                output,
                stream,
                model,
                OpenAIResponsesStreamOptions(
                    service_tier=options.get("serviceTier") if options else None,
                    resolve_service_tier=_resolve_codex_service_tier,
                    apply_service_tier_pricing=lambda usage, service_tier: _apply_service_tier_pricing(
                        usage, service_tier, model["id"]
                    ),
                ),
            )

            if options and options.get("signal", {}).get("aborted"):
                raise RuntimeError("Request was aborted")

            stream.push({"type": "done", "reason": output["stopReason"], "message": output})
            stream.end()
        except Exception as error:
            for block in output["content"]:
                block.pop("partialJson", None)
            output["stopReason"] = (
                "aborted" if (options and options.get("signal", {}).get("aborted")) else "error"
            )
            output["errorMessage"] = str(error)
            stream.push({"type": "error", "reason": output["stopReason"], "error": output})
            stream.end()

    asyncio.create_task(run())
    return stream


def stream_simple_openai_codex_responses(
    model: Model[str],
    context: Context,
    options: SimpleStreamOptions | None = None,
) -> AssistantMessageEventStream:
    api_key = options.get("apiKey") if options else None
    if not api_key:
        raise ValueError(f"No API key for provider: {model['provider']}")

    base = build_base_options(model, options, api_key)
    clamped_reasoning = (
        clamp_thinking_level(model, options["reasoning"])
        if options and options.get("reasoning")
        else None
    )
    reasoning_effort = None if clamped_reasoning == "off" else clamped_reasoning
    return stream_openai_codex_responses(
        model, context, {**base, "reasoningEffort": reasoning_effort}
    )


def get_openai_codex_websocket_debug_stats(session_id: str) -> dict[str, Any] | None:
    return None


def reset_openai_codex_websocket_debug_stats(session_id: str | None = None) -> None:
    return None


def close_openai_codex_websocket_sessions(session_id: str | None = None) -> None:
    return None
