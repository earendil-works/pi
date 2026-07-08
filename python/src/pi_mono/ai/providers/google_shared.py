import base64
import re
from typing import Any, Dict, List, Literal, Optional, cast

from google.genai import types
from google.genai.types import Content, FinishReason, FunctionCallingConfigMode, Part

from pi_mono.ai.types import AssistantMessage, Context, Model, StopReason, Tool
from pi_mono.utils.sanitize_unicode import sanitize_surrogates
from pi_mono.ai.providers.transform_messages import transform_messages

GoogleThinkingLevel = Literal["THINKING_LEVEL_UNSPECIFIED", "MINIMAL", "LOW", "MEDIUM", "HIGH"]


def is_thinking_part(part: Any) -> bool:
    """Determines whether a streamed Gemini Part should be treated as thinking."""
    if isinstance(part, dict):
        return part.get("thought") is True
    return getattr(part, "thought", None) is True


def retain_thought_signature(existing: Optional[str], incoming: Optional[str]) -> Optional[str]:
    """Retain thought signatures during streaming."""
    if isinstance(incoming, str) and len(incoming) > 0:
        return incoming
    return existing


base64_signature_pattern = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def is_valid_thought_signature(signature: Optional[str]) -> bool:
    if not signature:
        return False
    if len(signature) % 4 != 0:
        return False
    return bool(base64_signature_pattern.match(signature))


def resolve_thought_signature(
    is_same_provider_and_model: bool, signature: Optional[str]
) -> Optional[str]:
    return (
        signature
        if (is_same_provider_and_model and is_valid_thought_signature(signature))
        else None
    )


def requires_tool_call_id(model_id: str) -> bool:
    return model_id.startswith("claude-") or model_id.startswith("gpt-oss-")


def get_gemini_major_version(model_id: str) -> Optional[int]:
    match = re.match(r"^gemini(?:-live)?-(\d+)", model_id.lower())
    if not match:
        return None
    return int(match.group(1))


def supports_multimodal_function_response(model_id: str) -> bool:
    gemini_major_version = get_gemini_major_version(model_id)
    if gemini_major_version is not None:
        return gemini_major_version >= 3
    return True


def convert_messages(model: Model, context: Context) -> List[Content]:
    contents: List[Content] = []

    def normalize_tool_call_id(
        id_val: str, model_val: Model, assistant_msg: AssistantMessage
    ) -> str:
        if not requires_tool_call_id(model_val["id"]):
            return id_val
        return re.sub(r"[^a-zA-Z0-9_-]", "_", id_val)[:64]

    transformed_messages = transform_messages(
        context.get("messages", []), model, normalize_tool_call_id
    )

    for msg in transformed_messages:
        msg_role = msg.get("role")
        msg_content = msg.get("content")

        if msg_role == "user":
            if isinstance(msg_content, str):
                contents.append(
                    Content(
                        role="user",
                        parts=[Part(text=sanitize_surrogates(msg_content))],
                    )
                )
            else:
                parts = []
                for item_val in msg_content or []:
                    item = cast(Dict[str, Any], item_val)
                    if item.get("type") == "text":
                        parts.append(Part(text=sanitize_surrogates(item.get("text", ""))))
                    else:
                        parts.append(
                            Part(
                                inline_data=types.Blob(
                                    mime_type=item.get("mimeType"),
                                    data=item.get("data", ""),
                                )
                            )
                        )
                if not parts:
                    continue
                contents.append(Content(role="user", parts=parts))
        elif msg_role == "assistant":
            parts = []
            is_same_provider_and_model = msg.get("provider") == model.get("provider") and msg.get(
                "model"
            ) == model.get("id")

            for block_val in msg_content or []:
                block = cast(Dict[str, Any], block_val)
                block_type = block.get("type")
                if block_type == "text":
                    text_val = block.get("text")
                    if not text_val or text_val.strip() == "":
                        continue
                    thought_signature_str = resolve_thought_signature(
                        is_same_provider_and_model, block.get("textSignature")
                    )
                    thought_signature = (
                        base64.b64decode(thought_signature_str) if thought_signature_str else None
                    )
                    part = Part(text=sanitize_surrogates(text_val))
                    if thought_signature:
                        part.thought_signature = thought_signature
                    parts.append(part)
                elif block_type == "thinking":
                    thinking_val = block.get("thinking")
                    if not thinking_val or thinking_val.strip() == "":
                        continue
                    if is_same_provider_and_model:
                        thought_signature_str = resolve_thought_signature(
                            is_same_provider_and_model, block.get("thinkingSignature")
                        )
                        thought_signature = (
                            base64.b64decode(thought_signature_str)
                            if thought_signature_str
                            else None
                        )
                        part = Part(thought=True, text=sanitize_surrogates(thinking_val))
                        if thought_signature:
                            part.thought_signature = thought_signature
                        parts.append(part)
                    else:
                        parts.append(Part(text=sanitize_surrogates(thinking_val)))
                elif block_type == "toolCall":
                    thought_signature_str = resolve_thought_signature(
                        is_same_provider_and_model, block.get("thoughtSignature")
                    )
                    thought_signature = (
                        base64.b64decode(thought_signature_str) if thought_signature_str else None
                    )
                    func_call_args = block.get("arguments") or {}
                    func_call_dict: Dict[str, Any] = {
                        "name": block.get("name"),
                        "args": func_call_args,
                    }
                    if requires_tool_call_id(model["id"]):
                        func_call_dict["id"] = block.get("id")

                    part = Part(function_call=types.FunctionCall(**func_call_dict))
                    if thought_signature:
                        part.thought_signature = thought_signature
                    parts.append(part)

            if not parts:
                continue
            contents.append(Content(role="model", parts=parts))
        elif msg_role == "toolResult":
            # Extract text and image content
            text_content = [
                cast(Dict[str, Any], c)
                for c in (msg_content or [])
                if cast(Dict[str, Any], c).get("type") == "text"
            ]
            text_result = "\n".join(c.get("text", "") for c in text_content)

            image_content = []
            if "image" in model.get("input", []):
                image_content = [
                    cast(Dict[str, Any], c)
                    for c in (msg_content or [])
                    if cast(Dict[str, Any], c).get("type") == "image"
                ]

            has_text = len(text_result) > 0
            has_images = len(image_content) > 0

            model_supports_multimodal = supports_multimodal_function_response(model["id"])
            response_value = (
                sanitize_surrogates(text_result)
                if has_text
                else ("(see attached image)" if has_images else "")
            )

            image_parts = [
                Part(
                    inline_data=types.Blob(
                        mime_type=img.get("mimeType", ""),
                        data=img.get("data", ""),
                    )
                )
                for img in image_content
            ]

            include_id = requires_tool_call_id(model["id"])
            func_response_dict: Dict[str, Any] = {
                "name": msg.get("toolName"),
                "response": (
                    {"error": response_value} if msg.get("isError") else {"output": response_value}
                ),
            }
            if has_images and model_supports_multimodal:
                func_response_dict["parts"] = image_parts
            if include_id:
                func_response_dict["id"] = msg.get("toolCallId")

            function_response_part = Part(
                function_response=types.FunctionResponse(**func_response_dict)
            )

            # Check if the last content is already a user turn with function responses and merge
            last_content = contents[-1] if contents else None
            if (
                last_content
                and last_content.role == "user"
                and any(
                    getattr(p, "function_response", None) is not None
                    for p in (last_content.parts or [])
                )
            ):
                if last_content.parts is None:
                    last_content.parts = []
                last_content.parts.append(function_response_part)
            else:
                contents.append(Content(role="user", parts=[function_response_part]))

            # For Gemini < 3, add images in a separate user message
            if has_images and not model_supports_multimodal:
                contents.append(
                    Content(
                        role="user",
                        parts=[Part(text="Tool result image:")] + image_parts,
                    )
                )

    return contents


JSON_SCHEMA_META_DECLARATIONS = {
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
}


def sanitize_for_openapi(schema: Any) -> Any:
    if not isinstance(schema, dict):
        return schema
    result = {}
    for k, v in schema.items():
        if k in JSON_SCHEMA_META_DECLARATIONS:
            continue
        result[k] = sanitize_for_openapi(v)
    return result


def convert_tools(
    tools: List[Tool],
    use_parameters: bool = False,
) -> Optional[List[Dict[str, Any]]]:
    if not tools:
        return None

    function_declarations = []
    for tool in tools:
        fd: Dict[str, Any] = {
            "name": tool.get("name"),
            "description": tool.get("description"),
        }
        if use_parameters:
            fd["parameters"] = sanitize_for_openapi(tool.get("parameters"))
        else:
            fd["parameters_json_schema"] = tool.get("parameters")
        function_declarations.append(fd)

    # Note: the python SDK accepts list of tools where each tool has function_declarations (snake_case)
    return [{"function_declarations": function_declarations}]


def map_tool_choice(choice: str) -> FunctionCallingConfigMode:
    c = choice.lower()
    if c == "auto":
        return FunctionCallingConfigMode.AUTO
    elif c == "none":
        return FunctionCallingConfigMode.NONE
    elif c == "any":
        return FunctionCallingConfigMode.ANY
    return FunctionCallingConfigMode.AUTO


def map_stop_reason(reason: FinishReason) -> StopReason:
    if reason == FinishReason.STOP:
        return "stop"
    elif reason == FinishReason.MAX_TOKENS:
        return "length"
    elif reason in (
        FinishReason.BLOCKLIST,
        FinishReason.PROHIBITED_CONTENT,
        FinishReason.SPII,
        FinishReason.SAFETY,
        FinishReason.IMAGE_SAFETY,
        FinishReason.IMAGE_PROHIBITED_CONTENT,
        FinishReason.IMAGE_RECITATION,
        FinishReason.IMAGE_OTHER,
        FinishReason.RECITATION,
        FinishReason.FINISH_REASON_UNSPECIFIED,
        FinishReason.OTHER,
        FinishReason.LANGUAGE,
        FinishReason.MALFORMED_FUNCTION_CALL,
        FinishReason.UNEXPECTED_TOOL_CALL,
        FinishReason.NO_IMAGE,
    ):
        return "error"
    else:
        raise ValueError(f"Unhandled stop reason: {reason}")


def map_stop_reason_string(reason: str) -> StopReason:
    r = reason.upper()
    if r == "STOP":
        return "stop"
    elif r == "MAX_TOKENS":
        return "length"
    return "error"
