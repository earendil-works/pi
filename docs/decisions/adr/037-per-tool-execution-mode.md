# 037: Per-Tool Execution Mode Override

**Date:** 2026-03-01
**Source:** Commit `bfa11a50`

## Context

Tools ran in parallel by default. The agent could fire multiple tool calls simultaneously, which worked for independent operations (read two files, search in two directories). But some tools depend on each other: a write tool must finish before a read tool that checks the result. The agent had no way to express "run this tool after that tool finishes." The only workaround was making a single tool call and waiting for the next turn. Doesn't scale.

## Decision

Add an `executionMode` field to tool definitions with two values: `parallel` (default, existing behavior) and `sequential` (tools run one at a time in declaration order). Tools marked as `sequential` execute in order, and the next tool only starts after the previous one completes. Sequential tools can be mixed with parallel tools. The mode applies per tool, not globally.

## Consequences

- Dependent tools can express their ordering requirement directly instead of relying on the agent to issue them in separate turns.
- Mixing parallel and sequential modes gives flexibility: run independent tools in parallel, then dependent tools in sequence.
- Sequential execution increases total time for dependent tool chains compared to parallel, but eliminates the round-trip of separate agent turns.
- Tool authors must decide the mode at definition time. Incorrect mode choice (parallel when sequential is needed) causes intermittent bugs.

## Confidence

High. Commit body and the tool execution tests document the mode design.
