"""Agent loop implementation."""

from typing import Any, Callable

from pi_mono.agent import (
    AgentContext,
    AgentMessage,
    AgentEvent,
    StreamFn,
)
from pi_mono.agent.harness.types import AgentLoopConfig


async def run_agent_loop(
    prompts: list[AgentMessage],
    context: AgentContext,
    config: AgentLoopConfig,
    emit: Callable[[AgentEvent], Any],
    signal: any = None,
    stream_fn: StreamFn | None = None,
) -> list[AgentMessage]:
    """Run the agent loop (stub implementation)."""
    # This is a placeholder - full implementation would be complex
    # For now, just return the prompts
    return list(prompts)


async def run_agent_loop_continue(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: Callable[[AgentEvent], Any],
    signal: any = None,
    stream_fn: StreamFn | None = None,
) -> list[AgentMessage]:
    """Continue the agent loop (stub implementation)."""
    return []
