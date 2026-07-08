from pi_mono.ai.providers.github_copilot_headers import (
    infer_copilot_initiator,
    has_copilot_vision_input,
    build_copilot_dynamic_headers,
)


def test_infer_copilot_initiator():
    assert infer_copilot_initiator([]) == "user"
    assert infer_copilot_initiator([{"role": "user", "content": "hello"}]) == "user"
    assert infer_copilot_initiator([{"role": "assistant", "content": "hi"}]) == "agent"
    assert infer_copilot_initiator([{"role": "toolResult", "content": []}]) == "agent"


def test_has_copilot_vision_input():
    assert has_copilot_vision_input([]) is False
    assert (
        has_copilot_vision_input([{"role": "user", "content": [{"type": "text", "text": "hello"}]}])
        is False
    )
    assert (
        has_copilot_vision_input(
            [{"role": "user", "content": [{"type": "image", "mimeType": "image/png"}]}]
        )
        is True
    )
    assert (
        has_copilot_vision_input(
            [{"role": "toolResult", "content": [{"type": "image", "mimeType": "image/png"}]}]
        )
        is True
    )


def test_build_copilot_dynamic_headers():
    messages = [{"role": "user", "content": "hello"}]
    headers = build_copilot_dynamic_headers({"messages": messages, "hasImages": False})
    assert headers == {"X-Initiator": "user", "Openai-Intent": "conversation-edits"}

    headers_with_images = build_copilot_dynamic_headers({"messages": messages, "hasImages": True})
    assert headers_with_images == {
        "X-Initiator": "user",
        "Openai-Intent": "conversation-edits",
        "Copilot-Vision-Request": "true",
    }
