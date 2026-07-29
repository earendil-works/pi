# 033: Event Bus for Extension Communication

**Date:** 2026-01-30
**Source:** Commit `9c9e6822`

## Context

The unified extensions system (ADR-026) merged hooks and custom tools into a single API. But extensions still had no way to communicate with each other. A plan-mode hook couldn't signal a logging hook that a task was complete. Two extensions that both needed to react to the same event (e.g., session switch) each had to register their own lifecycle listeners. There was no pub/sub mechanism for extension-to-extension messages.

## Decision

Add an event bus to the AgentSession core where extensions publish events via `pi.emit('event-name', payload)` and subscribe via `pi.on('event-name', handler)`. The bus is typed. Each event name maps to a specific payload type. Async errors in handlers are caught automatically and logged without crashing the agent. The bus persists across session switches but pending messages are cleared.

## Consequences

- Extensions can communicate without direct coupling. A plan-mode hook emits `todo:completed`; any other hook can listen for it.
- The bus replaces ad-hoc patterns where extensions polled state or relied on timing.
- Typed events prevent payload mismatches. The compiler catches wrong payload shapes.
- Async error handling means a buggy handler doesn't crash the agent. The error is logged and the bus continues.
- Handlers persist across the agent's lifetime. Extensions register once and receive events until shutdown.

## Confidence

High. Commit body and event bus types document the design.
