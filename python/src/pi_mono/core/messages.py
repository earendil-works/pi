import time
from typing import Any, Optional, Union, cast
from pi_mono.ai.types import Message, TextContent, ImageContent

COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
COMPACTION_SUMMARY_SUFFIX = "\n</summary>"

BRANCH_SUMMARY_PREFIX = (
    "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n"
)
BRANCH_SUMMARY_SUFFIX = "</summary>"


def bash_execution_to_text(msg: dict[str, Any]) -> str:
    text = f"Ran `{msg.get('command')}`\n"
    output = msg.get("output")
    if output:
        text += f"```\n{output}\n```"
    else:
        text += "(no output)"

    if msg.get("cancelled"):
        text += "\n\n(command cancelled)"
    elif msg.get("exitCode") is not None and msg.get("exitCode") != 0:
        text += f"\n\nCommand exited with code {msg['exitCode']}"

    if msg.get("truncated") and msg.get("fullOutputPath"):
        text += f"\n\n[Output truncated. Full output: {msg['fullOutputPath']}]"

    return text


def create_branch_summary_message(summary: str, from_id: str, timestamp: str) -> dict[str, Any]:
    try:
        from datetime import datetime

        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        ts = int(dt.timestamp() * 1000)
    except Exception:
        ts = int(time.time() * 1000)

    return {
        "role": "branchSummary",
        "summary": summary,
        "fromId": from_id,
        "timestamp": ts,
    }


def create_compaction_summary_message(
    summary: str, tokens_before: int, timestamp: str
) -> dict[str, Any]:
    try:
        from datetime import datetime

        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        ts = int(dt.timestamp() * 1000)
    except Exception:
        ts = int(time.time() * 1000)

    return {
        "role": "compactionSummary",
        "summary": summary,
        "tokensBefore": tokens_before,
        "timestamp": ts,
    }


def create_custom_message(
    custom_type: str,
    content: Union[str, list[Union[TextContent, ImageContent]]],
    display: bool,
    details: Optional[Any],
    timestamp: str,
) -> dict[str, Any]:
    try:
        from datetime import datetime

        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        ts = int(dt.timestamp() * 1000)
    except Exception:
        ts = int(time.time() * 1000)

    return {
        "role": "custom",
        "customType": custom_type,
        "content": content,
        "display": display,
        "details": details,
        "timestamp": ts,
    }


def convert_to_llm(messages: list[dict[str, Any]]) -> list[Message]:
    result: list[Message] = []
    for m in messages:
        role = m.get("role")
        if role == "bashExecution":
            if m.get("excludeFromContext"):
                continue
            result.append(
                cast(
                    Message,
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": bash_execution_to_text(m)}],
                        "timestamp": m.get("timestamp"),
                    },
                )
            )
        elif role == "custom":
            content_val = m.get("content")
            if isinstance(content_val, str):
                content_list: Any = [{"type": "text", "text": content_val}]
            else:
                content_list = content_val
            result.append(
                cast(
                    Message,
                    {
                        "role": "user",
                        "content": content_list,
                        "timestamp": m.get("timestamp"),
                    },
                )
            )
        elif role == "branchSummary":
            result.append(
                cast(
                    Message,
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": f"{BRANCH_SUMMARY_PREFIX}{m.get('summary')}{BRANCH_SUMMARY_SUFFIX}",
                            }
                        ],
                        "timestamp": m.get("timestamp"),
                    },
                )
            )
        elif role == "compactionSummary":
            result.append(
                cast(
                    Message,
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": f"{COMPACTION_SUMMARY_PREFIX}{m.get('summary')}{COMPACTION_SUMMARY_SUFFIX}",
                            }
                        ],
                        "timestamp": m.get("timestamp"),
                    },
                )
            )
        elif role in ("user", "assistant", "toolResult"):
            result.append(cast(Message, m))
    return result
