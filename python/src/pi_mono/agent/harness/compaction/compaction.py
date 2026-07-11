"""Compaction module for session history summarization."""

from __future__ import annotations

import asyncio
from typing import Any, TypeVar

from pi_mono.ai.types import Model, Usage
from pi_mono.ai.stream import complete_simple
from pi_mono.agent.types import AgentMessage, ThinkingLevel
from pi_mono.agent.harness.messages import (
    convert_to_llm,
    create_branch_summary_message,
    create_compaction_summary_message,
    create_custom_message,
)
from pi_mono.agent.harness.session.session import build_session_context
from pi_mono.agent.harness.types import (
    Result,
    ok,
    err,
)
from pi_mono.agent.harness.compaction.utils import (
    FileOperations,
    compute_file_lists,
    create_file_ops,
    extract_file_ops_from_message,
    format_file_operations,
    safe_json_stringify,
    serialize_conversation,
)

T = TypeVar("T")

TURN_PREFIX_SUMMARIZATION_PROMPT = """This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix."""


SUMMARIZATION_SYSTEM_PROMPT = """You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary."""


SUMMARIZATION_PROMPT = """The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages."""


UPDATE_SUMMARIZATION_PROMPT = """The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages."""


DEFAULT_COMPACTION_SETTINGS = {
    "enabled": True,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
}

COMPACTION_DETAILS = "CompactionDetails"
ESTIMATED_IMAGE_CHARS = 4800


def calculate_context_tokens(usage: Usage) -> int:
    return usage.get("totalTokens") or (
        usage.get("input", 0)
        + usage.get("output", 0)
        + usage.get("cacheRead", 0)
        + usage.get("cacheWrite", 0)
    )


def get_assistant_usage(msg: AgentMessage) -> dict[str, int] | None:
    if msg.get("role") == "assistant" and "usage" in msg:
        assistant_msg = msg
        usage = assistant_msg.get("usage")
        if (
            assistant_msg.get("stopReason") not in ("aborted", "error")
            and usage
            and calculate_context_tokens(usage) > 0
        ):
            return usage
    return None


def _get_entry_field(entry: Any, field_name: str) -> Any:
    if isinstance(entry, dict):
        return entry.get(field_name)
    attr_map = {
        "parentId": "parent_id",
        "parent_id": "parent_id",
        "firstKeptEntryId": "first_kept_entry_id",
        "first_kept_entry_id": "first_kept_entry_id",
        "customType": "custom_type",
        "custom_type": "custom_type",
        "fromId": "from_id",
        "from_id": "from_id",
        "tokensBefore": "tokens_before",
        "tokens_before": "tokens_before",
        "fromHook": "from_hook",
        "from_hook": "from_hook",
        "thinkingLevel": "thinking_level",
        "thinking_level": "thinking_level",
        "activeToolNames": "active_tool_names",
        "active_tool_names": "active_tool_names",
        "modelId": "model_id",
        "model_id": "model_id",
    }
    attr_name = attr_map.get(field_name, field_name)
    return getattr(entry, attr_name, None)


def get_last_assistant_usage(entries: list[Any]) -> dict[str, int] | None:
    for i in range(len(entries) - 1, -1, -1):
        entry = entries[i]
        if _get_entry_field(entry, "type") == "message":
            usage = get_assistant_usage(_get_entry_field(entry, "message"))
            if usage:
                return usage
    return None


class ContextUsageEstimate:
    def __init__(
        self,
        tokens: int,
        usage_tokens: int,
        trailing_tokens: int,
        last_usage_index: int | None,
    ):
        self.tokens = tokens
        self.usage_tokens = usage_tokens
        self.trailing_tokens = trailing_tokens
        self.last_usage_index = last_usage_index


def get_last_assistant_usage_info(messages: list[AgentMessage]) -> dict[str, Any] | None:
    latest_prefix_timestamp = float("-inf")
    usage_info: dict[str, Any] | None = None

    for i, message in enumerate(messages):
        if message.get("role") == "assistant":
            # A newer prefix message was inserted after this response (for example, a
            # compaction summary), so its usage cannot describe the current prefix.
            timestamp = message.get("timestamp")
            usage_applies_to_prefix = (
                timestamp is not None and timestamp >= latest_prefix_timestamp
            )
            usage = get_assistant_usage(message)
            if usage_applies_to_prefix and usage:
                usage_info = {"usage": usage, "index": i}
        msg_timestamp = message.get("timestamp")
        if msg_timestamp is not None:
            latest_prefix_timestamp = max(latest_prefix_timestamp, msg_timestamp)

    return usage_info


def estimate_text_and_image_content_chars(content: str | list[dict]) -> int:
    if isinstance(content, str):
        return len(content)

    chars = 0
    for block in content:
        if block.get("type") == "text" and block.get("text"):
            chars += len(block["text"])
        elif block.get("type") == "image":
            chars += ESTIMATED_IMAGE_CHARS
    return chars


def estimate_messages_tokens(messages: list[AgentMessage]) -> int:
    return sum(estimate_tokens(message) for message in messages)


def estimate_tokens(message: AgentMessage) -> int:
    chars = 0
    role = message.get("role", "")

    if role == "user":
        content = message.get("content")
        chars = estimate_text_and_image_content_chars(content)
        return (chars + 3) // 4

    elif role == "assistant":
        content = message.get("content", [])
        for block in content:
            if block.get("type") == "text":
                chars += len(block.get("text", ""))
            elif block.get("type") == "thinking":
                chars += len(block.get("thinking", ""))
            elif block.get("type") == "toolCall":
                chars += len(block.get("name", "")) + len(
                    safe_json_stringify(block.get("arguments", {}))
                )
        return (chars + 3) // 4

    elif role in ("custom", "toolResult"):
        content = message.get("content")
        chars = estimate_text_and_image_content_chars(content)
        return (chars + 3) // 4

    elif role == "bashExecution":
        cmd = message.get("command", "")
        output = message.get("output", "")
        chars = len(cmd) + len(output)
        return (chars + 3) // 4

    elif role in ("branchSummary", "compactionSummary"):
        summary = message.get("summary", "")
        chars = len(summary)
        return (chars + 3) // 4

    return 0


def find_valid_cut_points(entries: list[Any], start_index: int, end_index: int) -> list[int]:
    cut_points: list[int] = []
    for i in range(start_index, end_index):
        entry = entries[i]
        entry_type = _get_entry_field(entry, "type")
        if entry_type == "message":
            msg = _get_entry_field(entry, "message") or {}
            role = msg.get("role", "")
            if role in (
                "bashExecution",
                "custom",
                "branchSummary",
                "compactionSummary",
                "user",
                "assistant",
            ):
                cut_points.append(i)
        elif entry_type in (
            "thinking_level_change",
            "model_change",
            "active_tools_change",
            "compaction",
            "branch_summary",
            "custom",
            "custom_message",
            "label",
            "session_info",
            "leaf",
        ):
            pass
        elif entry_type in ("branch_summary", "custom_message"):
            cut_points.append(i)
    return cut_points


def find_turn_start_index(entries: list[Any], entry_index: int, start_index: int) -> int:
    for i in range(entry_index, start_index - 1, -1):
        entry = entries[i]
        entry_type = _get_entry_field(entry, "type")
        if entry_type in ("branch_summary", "custom_message"):
            return i
        if entry_type == "message":
            msg = _get_entry_field(entry, "message") or {}
            role = msg.get("role", "")
            if role in ("user", "bashExecution"):
                return i
    return -1


class CutPointResult:
    def __init__(
        self,
        first_kept_entry_index: int,
        turn_start_index: int,
        is_split_turn: bool,
    ):
        self.first_kept_entry_index = first_kept_entry_index
        self.turn_start_index = turn_start_index
        self.is_split_turn = is_split_turn


def find_cut_point(
    entries: list[Any],
    start_index: int,
    end_index: int,
    keep_recent_tokens: int,
) -> CutPointResult:
    cut_points = find_valid_cut_points(entries, start_index, end_index)

    if not cut_points:
        return CutPointResult(start_index, -1, False)

    accumulated_tokens = 0
    cut_index = cut_points[0]

    for i in range(end_index - 1, start_index - 1, -1):
        entry = entries[i]
        if _get_entry_field(entry, "type") != "message":
            continue
        message_tokens = estimate_tokens(_get_entry_field(entry, "message"))
        accumulated_tokens += message_tokens
        if accumulated_tokens >= keep_recent_tokens:
            for c in range(len(cut_points)):
                if cut_points[c] >= i:
                    cut_index = cut_points[c]
                    break
            break

    while cut_index > start_index:
        prev_entry = entries[cut_index - 1]
        prev_type = _get_entry_field(prev_entry, "type")
        if prev_type == "compaction":
            break
        if prev_type == "message":
            break
        cut_index -= 1

    cut_entry = entries[cut_index]
    cut_type = _get_entry_field(cut_entry, "type")
    cut_msg = _get_entry_field(cut_entry, "message") if cut_type == "message" else None
    is_user_message = cut_type == "message" and cut_msg and cut_msg.get("role") == "user"
    turn_start_index = (
        -1 if is_user_message else find_turn_start_index(entries, cut_index, start_index)
    )

    return CutPointResult(
        cut_index, turn_start_index, not is_user_message and turn_start_index != -1
    )


async def generate_summary(
    current_messages: list[AgentMessage],
    model: Model[str],
    reserve_tokens: int,
    api_key: str,
    headers: dict[str, str] | None = None,
    signal: Any | None = None,
    custom_instructions: str | None = None,
    previous_summary: str | None = None,
    thinking_level: ThinkingLevel | None = None,
) -> Result[str, Exception]:
    max_tokens = min(
        int(0.8 * reserve_tokens),
        model.get("maxTokens", float("inf")),
    )

    base_prompt = UPDATE_SUMMARIZATION_PROMPT if previous_summary else SUMMARIZATION_PROMPT
    if custom_instructions:
        base_prompt = f"{base_prompt}\n\nAdditional focus: {custom_instructions}"

    llm_messages = convert_to_llm(current_messages)
    conversation_text = serialize_conversation(llm_messages)

    prompt_text = f"<conversation>\n{conversation_text}\n</conversation>\n\n"
    if previous_summary:
        prompt_text += f"<previous-summary>\n{previous_summary}\n</previous-summary>\n\n"
    prompt_text += base_prompt

    summarization_messages = [
        {
            "role": "user",
            "content": [{"type": "text", "text": prompt_text}],
            "timestamp": 0,
        }
    ]

    completion_options = {
        "maxTokens": max_tokens,
        "signal": signal,
        "apiKey": api_key,
        "headers": headers,
    }
    if model.get("reasoning") and thinking_level and thinking_level != "off":
        completion_options["reasoning"] = thinking_level

    try:
        response = await complete_simple(
            model,
            {"systemPrompt": SUMMARIZATION_SYSTEM_PROMPT, "messages": summarization_messages},
            completion_options,
        )
    except Exception as e:
        return err(Exception(f"Summarization failed: {e}"))

    if response.get("stopReason") == "aborted":
        return err(Exception("Summarization aborted"))

    if response.get("stopReason") == "error":
        return err(
            Exception(f"Summarization failed: {response.get('errorMessage', 'Unknown error')}")
        )

    text_content = "\n".join(
        c["text"] for c in response.get("content", []) if c.get("type") == "text"
    )

    return ok(text_content)


def get_message_from_entry(entry: Any) -> dict | None:
    entry_type = _get_entry_field(entry, "type")
    if entry_type == "message":
        return _get_entry_field(entry, "message")
    if entry_type == "custom_message":
        return create_custom_message(
            _get_entry_field(entry, "customType"),
            _get_entry_field(entry, "content"),
            _get_entry_field(entry, "display"),
            _get_entry_field(entry, "details"),
            _get_entry_field(entry, "timestamp"),
        )
    if entry_type == "branch_summary":
        return create_branch_summary_message(
            _get_entry_field(entry, "summary"),
            _get_entry_field(entry, "fromId"),
            _get_entry_field(entry, "timestamp"),
        )
    if entry_type == "compaction":
        return create_compaction_summary_message(
            _get_entry_field(entry, "summary"),
            _get_entry_field(entry, "tokensBefore"),
            _get_entry_field(entry, "timestamp"),
        )
    return None


def get_message_from_entry_for_compaction(entry: Any) -> dict | None:
    if _get_entry_field(entry, "type") == "compaction":
        return None
    return get_message_from_entry(entry)


def extract_file_operations(
    messages: list[AgentMessage],
    entries: list[Any],
    prev_compaction_index: int,
) -> FileOperations:
    file_ops = create_file_ops()
    if prev_compaction_index >= 0:
        prev_compaction = entries[prev_compaction_index]
        prev_from_hook = _get_entry_field(prev_compaction, "fromHook")
        prev_details = _get_entry_field(prev_compaction, "details")
        if not prev_from_hook and prev_details:
            details = prev_details
            if "readFiles" in details:
                for f in details["readFiles"]:
                    file_ops.read.add(f)
            if "modifiedFiles" in details:
                for f in details["modifiedFiles"]:
                    file_ops.edited.add(f)

    for msg in messages:
        extract_file_ops_from_message(msg, file_ops)

    return file_ops


async def generate_turn_prefix_summary(
    messages: list[AgentMessage],
    model: Model[str],
    reserve_tokens: int,
    api_key: str,
    headers: dict[str, str] | None = None,
    signal: Any | None = None,
    thinking_level: str | None = None,
) -> Result[str, Exception]:
    max_tokens = min(
        int(0.5 * reserve_tokens),
        model.get("maxTokens", float("inf")),
    )
    llm_messages = convert_to_llm(messages)
    conversation_text = serialize_conversation(llm_messages)
    prompt_text = f"<conversation>\n{conversation_text}\n</conversation>\n\n{TURN_PREFIX_SUMMARIZATION_PROMPT}"

    summarization_messages = [
        {
            "role": "user",
            "content": [{"type": "text", "text": prompt_text}],
            "timestamp": 0,
        }
    ]

    completion_options = {
        "maxTokens": max_tokens,
        "signal": signal,
        "apiKey": api_key,
        "headers": headers,
    }
    if model.get("reasoning") and thinking_level and thinking_level != "off":
        completion_options["reasoning"] = thinking_level

    try:
        response = await complete_simple(
            model,
            {"systemPrompt": SUMMARIZATION_SYSTEM_PROMPT, "messages": summarization_messages},
            completion_options,
        )
    except Exception as e:
        return err(Exception(f"Turn prefix summarization failed: {e}"))

    if response.get("stopReason") == "aborted":
        return err(Exception("Turn prefix summarization aborted"))

    if response.get("stopReason") == "error":
        return err(
            Exception(
                f"Turn prefix summarization failed: {response.get('errorMessage', 'Unknown error')}"
            )
        )

    text_content = "\n".join(
        c["text"] for c in response.get("content", []) if c.get("type") == "text"
    )

    return ok(text_content)


def prepare_compaction(
    path_entries: list[Any],
    settings: dict,
) -> Result[dict | None, Exception]:
    if not path_entries or _get_entry_field(path_entries[-1], "type") == "compaction":
        return ok(None)

    prev_compaction_index = -1
    for i in range(len(path_entries) - 1, -1, -1):
        if _get_entry_field(path_entries[i], "type") == "compaction":
            prev_compaction_index = i
            break

    previous_summary = None
    boundary_start = 0
    if prev_compaction_index >= 0:
        prev_compaction = path_entries[prev_compaction_index]
        previous_summary = _get_entry_field(prev_compaction, "summary")
        first_kept_entry_index = next(
            (
                i
                for i, e in enumerate(path_entries)
                if _get_entry_field(e, "id")
                == _get_entry_field(prev_compaction, "firstKeptEntryId")
            ),
            -1,
        )
        boundary_start = (
            first_kept_entry_index if first_kept_entry_index >= 0 else prev_compaction_index + 1
        )

    boundary_end = len(path_entries)
    if path_entries and isinstance(path_entries[0], dict):
        from pi_mono.core.session_manager import (
            build_session_context as build_branch_session_context,
        )

        branch_context = build_branch_session_context(path_entries)
        tokens_before = estimate_context_tokens(branch_context["messages"]).tokens
    else:
        tokens_before = estimate_context_tokens(build_session_context(path_entries).messages).tokens

    cut_point = find_cut_point(
        path_entries, boundary_start, boundary_end, settings["keepRecentTokens"]
    )
    first_kept_entry = path_entries[cut_point.first_kept_entry_index]
    first_kept_entry_id = _get_entry_field(first_kept_entry, "id")
    if not first_kept_entry_id:
        return err(Exception("First kept entry has no UUID - session may need migration"))

    history_end = (
        cut_point.turn_start_index if cut_point.is_split_turn else cut_point.first_kept_entry_index
    )

    messages_to_summarize: list[Any] = []
    for i in range(boundary_start, history_end):
        msg = get_message_from_entry_for_compaction(path_entries[i])
        if msg:
            messages_to_summarize.append(msg)

    turn_prefix_messages: list[Any] = []
    if cut_point.is_split_turn:
        for i in range(cut_point.turn_start_index, cut_point.first_kept_entry_index):
            msg = get_message_from_entry_for_compaction(path_entries[i])
            if msg:
                turn_prefix_messages.append(msg)

    if not messages_to_summarize and not turn_prefix_messages:
        return ok(None)

    file_ops = extract_file_operations(messages_to_summarize, path_entries, prev_compaction_index)
    if cut_point.is_split_turn:
        for msg in turn_prefix_messages:
            extract_file_ops_from_message(msg, file_ops)

    return ok(
        {
            "firstKeptEntryId": first_kept_entry_id,
            "messagesToSummarize": messages_to_summarize,
            "turnPrefixMessages": turn_prefix_messages,
            "isSplitTurn": cut_point.is_split_turn,
            "tokensBefore": tokens_before,
            "previousSummary": previous_summary,
            "fileOps": file_ops,
            "settings": settings,
        }
    )


prepareCompaction = prepare_compaction


async def compact(
    preparation: dict,
    model: Model[str],
    api_key: str,
    headers: dict[str, str] | None = None,
    custom_instructions: str | None = None,
    signal: Any | None = None,
    thinking_level: str | None = None,
) -> Result[dict, Exception]:
    (
        first_kept_entry_id,
        messages_to_summarize,
        turn_prefix_messages,
        is_split_turn,
        tokens_before,
        previous_summary,
        file_ops,
        settings,
    ) = (
        preparation["firstKeptEntryId"],
        preparation["messagesToSummarize"],
        preparation["turnPrefixMessages"],
        preparation["isSplitTurn"],
        preparation["tokensBefore"],
        preparation.get("previousSummary"),
        preparation["fileOps"],
        preparation["settings"],
    )

    if not first_kept_entry_id:
        return err(Exception("First kept entry has no UUID - session may need migration"))

    if is_split_turn and turn_prefix_messages:
        history_result, turn_prefix_result = await asyncio.gather(
            (
                generate_summary(
                    messages_to_summarize,
                    model,
                    settings["reserveTokens"],
                    api_key,
                    headers,
                    signal,
                    custom_instructions,
                    previous_summary,
                )
                if messages_to_summarize
                else asyncio.sleep(0, result=ok("No prior history."))
            ),
            generate_turn_prefix_summary(
                turn_prefix_messages,
                model,
                settings["reserveTokens"],
                api_key,
                headers,
                signal,
            ),
        )
        if not history_result.ok:
            return err(history_result.error)
        if not turn_prefix_result.ok:
            return err(turn_prefix_result.error)
        summary = f"{history_result.value}\n\n---\n\n**Turn Context (split turn):**\n\n{turn_prefix_result.value}"
    else:
        summary_result = await generate_summary(
            messages_to_summarize,
            model,
            settings["reserveTokens"],
            api_key,
            headers,
            signal,
            custom_instructions,
            previous_summary,
        )
        if not summary_result.ok:
            return err(summary_result.error)
        summary = summary_result.value

    read_files, modified_files = compute_file_lists(file_ops)
    summary += format_file_operations(read_files, modified_files)

    return ok(
        {
            "summary": summary,
            "firstKeptEntryId": first_kept_entry_id,
            "tokensBefore": tokens_before,
            "details": {"readFiles": read_files, "modifiedFiles": modified_files},
        }
    )


def estimate_context_tokens(messages: list[AgentMessage]) -> ContextUsageEstimate:
    usage_info = get_last_assistant_usage_info(messages)

    if not usage_info:
        estimated = sum(estimate_tokens(m) for m in messages)
        return ContextUsageEstimate(estimated, 0, estimated, None)

    usage_tokens = calculate_context_tokens(usage_info["usage"])
    trailing_tokens = sum(
        estimate_tokens(messages[i]) for i in range(usage_info["index"] + 1, len(messages))
    )

    return ContextUsageEstimate(
        usage_tokens + trailing_tokens,
        usage_tokens,
        trailing_tokens,
        usage_info["index"],
    )


def should_compact(context_tokens: int, context_window: int, settings: dict) -> bool:
    if not settings.get("enabled", False):
        return False
    return context_tokens > context_window - settings.get("reserveTokens", 0)
