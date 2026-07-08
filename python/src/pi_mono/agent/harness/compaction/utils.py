"""Compaction utilities for session history summarization."""

from typing import Any

from pi_mono.agent.types import AgentMessage


NL = "\n"


class FileOperations:
    """File paths touched by a session branch or compaction range."""

    def __init__(self):
        self.read: set[str] = set()
        self.written: set[str] = set()
        self.edited: set[str] = set()


def create_file_ops() -> FileOperations:
    """Create an empty file-operation accumulator."""
    return FileOperations()


def extract_file_ops_from_message(message: AgentMessage, file_ops: FileOperations) -> None:
    """Add file operations from assistant tool calls to an accumulator."""
    if message.get("role") != "assistant":
        return
    content = message.get("content")
    if not isinstance(content, list):
        return

    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "toolCall":
            continue

        args = block.get("arguments")
        if not isinstance(args, dict):
            continue

        path = args.get("path")
        if not isinstance(path, str):
            continue

        tool_name = block.get("name")
        if tool_name == "read":
            file_ops.read.add(path)
        elif tool_name == "write":
            file_ops.written.add(path)
        elif tool_name == "edit":
            file_ops.edited.add(path)


def compute_file_lists(file_ops: FileOperations) -> tuple[list[str], list[str]]:
    """Compute sorted read-only and modified file lists from accumulated operations."""
    modified = set(file_ops.edited) | set(file_ops.written)
    read_only = sorted(f for f in file_ops.read if f not in modified)
    modified_files = sorted(modified)
    return read_only, modified_files


def format_file_operations(read_files: list[str], modified_files: list[str]) -> str:
    """Format file lists as summary metadata tags."""
    sections: list[str] = []
    if read_files:
        read_section = f"<read-files>{NL}{NL.join(read_files)}{NL}</read-files>"
        sections.append(read_section)
    if modified_files:
        modified_section = f"<modified-files>{NL}{NL.join(modified_files)}{NL}</modified-files>"
        sections.append(modified_section)
    if not sections:
        return ""
    return f"{NL}{NL}{NL}{NL.join(sections)}"


TOOL_RESULT_MAX_CHARS = 2000


def safe_json_stringify(value: Any) -> str:
    try:
        import json

        return json.dumps(value) or "undefined"
    except Exception:
        return "[unserializable]"


def truncate_for_summary(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    truncated_chars = len(text) - max_chars
    return f"{text[:max_chars]}{NL}{NL}[... {truncated_chars} more characters truncated]"


def serialize_conversation(messages: list[dict]) -> str:
    """Serialize LLM messages to plain text for summarization prompts."""
    parts: list[str] = []

    for msg in messages:
        role = msg.get("role")
        if role == "user":
            content = msg.get("content")
            if isinstance(content, str):
                text = content
            else:
                text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
            if text:
                parts.append(f"[User]: {text}")
        elif role == "assistant":
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            tool_calls: list[str] = []

            for block in msg.get("content", []):
                if block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif block.get("type") == "thinking":
                    thinking_parts.append(block.get("thinking", ""))
                elif block.get("type") == "toolCall":
                    args = block.get("arguments", {})
                    args_str = ", ".join(f"{k}={safe_json_stringify(v)}" for k, v in args.items())
                    tool_calls.append(f"{block.get('name', '')}({args_str})")

            if thinking_parts:
                parts.append(f"[Assistant thinking]: {NL.join(thinking_parts)}")
            if text_parts:
                parts.append(f"[Assistant]: {NL.join(text_parts)}")
            if tool_calls:
                parts.append(f"[Assistant tool calls]: {'; '.join(tool_calls)}")
        elif role == "toolResult":
            content = "".join(
                c.get("text", "") for c in msg.get("content", []) if c.get("type") == "text"
            )
            if content:
                parts.append(
                    f"[Tool result]: {truncate_for_summary(content, TOOL_RESULT_MAX_CHARS)}"
                )

    return f"{NL}{NL}".join(parts)


TOOL_RESULT_MAX_CHARS = 2000
