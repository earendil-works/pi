# 027: Steer and FollowUp API Split

**Date:** 2026-01-16
**Source:** Commit `d0a4c370` | Commit `93498737`

## Context

The agent's AgentSession API (ADR-016) had a single `queueMessage()` method for sending messages while the agent was running. It had one behavior: queue the message, deliver it when the current turn finishes. But callers needed two distinct behaviors: interrupt mid-run with a steering message (deliver after the current tool, not after the full turn) or let the agent finish and then deliver a follow-up. The single queue method couldn't express the difference, leading to confusion about delivery timing.

## Decision

Split `queueMessage()` into two methods: `steer(msg)` interrupts mid-run, delivering the message after the current tool execution completes. `followUp(msg)` waits until the agent finishes its entire turn before delivery. Rename `queueMode` to `steeringMode`/`followUpMode` and `getQueuedMessages` to `getSteeringMessages`/`getFollowUpMessages`.

## Consequences

- `steer()` enables responsive mid-turn corrections. Users can redirect the agent without waiting for the full turn to finish.
- `followUp()` preserves the old `queueMessage()` behavior for non-urgent additions.
- The API split is breaking: any code using `queueMessage()` must switch to one of the two methods.
- The two-method API is clearer than a single `queueMessage({ deliverAfter: 'tool' | 'turn' })` option — the intent is encoded in the method name.

## Confidence

High. Commit body documents the motivation and the agent tests cover both delivery modes.
