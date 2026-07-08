"""Message formatting utilities for agent harness."""

from typing import Any
import time
from datetime import datetime

from pi_mono.agent import AgentMessage
from pi_mono.ai.types import ImageContent, TextContent

COMPACTION_SUMMARY_PREFIX = """The conversation history before this point was compacted into the following summary:

<summary>
"""

COMPACTION_SUMMARY_SUFFIX = """
</summary>
"""

BRANCH_SUMMARY_PREFIX = """The following is a summary of a branch that this conversation came back from:

<summary>
"""

BRANCH_SUMMARY_SUFFIX = """</summary>"""


def parse_iso_timestamp(timestamp_str: str) -> int:
    try:
        t = timestamp_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(t)
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


def create_user_message(text: str, images: list[ImageContent] | None = None) -> AgentMessage:
    """Create a user message with optional images."""
    content: list[TextContent | ImageContent] = [{"type": "text", "text": text}]
    if images:
        content.extend(images)
    return {
        "role": "user",
        "content": content,
        "timestamp": int(time.time() * 1000),
    }


class BashExecutionMessage:
    role: str = "bashExecution"
    command: str
    output: str
    exit_code: int | None = None
    cancelled: bool
    truncated: bool
    full_output_path: str | None = None
    timestamp: int
    exclude_from_context: bool = False

    def __init__(
        self,
        command: str,
        output: str,
        exit_code: int | None,
        cancelled: bool,
        truncated: bool,
        full_output_path: str | None = None,
        timestamp: int | None = None,
        exclude_from_context: bool = False,
    ):
        self.command = command
        self.output = output
        self.exit_code = exit_code
        self.cancelled = cancelled
        self.truncated = truncated
        self.full_output_path = full_output_path
        self.timestamp = timestamp or 0
        self.exclude_from_context = exclude_from_context


class CustomMessage:
    role: str = "custom"
    custom_type: str
    content: str | list[TextContent | ImageContent]
    display: bool
    details: Any | None = None
    timestamp: int

    def __init__(
        self,
        custom_type: str,
        content: str | list[TextContent | ImageContent],
        display: bool,
        details: Any | None = None,
        timestamp: int | None = None,
    ):
        self.custom_type = custom_type
        self.content = content
        self.display = display
        self.details = details
        self.timestamp = timestamp or 0


class BranchSummaryMessage:
    role: str = "branchSummary"
    summary: str
    from_id: str
    timestamp: int

    def __init__(self, summary: str, from_id: str, timestamp: str):
        self.summary = summary
        self.from_id = from_id
        self.timestamp = parse_iso_timestamp(timestamp)


class CompactionSummaryMessage:
    role: str = "compactionSummary"
    summary: str
    tokens_before: int
    timestamp: int

    def __init__(self, summary: str, tokens_before: int, timestamp: str):
        self.summary = summary
        self.tokens_before = tokens_before
        self.timestamp = parse_iso_timestamp(timestamp)


def bash_execution_to_text(msg: Any) -> str:
    """Convert bash execution message to text representation."""
    command = getattr(msg, "command", msg.get("command") if isinstance(msg, dict) else "")
    output = getattr(msg, "output", msg.get("output") if isinstance(msg, dict) else "")
    cancelled = getattr(msg, "cancelled", msg.get("cancelled") if isinstance(msg, dict) else False)
    exit_code = getattr(
        msg,
        "exit_code",
        (
            getattr(msg, "exitCode", msg.get("exitCode", msg.get("exit_code")))
            if isinstance(msg, dict)
            else None
        ),
    )
    truncated = getattr(msg, "truncated", msg.get("truncated") if isinstance(msg, dict) else False)
    full_output_path = getattr(
        msg,
        "full_output_path",
        (
            getattr(msg, "fullOutputPath", msg.get("fullOutputPath", msg.get("full_output_path")))
            if isinstance(msg, dict)
            else None
        ),
    )

    text = f"Ran `{command}`\n"
    if output:
        text += f"```\n{output}\n```"
    else:
        text += "(no output)"
    if cancelled:
        text += "\n\n(command cancelled)"
    elif exit_code is not None and exit_code != 0:
        text += f"\n\nCommand exited with code {exit_code}"
    if truncated and full_output_path:
        text += f"\n\n[Output truncated. Full output: {full_output_path}]"
    return text


def create_branch_summary_message(summary: str, from_id: str, timestamp: str) -> dict:
    """Create a branch summary message."""
    return {
        "role": "branchSummary",
        "summary": summary,
        "fromId": from_id,
        "timestamp": parse_iso_timestamp(timestamp),
    }


def create_compaction_summary_message(summary: str, tokens_before: int, timestamp: str) -> dict:
    """Create a compaction summary message."""
    return {
        "role": "compactionSummary",
        "summary": summary,
        "tokensBefore": tokens_before,
        "timestamp": parse_iso_timestamp(timestamp),
    }


def create_custom_message(
    custom_type: str,
    content: str | list[dict],
    display: bool,
    details: Any | None,
    timestamp: str,
) -> dict:
    """Create a custom message."""
    return {
        "role": "custom",
        "customType": custom_type,
        "content": content,
        "display": display,
        "details": details,
        "timestamp": parse_iso_timestamp(timestamp),
    }


def create_failure_message(model: Any, error: Exception, aborted: bool) -> dict:
    """Create a failure message for when an agent run fails."""
    from pi_mono.agent.harness.types import AgentHarnessError

    if isinstance(error, AgentHarnessError):
        message_text = error.message
    elif isinstance(error, Exception) and error.args and isinstance(error.args[0], str):
        message_text = error.args[0]
    else:
        message_text = str(error)

    model_dict = model if isinstance(model, dict) else {}
    model_api = getattr(model, "api", model_dict.get("api", "unknown"))
    model_provider = getattr(model, "provider", model_dict.get("provider", "unknown"))
    model_id = getattr(model, "id", model_dict.get("id", "unknown"))

    return {
        "role": "assistant",
        "content": [],
        "api": model_api,
        "provider": model_provider,
        "model": model_id,
        "stopReason": "aborted" if aborted else "error",
        "errorMessage": message_text,
        "timestamp": int(time.time() * 1000),
        "usage": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 0,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
    }


def convert_to_llm(messages: list[dict]) -> list[dict]:
    """Convert agent messages to LLM-compatible format."""
    result: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "bashExecution":
            if m.get("excludeFromContext"):
                continue
            result.append(
                {
                    "role": "user",
                    "content": [{"type": "text", "text": bash_execution_to_text(m)}],
                    "timestamp": m.get("timestamp", 0),
                }
            )
        elif role == "custom":
            content = m.get("content")
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            result.append(
                {
                    "role": "user",
                    "content": content,
                    "timestamp": m.get("timestamp", 0),
                }
            )
        elif role == "branchSummary":
            result.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": BRANCH_SUMMARY_PREFIX + m["summary"] + BRANCH_SUMMARY_SUFFIX,
                        }
                    ],
                    "timestamp": m.get("timestamp", 0),
                }
            )
        elif role == "compactionSummary":
            result.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": COMPACTION_SUMMARY_PREFIX
                            + m["summary"]
                            + COMPACTION_SUMMARY_SUFFIX,
                        }
                    ],
                    "timestamp": m.get("timestamp", 0),
                }
            )
        elif role in ("user", "assistant", "toolResult"):
            result.append(m)
    return result
