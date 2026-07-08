import json
import time
from typing import Any, Union, cast, Literal

import httpx
from pi_mono.ai.types import (
    AssistantMessage,
    AssistantMessageEvent,
    Context,
    Model,
    SimpleStreamOptions,
    ToolCall,
)
from pi_mono.utils.event_stream import EventStream
from pi_mono.utils.json_parse import parse_streaming_json


class ProxyMessageEventStream(EventStream[AssistantMessageEvent, AssistantMessage]):
    def __init__(self) -> None:
        super().__init__(
            is_complete=lambda event: event["type"] in ("done", "error"),
            extract_result=self._extract_result,
        )

    def _extract_result(self, event: AssistantMessageEvent) -> AssistantMessage:
        if event["type"] == "done":
            return event["message"]
        elif event["type"] == "error":
            return event["error"]
        raise ValueError("Unexpected event type for final result")


ProxyAssistantMessageEvent = Union[
    dict[str, Any],  # general dictionary matching ProxyAssistantMessageEvent
]


class ProxyStreamOptions(SimpleStreamOptions, total=False):
    authToken: str
    proxyUrl: str


def build_proxy_request_options(options: ProxyStreamOptions) -> dict[str, Any]:
    serialized: dict[str, Any] = {}
    for key in (
        "temperature",
        "maxTokens",
        "reasoning",
        "cacheRetention",
        "sessionId",
        "headers",
        "metadata",
        "transport",
        "thinkingBudgets",
        "maxRetryDelayMs",
    ):
        if key in options:
            serialized[key] = options[key]  # type: ignore
    return serialized


def ensure_content_index(content_list: list[Any], index: int, default_val: Any = None) -> None:
    while len(content_list) <= index:
        content_list.append(default_val)


def process_proxy_event(
    proxy_event: dict[str, Any],
    partial: AssistantMessage,
) -> AssistantMessageEvent | None:
    event_type = proxy_event.get("type")

    if event_type == "start":
        return {"type": "start", "partial": partial}

    elif event_type == "text_start":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        partial["content"][content_index] = {"type": "text", "text": ""}
        return {"type": "text_start", "contentIndex": content_index, "partial": partial}

    elif event_type == "text_delta":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        content = partial["content"][content_index]
        if content and content.get("type") == "text":
            content["text"] += proxy_event["delta"]
            return {
                "type": "text_delta",
                "contentIndex": content_index,
                "delta": proxy_event["delta"],
                "partial": partial,
            }
        raise ValueError("Received text_delta for non-text content")

    elif event_type == "text_end":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        content = partial["content"][content_index]
        if content and content.get("type") == "text":
            if "contentSignature" in proxy_event:
                content["textSignature"] = proxy_event["contentSignature"]
            return {
                "type": "text_end",
                "contentIndex": content_index,
                "content": content["text"],
                "partial": partial,
            }
        raise ValueError("Received text_end for non-text content")

    elif event_type == "thinking_start":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        partial["content"][content_index] = {"type": "thinking", "thinking": ""}
        return {"type": "thinking_start", "contentIndex": content_index, "partial": partial}

    elif event_type == "thinking_delta":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        content = partial["content"][content_index]
        if content and content.get("type") == "thinking":
            content["thinking"] += proxy_event["delta"]
            return {
                "type": "thinking_delta",
                "contentIndex": content_index,
                "delta": proxy_event["delta"],
                "partial": partial,
            }
        raise ValueError("Received thinking_delta for non-thinking content")

    elif event_type == "thinking_end":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        content = partial["content"][content_index]
        if content and content.get("type") == "thinking":
            if "contentSignature" in proxy_event:
                content["thinkingSignature"] = proxy_event["contentSignature"]
            return {
                "type": "thinking_end",
                "contentIndex": content_index,
                "content": content["thinking"],
                "partial": partial,
            }
        raise ValueError("Received thinking_end for non-thinking content")

    elif event_type == "toolcall_start":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        tool_call_obj = cast(
            ToolCall,
            {
                "type": "toolCall",
                "id": proxy_event["id"],
                "name": proxy_event["toolName"],
                "arguments": {},
                "partialJson": "",
            },
        )
        partial["content"][content_index] = tool_call_obj
        return {"type": "toolcall_start", "contentIndex": content_index, "partial": partial}

    elif event_type == "toolcall_delta":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        content = partial["content"][content_index]
        if content and content.get("type") == "toolCall":
            dict_content = cast(dict[str, Any], content)
            dict_content["partialJson"] = dict_content.get("partialJson", "") + proxy_event["delta"]
            dict_content["arguments"] = parse_streaming_json(dict_content["partialJson"]) or {}
            return {
                "type": "toolcall_delta",
                "contentIndex": content_index,
                "delta": proxy_event["delta"],
                "partial": partial,
            }
        raise ValueError("Received toolcall_delta for non-toolCall content")

    elif event_type == "toolcall_end":
        content_index = proxy_event["contentIndex"]
        ensure_content_index(partial["content"], content_index)
        content = partial["content"][content_index]
        if content and content.get("type") == "toolCall":
            dict_content = cast(dict[str, Any], content)
            if "partialJson" in dict_content:
                del dict_content["partialJson"]
            return {
                "type": "toolcall_end",
                "contentIndex": content_index,
                "toolCall": content,
                "partial": partial,
            }
        return None

    elif event_type == "done":
        partial["stopReason"] = proxy_event["reason"]
        partial["usage"] = proxy_event["usage"]
        return {"type": "done", "reason": proxy_event["reason"], "message": partial}

    elif event_type == "error":
        partial["stopReason"] = proxy_event["reason"]
        if "errorMessage" in proxy_event:
            partial["errorMessage"] = proxy_event["errorMessage"]
        partial["usage"] = proxy_event["usage"]
        return {"type": "error", "reason": proxy_event["reason"], "error": partial}

    return None


def stream_proxy(
    model: Model,
    context: Context,
    options: ProxyStreamOptions,
) -> ProxyMessageEventStream:
    stream = ProxyMessageEventStream()

    async def run() -> None:
        partial: AssistantMessage = {
            "role": "assistant",
            "stopReason": "stop",
            "content": [],
            "api": model.get("api", "unknown"),
            "provider": model.get("provider", "unknown"),
            "model": model.get("id", "unknown"),
            "usage": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 0,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            },
            "timestamp": int(time.time() * 1000),
        }

        signal = options.get("signal")
        client = httpx.AsyncClient()

        # Handle cancellation
        abort_called = False

        def abort_handler() -> None:
            nonlocal abort_called
            abort_called = True

        if signal:
            signal.add_event_listener("abort", abort_handler, once=True)

        try:
            if signal and signal.aborted:
                raise RuntimeError("Request aborted by user")

            async with client.stream(
                "POST",
                f"{options['proxyUrl']}/api/stream",
                headers={
                    "Authorization": f"Bearer {options['authToken']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "context": context,
                    "options": build_proxy_request_options(options),
                },
                timeout=None,
            ) as response:
                if abort_called or (signal and signal.aborted):
                    raise RuntimeError("Request aborted by user")

                if response.status_code != 200:
                    error_msg = f"Proxy error: {response.status_code} {response.reason_phrase}"
                    try:
                        error_data = response.json()
                        if isinstance(error_data, dict) and "error" in error_data:
                            error_msg = f"Proxy error: {error_data['error']}"
                    except Exception:
                        pass
                    raise RuntimeError(error_msg)

                async for line in response.aiter_lines():
                    if abort_called or (signal and signal.aborted):
                        raise RuntimeError("Request aborted by user")

                    if line.startswith("data: "):
                        data = line[6:].strip()
                        if data:
                            proxy_event = json.loads(data)
                            event = process_proxy_event(proxy_event, partial)
                            if event:
                                stream.push(event)

            if signal and signal.aborted:
                raise RuntimeError("Request aborted by user")

            stream.end()
        except Exception as error:
            error_message = str(error)
            reason: Literal["aborted", "error"] = (
                "aborted" if (signal and signal.aborted) else "error"
            )
            partial["stopReason"] = reason
            partial["errorMessage"] = error_message
            stream.push(
                {
                    "type": "error",
                    "reason": reason,
                    "error": partial,
                }
            )
            stream.end()
        finally:
            await client.aclose()
            if signal:
                signal.remove_event_listener("abort", abort_handler)

    import asyncio

    asyncio.create_task(run())
    return stream
