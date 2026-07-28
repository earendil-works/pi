# 010: Runtime Bridge for Sandboxed Provider Execution

**Date:** 2025-10-09
**Source:** Commit `c2793d80`

## Context

The browser extension ran tool code (JavaScript REPL, artifacts) inside sandboxed iframes. Communication between the sandbox and the extension's main world went through a message router that only handled iframe messages. As the browser extension grew more capabilities (file downloads, console logging, artifact rendering), the routing needed to also cover user script contexts and the gap between them. The existing `SandboxMessageRouter` was too narrow.

## Decision

Rename `SandboxMessageRouter` to `RuntimeMessageRouter` and add a `RuntimeMessageBridge` as a unified messaging abstraction that works across sandbox iframes and user script contexts. Refactor runtime providers (Artifacts, Console, Attachments) to use the bridge. Extract file downloads into a dedicated `FileDownloadRuntimeProvider`. Rename functions to clarify scope: `listFiles` → `listAttachments`, `readTextFile` → `readTextAttachment`, etc.

## Consequences

- One router handles all execution contexts: sandbox, user script, and future environments.
- Dedicated providers per capability (artifacts, console, file downloads) instead of one monolithic provider
- `FileDownloadRuntimeProvider` isolates a security-sensitive operation behind its own interface
- The rename of `Sandbox*` to `Runtime*` acknowledges that the architecture isn't iframe-specific. It's a general provider execution model.
- The refactoring was driven by the needs of the `browser-javascript` tool, which runs code outside the sandbox in some configurations

## Confidence

High. commit body documents the full motivation and design.
