import asyncio
import copy
import json
import math
import random
import time
from typing import Any, Dict, List, Optional, TypedDict, cast, Literal

from pi_mono.ai.api_registry import register_api_provider, unregister_api_providers
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    StreamOptions,
    TextContent,
    ThinkingContent,
    ToolCall,
    Usage,
)
from pi_mono.utils.event_stream import (
    AssistantMessageEventStream,
    create_assistant_message_event_stream,
)

DEFAULT_API = "faux"
DEFAULT_PROVIDER = "faux"
DEFAULT_MODEL_ID = "faux-1"
DEFAULT_MODEL_NAME = "Faux Model"
DEFAULT_BASE_URL = "http://localhost:0"
DEFAULT_MIN_TOKEN_SIZE = 3
DEFAULT_MAX_TOKEN_SIZE = 5

DEFAULT_USAGE: Usage = {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 0,
    "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0},
}


def faux_text(text: str) -> TextContent:
    return {"type": "text", "text": text}


def faux_thinking(thinking: str) -> ThinkingContent:
    return {"type": "thinking", "thinking": thinking}


def faux_tool_call(name: str, arguments: dict[str, Any], id: Optional[str] = None) -> ToolCall:
    return {
        "type": "toolCall",
        "id": id if id is not None else random_id("tool"),
        "name": name,
        "arguments": arguments,
    }


def _normalize_faux_assistant_content(content: Any) -> List[Any]:
    if isinstance(content, str):
        return [faux_text(content)]
    if isinstance(content, list):
        return content
    return [content]


def faux_assistant_message(
    content: Any, options: Optional[Dict[str, Any]] = None
) -> AssistantMessage:
    opts = options or {}
    msg: AssistantMessage = {
        "role": "assistant",
        "content": _normalize_faux_assistant_content(content),
        "api": DEFAULT_API,
        "provider": DEFAULT_PROVIDER,
        "model": DEFAULT_MODEL_ID,
        "usage": copy.deepcopy(DEFAULT_USAGE),
        "stopReason": opts.get("stopReason", "stop"),
        "timestamp": opts.get("timestamp", int(time.time() * 1000)),
    }
    if opts.get("errorMessage") is not None:
        msg["errorMessage"] = str(opts["errorMessage"])
    if opts.get("responseId") is not None:
        msg["responseId"] = str(opts["responseId"])
    return msg


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


def random_id(prefix: str) -> str:
    return f"{prefix}:{int(time.time() * 1000)}:{random.randint(100000, 999999)}"


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif "mimeType" in block:
            parts.append(f"[image:{block.get('mimeType')}:{len(block.get('data', ''))}]")
    return "\n".join(parts)


def _assistant_content_to_text(content: List[Any]) -> str:
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            parts.append(block.get("text", ""))
        elif block_type == "thinking":
            parts.append(block.get("thinking", ""))
        elif block_type == "toolCall":
            parts.append(f"{block.get('name')}:{json.dumps(block.get('arguments', {}))}")
    return "\n".join(parts)


def _tool_result_to_text(message: Dict[str, Any]) -> str:
    content = message.get("content", [])
    content_list = content if isinstance(content, list) else [content]
    return "\n".join([message.get("toolName", "")] + [_content_to_text(content_list)])


def _message_to_text(message: Dict[str, Any]) -> str:
    role = message.get("role")
    if role == "user":
        return _content_to_text(message.get("content"))
    if role == "assistant":
        return _assistant_content_to_text(message.get("content", []))
    return _tool_result_to_text(message)


def _serialize_context(context: Context) -> str:
    parts = []
    if context.get("systemPrompt"):
        parts.append(f"system:{context['systemPrompt']}")
    for message in context.get("messages", []):
        parts.append(f"{message.get('role')}:{_message_to_text(message)}")
    tools = context.get("tools")
    if tools:
        parts.append(f"tools:{json.dumps(tools)}")
    return "\n\n".join(parts)


def _common_prefix_length(a: str, b: str) -> int:
    length = min(len(a), len(b))
    index = 0
    while index < length and a[index] == b[index]:
        index += 1
    return index


def _with_usage_estimate(
    message: AssistantMessage,
    context: Context,
    options: Optional[StreamOptions],
    prompt_cache: Dict[str, str],
) -> AssistantMessage:
    prompt_text = _serialize_context(context)
    prompt_tokens = estimate_tokens(prompt_text)
    output_tokens = estimate_tokens(_assistant_content_to_text(message.get("content", [])))
    input_tokens = prompt_tokens
    cache_read = 0
    cache_write = 0
    session_id = options.get("sessionId") if options else None

    if session_id and options and options.get("cacheRetention") != "none":
        previous_prompt = prompt_cache.get(session_id)
        if previous_prompt:
            cached_chars = _common_prefix_length(previous_prompt, prompt_text)
            cache_read = estimate_tokens(previous_prompt[:cached_chars])
            cache_write = estimate_tokens(prompt_text[cached_chars:])
            input_tokens = max(0, prompt_tokens - cache_read)
        else:
            cache_write = prompt_tokens
        prompt_cache[session_id] = prompt_text

    msg = copy.deepcopy(message)
    usage_val: Usage = {
        "input": input_tokens,
        "output": output_tokens,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "totalTokens": input_tokens + output_tokens + cache_read + cache_write,
        "cost": {
            "input": 0.0,
            "output": 0.0,
            "cacheRead": 0.0,
            "cacheWrite": 0.0,
            "total": 0.0,
        },
    }
    msg["usage"] = usage_val
    return msg


def split_string_by_token_size(text: str, min_token_size: int, max_token_size: int) -> List[str]:
    chunks = []
    index = 0
    while index < len(text):
        token_size = min_token_size + random.randint(0, max_token_size - min_token_size)
        char_size = max(1, token_size * 4)
        chunks.append(text[index : index + char_size])
        index += char_size
    return chunks if chunks else [""]


def _clone_message(
    message: AssistantMessage, api: str, provider: str, model_id: str
) -> AssistantMessage:
    cloned = copy.deepcopy(message)
    cloned["api"] = api
    cloned["provider"] = provider
    cloned["model"] = model_id
    if "timestamp" not in cloned:
        cloned["timestamp"] = int(time.time() * 1000)
    if "usage" not in cloned:
        cloned["usage"] = copy.deepcopy(DEFAULT_USAGE)
    return cloned


def _create_error_message(error: Any, api: str, provider: str, model_id: str) -> AssistantMessage:
    return {
        "role": "assistant",
        "content": [],
        "api": api,
        "provider": provider,
        "model": model_id,
        "usage": copy.deepcopy(DEFAULT_USAGE),
        "stopReason": "error",
        "errorMessage": str(error) if isinstance(error, Exception) else str(error),
        "timestamp": int(time.time() * 1000),
    }


def _create_aborted_message(partial: AssistantMessage) -> AssistantMessage:
    msg = copy.deepcopy(partial)
    msg["stopReason"] = "aborted"
    msg["errorMessage"] = "Request was aborted"
    msg["timestamp"] = int(time.time() * 1000)
    return msg


async def schedule_chunk(chunk: str, tokens_per_second: Optional[float]) -> None:
    if not tokens_per_second or tokens_per_second <= 0:
        await asyncio.sleep(0)
        return
    delay_ms = (estimate_tokens(chunk) / tokens_per_second) * 1000
    await asyncio.sleep(delay_ms / 1000.0)


async def stream_with_deltas(
    stream_obj: AssistantMessageEventStream,
    message: AssistantMessage,
    min_token_size: int,
    max_token_size: int,
    tokens_per_second: Optional[float],
    signal: Optional[Any],
) -> None:
    if signal and getattr(signal, "aborted", False):
        aborted = _create_aborted_message(message)
        stream_obj.push({"type": "error", "reason": "aborted", "error": aborted})
        stream_obj.end(aborted)
        return

    partial: AssistantMessage = copy.deepcopy(message)
    partial["content"] = []

    stream_obj.push({"type": "start", "partial": partial})

    for index, block in enumerate(message.get("content", [])):
        if signal and getattr(signal, "aborted", False):
            aborted = _create_aborted_message(partial)
            stream_obj.push({"type": "error", "reason": "aborted", "error": aborted})
            stream_obj.end(aborted)
            return

        block_type = block.get("type")

        if block_type == "thinking":
            partial["content"].append({"type": "thinking", "thinking": ""})
            stream_obj.push(
                {"type": "thinking_start", "contentIndex": index, "partial": copy.deepcopy(partial)}
            )
            thinking_text = str(block.get("thinking", ""))
            for chunk in split_string_by_token_size(thinking_text, min_token_size, max_token_size):
                await schedule_chunk(chunk, tokens_per_second)
                if signal and getattr(signal, "aborted", False):
                    aborted = _create_aborted_message(partial)
                    stream_obj.push({"type": "error", "reason": "aborted", "error": aborted})
                    stream_obj.end(aborted)
                    return
                # Cast is safe because type is thinking
                partial["content"][index]["thinking"] += chunk  # type: ignore
                stream_obj.push(
                    {
                        "type": "thinking_delta",
                        "contentIndex": index,
                        "delta": chunk,
                        "partial": copy.deepcopy(partial),
                    }
                )
            stream_obj.push(
                {
                    "type": "thinking_end",
                    "contentIndex": index,
                    "content": thinking_text,
                    "partial": copy.deepcopy(partial),
                }
            )

        elif block_type == "text":
            partial["content"].append({"type": "text", "text": ""})
            stream_obj.push(
                {"type": "text_start", "contentIndex": index, "partial": copy.deepcopy(partial)}
            )
            text_val = str(block.get("text", ""))
            for chunk in split_string_by_token_size(text_val, min_token_size, max_token_size):
                await schedule_chunk(chunk, tokens_per_second)
                if signal and getattr(signal, "aborted", False):
                    aborted = _create_aborted_message(partial)
                    stream_obj.push({"type": "error", "reason": "aborted", "error": aborted})
                    stream_obj.end(aborted)
                    return
                # Cast is safe because type is text
                partial["content"][index]["text"] += chunk  # type: ignore
                stream_obj.push(
                    {
                        "type": "text_delta",
                        "contentIndex": index,
                        "delta": chunk,
                        "partial": copy.deepcopy(partial),
                    }
                )
            stream_obj.push(
                {
                    "type": "text_end",
                    "contentIndex": index,
                    "content": text_val,
                    "partial": copy.deepcopy(partial),
                }
            )

        elif block_type == "toolCall":
            block_id = str(block.get("id", ""))
            block_name = str(block.get("name", ""))
            partial["content"].append(
                {
                    "type": "toolCall",
                    "id": block_id,
                    "name": block_name,
                    "arguments": {},
                }
            )
            stream_obj.push(
                {"type": "toolcall_start", "contentIndex": index, "partial": copy.deepcopy(partial)}
            )
            args_str = json.dumps(block.get("arguments", {}))
            for chunk in split_string_by_token_size(args_str, min_token_size, max_token_size):
                await schedule_chunk(chunk, tokens_per_second)
                if signal and getattr(signal, "aborted", False):
                    aborted = _create_aborted_message(partial)
                    stream_obj.push({"type": "error", "reason": "aborted", "error": aborted})
                    stream_obj.end(aborted)
                    return
                stream_obj.push(
                    {
                        "type": "toolcall_delta",
                        "contentIndex": index,
                        "delta": chunk,
                        "partial": copy.deepcopy(partial),
                    }
                )
            partial["content"][index]["arguments"] = block.get("arguments", {})  # type: ignore
            stream_obj.push(
                {
                    "type": "toolcall_end",
                    "contentIndex": index,
                    "toolCall": cast(ToolCall, block),
                    "partial": copy.deepcopy(partial),
                }
            )

    stop_reason = message.get("stopReason")
    if stop_reason in ("error", "aborted"):
        stream_obj.push(
            {
                "type": "error",
                "reason": cast(Literal["aborted", "error"], stop_reason),
                "error": message,
            }
        )
        stream_obj.end(message)
        return

    stream_obj.push(
        {
            "type": "done",
            "reason": cast(Literal["stop", "length", "toolUse"], stop_reason),
            "message": message,
        }
    )
    stream_obj.end(message)


class FauxModelDefinition(TypedDict, total=False):
    id: str
    name: str
    reasoning: bool
    input: List[str]
    cost: Dict[str, float]
    contextWindow: int
    maxTokens: int


class FauxProviderRegistration:
    def __init__(
        self,
        api: str,
        models: List[Model],
        state: Dict[str, int],
        source_id: str,
        prompt_cache: Dict[str, str],
    ):
        self.api = api
        self.models = models
        self.state = state
        self._source_id = source_id
        self._prompt_cache = prompt_cache
        self._pending_responses: List[Any] = []

    def get_model(self, requested_model_id: Optional[str] = None) -> Optional[Model]:
        if not requested_model_id:
            return self.models[0] if self.models else None
        return next((m for m in self.models if m["id"] == requested_model_id), None)

    def set_responses(self, responses: List[Any]) -> None:
        self._pending_responses = list(responses)

    def append_responses(self, responses: List[Any]) -> None:
        self._pending_responses.extend(responses)

    def get_pending_response_count(self) -> int:
        return len(self._pending_responses)

    def unregister(self) -> None:
        unregister_api_providers(self._source_id)


def register_faux_provider(options: Optional[Dict[str, Any]] = None) -> FauxProviderRegistration:
    """Register a faux provider for testing."""
    opts = options or {}
    api = opts.get("api") or random_id(DEFAULT_API)
    provider = opts.get("provider") or DEFAULT_PROVIDER
    source_id = random_id("faux-provider")

    min_token_size = max(
        1,
        min(
            opts.get("tokenSize", {}).get("min", DEFAULT_MIN_TOKEN_SIZE),
            opts.get("tokenSize", {}).get("max", DEFAULT_MAX_TOKEN_SIZE),
        ),
    )
    max_token_size = max(
        min_token_size, opts.get("tokenSize", {}).get("max", DEFAULT_MAX_TOKEN_SIZE)
    )
    tokens_per_second = opts.get("tokensPerSecond")
    state = {"callCount": 0}
    prompt_cache: Dict[str, str] = {}

    model_defs = opts.get("models")
    if not model_defs:
        model_defs = [
            {
                "id": DEFAULT_MODEL_ID,
                "name": DEFAULT_MODEL_NAME,
                "reasoning": False,
                "input": ["text", "image"],
                "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0},
                "contextWindow": 128000,
                "maxTokens": 16384,
            }
        ]

    models: List[Model] = []
    for definition in model_defs:
        models.append(
            {
                "id": definition["id"],
                "name": definition.get("name", definition["id"]),
                "api": api,
                "provider": provider,
                "baseUrl": DEFAULT_BASE_URL,
                "reasoning": definition.get("reasoning", False),
                "input": definition.get("input", ["text", "image"]),  # type: ignore
                "cost": definition.get(
                    "cost", {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0}
                ),
                "contextWindow": definition.get("contextWindow", 128000),
                "maxTokens": definition.get("maxTokens", 16384),
            }
        )

    registration = FauxProviderRegistration(api, models, state, source_id, prompt_cache)

    def stream_impl(
        request_model: Model, context: Context, stream_options: Optional[StreamOptions] = None
    ) -> AssistantMessageEventStream:
        outer = create_assistant_message_event_stream()
        state["callCount"] += 1

        async def run_async_stream():
            try:
                # Trigger onResponse hook if provided
                on_resp = stream_options.get("onResponse") if stream_options else None
                if on_resp and callable(on_resp):
                    await on_resp({"status": 200, "headers": {}}, request_model)

                if not registration._pending_responses:
                    message = _create_error_message(
                        "No more faux responses queued", api, provider, request_model["id"]
                    )
                    message = _with_usage_estimate(
                        message, context, stream_options, registration._prompt_cache
                    )
                    outer.push({"type": "error", "reason": "error", "error": message})
                    outer.end(message)
                    return

                step = registration._pending_responses.pop(0)
                if callable(step):
                    resolved = await step(context, stream_options, state, request_model)
                else:
                    resolved = step

                message = _clone_message(resolved, api, provider, request_model["id"])
                message = _with_usage_estimate(
                    message, context, stream_options, registration._prompt_cache
                )
                await stream_with_deltas(
                    outer,
                    message,
                    min_token_size,
                    max_token_size,
                    tokens_per_second,
                    stream_options.get("signal") if stream_options else None,
                )
            except Exception as error:
                message = _create_error_message(error, api, provider, request_model["id"])
                outer.push({"type": "error", "reason": "error", "error": message})
                outer.end(message)

        # Launch the async stream processing in the running event loop
        asyncio.get_running_loop().create_task(run_async_stream())
        return outer

    def stream_simple_impl(
        stream_model: Model, context: Context, stream_options: Optional[SimpleStreamOptions] = None
    ) -> AssistantMessageEventStream:
        return stream_impl(stream_model, context, stream_options)

    class WrapperProvider:
        def __init__(self, api_val: str):
            self.api = api_val

        def stream(self, model, context, options=None):
            return stream_impl(model, context, options)

        def stream_simple(self, model, context, options=None):
            return stream_simple_impl(model, context, options)

    register_api_provider(WrapperProvider(api), source_id)
    return registration
