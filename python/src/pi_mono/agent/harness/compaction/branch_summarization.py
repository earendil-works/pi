"""Branch summarization for agent harness."""

from __future__ import annotations

from typing import Any

from pi_mono.ai.stream import complete_simple
from pi_mono.agent.harness.messages import (
    create_branch_summary_message,
    create_compaction_summary_message,
    create_custom_message,
    convert_to_llm,
)
from pi_mono.agent.harness.session.session import Session
from pi_mono.agent.harness.compaction.utils import (
    compute_file_lists,
    create_file_ops,
    extract_file_ops_from_message,
    format_file_operations,
    serialize_conversation,
)
from pi_mono.agent.harness.compaction.compaction import estimate_tokens


NL = "\n"


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


def get_message_from_entry(entry: Any) -> dict | None:
    entry_type = _get_entry_field(entry, "type")
    if entry_type == "message":
        msg = _get_entry_field(entry, "message")
        if msg and msg.get("role") == "toolResult":
            return None
        return msg
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


def prepare_branch_entries(entries: list[Any], token_budget: int = 0) -> dict[str, Any]:
    messages: list[dict] = []
    file_ops = create_file_ops()
    total_tokens = 0

    for entry in entries:
        if (
            _get_entry_field(entry, "type") == "branch_summary"
            and not _get_entry_field(entry, "fromHook")
            and _get_entry_field(entry, "details")
        ):
            details = _get_entry_field(entry, "details")
            if isinstance(details.get("readFiles"), list):
                for f in details["readFiles"]:
                    file_ops.read.add(f)
            if isinstance(details.get("modifiedFiles"), list):
                for f in details["modifiedFiles"]:
                    file_ops.edited.add(f)

    for i in range(len(entries) - 1, -1, -1):
        entry = entries[i]
        message = get_message_from_entry(entry)
        if not message:
            continue
        extract_file_ops_from_message(message, file_ops)

        tokens = estimate_tokens(message)
        if token_budget > 0 and total_tokens + tokens > token_budget:
            entry_type = _get_entry_field(entry, "type")
            if entry_type in ("compaction", "branch_summary"):
                if total_tokens < token_budget * 0.9:
                    messages.insert(0, message)
                    total_tokens += tokens
            break

        messages.insert(0, message)
        total_tokens += tokens

    return {"messages": messages, "fileOps": file_ops, "totalTokens": total_tokens}


BRANCH_SUMMARY_PREAMBLE = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n"

BRANCH_SUMMARY_PROMPT = """Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages."""


SUMMARIZATION_SYSTEM_PROMPT = """You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary."""


async def collect_entries_for_branch_summary(
    session: Session,
    old_leaf_id: str | None,
    target_id: str,
) -> dict[str, Any]:
    if not old_leaf_id:
        return {"entries": [], "commonAncestorId": None}

    old_path_set = {e.id for e in await session.get_branch(old_leaf_id)}
    target_path = await session.get_branch(target_id)
    common_ancestor_id: str | None = None

    for i in range(len(target_path) - 1, -1, -1):
        if target_path[i].id in old_path_set:
            common_ancestor_id = target_path[i].id
            break

    entries: list[dict] = []
    current: str | None = old_leaf_id

    while current and current != common_ancestor_id:
        entry = await session.get_entry(current)
        if not entry:
            raise Exception(f"Entry {current} not found")
        entries.append(entry)
        current = entry.parent_id

    entries.reverse()
    return {"entries": entries, "commonAncestorId": common_ancestor_id}


async def generate_branch_summary(
    entries: list[dict],
    options: dict[str, Any],
) -> dict[str, Any]:
    from pi_mono.agent.harness.compaction.compaction import Result as CompactionResult

    model = options["model"]
    api_key = options["apiKey"]
    headers = options.get("headers")
    signal = options.get("signal")
    custom_instructions = options.get("customInstructions")
    replace_instructions = options.get("replaceInstructions", False)
    reserve_tokens = options.get("reserveTokens", 16384)

    context_window = model.get("contextWindow", 128000)
    token_budget = context_window - reserve_tokens

    prep = prepare_branch_entries(entries, token_budget)
    messages = prep["messages"]
    file_ops = prep["fileOps"]

    if not messages:
        return CompactionResult.ok(
            {
                "summary": "No content to summarize",
                "readFiles": [],
                "modifiedFiles": [],
            }
        )

    llm_messages = convert_to_llm(messages)
    conversation_text = serialize_conversation(llm_messages)

    if replace_instructions and custom_instructions:
        instructions = custom_instructions
    elif custom_instructions:
        instructions = f"{BRANCH_SUMMARY_PROMPT}{NL}{NL}Additional focus: {custom_instructions}"
    else:
        instructions = BRANCH_SUMMARY_PROMPT

    prompt_text = f"<conversation>{NL}{conversation_text}{NL}</conversation>{NL}{NL}{instructions}"

    summarization_messages = [
        {
            "role": "user",
            "content": [{"type": "text", "text": prompt_text}],
            "timestamp": 0,
        }
    ]

    completion_options = {
        "maxTokens": 2048,
        "apiKey": api_key,
        "headers": headers,
        "signal": signal,
    }
    try:
        response = await complete_simple(
            model,
            {"systemPrompt": SUMMARIZATION_SYSTEM_PROMPT, "messages": summarization_messages},
            completion_options,
        )
    except Exception as e:
        return CompactionResult.err(Exception(f"Branch summary failed: {e}"))

    if response.get("stopReason") == "aborted":
        return CompactionResult.err(Exception("Branch summary aborted"))

    if response.get("stopReason") == "error":
        return CompactionResult.err(
            Exception(f"Branch summary failed: {response.get('errorMessage', 'Unknown error')}")
        )

    summary = NL.join(c["text"] for c in response.get("content", []) if c.get("type") == "text")

    summary = BRANCH_SUMMARY_PREAMBLE + summary
    read_files, modified_files = compute_file_lists(file_ops)
    summary += format_file_operations(read_files, modified_files)

    return CompactionResult.ok(
        {
            "summary": summary or "No summary generated",
            "readFiles": read_files,
            "modifiedFiles": modified_files,
        }
    )


def collect_entries_for_branch_summary_sync(
    session_manager: Any,
    old_leaf_id: str | None,
    target_id: str,
) -> dict[str, Any]:
    if not old_leaf_id:
        return {"entries": [], "commonAncestorId": None}

    old_path = session_manager.get_branch(old_leaf_id)
    old_path_set = {entry["id"] for entry in old_path}
    target_path = session_manager.get_branch(target_id)
    common_ancestor_id: str | None = None

    for entry in reversed(target_path):
        if entry["id"] in old_path_set:
            common_ancestor_id = entry["id"]
            break

    entries: list[dict[str, Any]] = []
    current: str | None = old_leaf_id
    while current and current != common_ancestor_id:
        entry = session_manager.get_entry(current)
        if not entry:
            raise RuntimeError(f"Entry {current} not found")
        entries.append(entry)
        current = entry.get("parentId")

    entries.reverse()
    return {"entries": entries, "commonAncestorId": common_ancestor_id}


collectEntriesForBranchSummary = collect_entries_for_branch_summary
generateBranchSummary = generate_branch_summary
