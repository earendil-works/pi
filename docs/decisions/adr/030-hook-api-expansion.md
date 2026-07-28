# 030: Hook API Expansion — Plan Mode, Widgets, Context Events

**Date:** 2026-01-20
**Source:** Commit `4cee51e4` | Commit `51d396b3` | Commit `57bba4e3` | Commit `77fe3f1a`

## Context

The initial hooks system (ADR-018) provided lifecycle events (`before_agent_start`, `before_tool`, etc.) and message injection via `pi.sendMessage()`. But hooks couldn't display persistent UI (status widgets), intercept or modify messages before the LLM call, enable or disable tools at runtime, or be packaged as reusable features. The plan-mode extension (a todo-tracking hook that guided the agent through task lists) surfaced all of these gaps at once.

## Decision

Expand the hooks API with: `setWidget()` for multi-line status displays that persist across turns, `setWidgetComponent()` for custom TUI components in widgets, a `context` event that runs before every LLM call and can insert/modify messages, `text_delta` event for streaming text monitoring, `registerTool()` for runtime tool registration, `systemPromptAppend` for injecting system prompt content, and CLI flag/shortcut registration. The plan-mode hook serves as the reference implementation for all of these.

## Consequences

- Hooks can now display persistent UI (e.g., todo lists, progress trackers) instead of only injecting messages.
- The `context` event enables message-level transformations before each LLM call. Filtering stale instructions, injecting relevant context, enforcing constraints.
- `text_delta` lets hooks monitor output as it streams, enabling real-time keyword detection, logging, or moderation.
- `registerTool()` in hooks replaces the need for separate custom-tools configuration.
- The plan-mode hook validates all these APIs together. It uses widgets for todo lists, context events for stale instruction filtering, text_delta for completion tracking, and tool registration for execution.
- The expanded API surface increases complexity. Each new event type means the extension runner must handle more call sites and error cases.
- These APIs were later absorbed into the unified extensions system (ADR-025), which merged hooks and custom-tools under one API.

## Confidence

High. Multiple implementation commits and the plan-mode hook serve as a reference implementation.
