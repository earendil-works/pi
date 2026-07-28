# 017: RPC Mode with Typed Protocol

**Date:** 2025-12-09
**Source:** Commit `3559a43b`

## Context

The original RPC mode used a loosely typed JSON protocol with ad-hoc command handling. Commands were strings, responses were untyped objects, and there wasn't any client library for programmatic access. External tools (IDEs, CI scripts, other agents) that wanted to drive the coding agent had to parse raw JSON and guess the response shape. The refactored `AgentSession` API (ADR-016) provided a clean surface to expose.

## Decision

Rewrite RPC mode with typed `RpcCommand` and `RpcResponse` types covering the full `AgentSession` API: state queries, model/thinking control, compaction, bash execution, session management. Add an `RpcClient` class that wraps the protocol with typed methods. Move RPC files to `modes/rpc/`. All commands support an optional correlation ID for request/response matching.

## Consequences

- Every RPC command has a defined request type and response type. Parsing errors become type errors instead of runtime crashes.
- `RpcClient` provides a programmatic API that external tools import. IDEs, CI scripts, and custom UIs can drive the agent without raw JSON manipulation.
- The typed protocol documents the agent's capabilities by existing. The type definitions are the reference.
- Correlation IDs enable concurrent requests without response ambiguity, which matters for hooks that may trigger multiple RPC calls.
- The rewrite broke backward compatibility with the old RPC protocol. Any existing RPC clients needed migration.

## Confidence

High. Commit body and the type definitions together document the full protocol.
