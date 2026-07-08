"""Cursor provider backed by the Cursor Agent CLI."""

from __future__ import annotations

from pi_mono.ai.cursor_agent import stream_cursor_cli, stream_simple_cursor_cli
from pi_mono.ai.types import Context, Model, SimpleStreamOptions, StreamOptions
from pi_mono.utils.event_stream import AssistantMessageEventStream


def stream_cursor(
    model: Model,
    context: Context,
    options: StreamOptions | None = None,
) -> AssistantMessageEventStream:
    return stream_cursor_cli(model, context, options)


def stream_simple_cursor(
    model: Model,
    context: Context,
    options: SimpleStreamOptions | None = None,
) -> AssistantMessageEventStream:
    return stream_simple_cursor_cli(model, context, options)
