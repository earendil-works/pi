# 009: Agent Architecture Refactor with Session Persistence

**Date:** 2025-10-06
**Source:** Commit `e5cf25a2`

## Context

The agent's state management had grown organically. Session and agent were the same concept (`AgentSession`), transport callbacks created circular dependencies, and there was no persistence: every browser reload started a blank conversation. The browser extension and web UI both needed session storage (history, search, auto-reload), which forced a cleanup of the state layer first. The storage layer refactored in ADR-008 (Oct 5) provided the IndexedDB backend this session persistence needed.

## Decision

Rename `AgentSession` to `Agent`, restructure from `state/` to `agent/`. Transports switch from callback-based to direct message passing, breaking the circular dependency. Add a `SessionRepository` backed by IndexedDB that auto-saves after the first exchange and auto-generates titles from the first user message.

## Consequences

- Session persistence works across browser extension and web UI without duplicating storage logic
- IndexedDB gives 10GB+ quota compared to `chrome.storage`'s 10MB. Important for long conversations with artifacts.
- Auto-generated titles from first user message mean the session list is useful without manual naming
- The circular dependency fix in transports makes testing easier. No more mock setup for callbacks.
- Session save doesn't happen before the first exchange. Unsaved conversations are possible if the agent never responds.

## Confidence

High. The commit body documents every piece of the refactoring in detail, even though the changes are broad.
