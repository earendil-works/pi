"""Combine stdin, @file text, and CLI messages into an initial prompt."""

from __future__ import annotations

from dataclasses import dataclass

from pi_mono.ai.types import ImageContent
from pi_mono.coding_agent.cli.args import Args


@dataclass
class InitialMessageInput:
    parsed: Args
    file_text: str | None = None
    file_images: list[ImageContent] | None = None
    stdin_content: str | None = None


@dataclass
class InitialMessageResult:
    initial_message: str | None = None
    initial_images: list[ImageContent] | None = None


def build_initial_message(options: InitialMessageInput) -> InitialMessageResult:
    parts: list[str] = []
    if options.stdin_content is not None:
        parts.append(options.stdin_content)
    if options.file_text:
        parts.append(options.file_text)

    parsed = options.parsed
    if parsed.messages:
        parts.append(parsed.messages[0])
        parsed.messages.pop(0)

    return InitialMessageResult(
        initial_message="".join(parts) if parts else None,
        initial_images=options.file_images if options.file_images else None,
    )
