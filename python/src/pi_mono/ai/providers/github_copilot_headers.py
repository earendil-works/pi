from typing import Any, Dict, List


def infer_copilot_initiator(messages: List[Dict[str, Any]]) -> str:
    """Infer the Copilot initiator (user or agent)."""
    if not messages:
        return "user"
    last = messages[-1]
    role = last.get("role")
    return "agent" if role != "user" else "user"


def has_copilot_vision_input(messages: List[Dict[str, Any]]) -> bool:
    """Check if the messages contain vision input (images)."""
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if role in ("user", "toolResult") and isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "image":
                    return True
    return False


def build_copilot_dynamic_headers(params: Dict[str, Any]) -> Dict[str, str]:
    """Build dynamic headers for GitHub Copilot requests."""
    messages = params.get("messages", [])
    has_images = params.get("hasImages", False)

    headers = {
        "X-Initiator": infer_copilot_initiator(messages),
        "Openai-Intent": "conversation-edits",
    }

    if has_images:
        headers["Copilot-Vision-Request"] = "true"

    return headers
