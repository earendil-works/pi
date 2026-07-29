# 041: AgentHarness Testing Architecture

**Date:** 2026-03-28
**Source:** Commit `a5b27367` | Commit `c0f416aa`

## Context

Testing the agent end-to-end required running the full CLI with real model calls or mocking every provider interaction. There was no in-process abstraction for running agent scenarios with controlled model responses. The `AgentSession` API (ADR-019) and the extensions system (ADR-026) were designed for production use, not for testing. Starting a session required model configuration, auth setup, and resource loading.

## Decision

Add an `AgentHarness` class that provides a controlled environment for running agent scenarios. The harness manages sessions, resources, model configuration, and stream configuration. It exposes hooks for injecting model responses, observing tool calls, and asserting on conversation state. All agent operations go through the harness, which can run with real models or deterministic mock responses.

## Consequences

- Agent scenarios can be tested in-process without CLI invocation or real API calls.
- The harness supports deterministic mock responses for regression testing and real model calls for integration testing. Doesn't need real API keys for basic scenarios.
- Harness-managed resources (skills, extensions, context files) are isolated per test, preventing cross-test contamination.
- The harness architecture drove broader AgentSession refactoring: session storage, compaction, and resource loading were tightened up as part of the harness work.

## Confidence

High. Multiple implementation commits and the harness design doc (harness.md) document the architecture.
