# 026: Unified Extensions System

**Date:** 2026-01-07
**Source:** Commit `2846c7d1` | Commit `cf1c4c31`

## Context

The coding agent had two separate extension mechanisms: hooks (ADR-021, lifecycle callbacks with `pi.sendMessage()`) and custom tools (LLM-callable functions with `registerTool()`). Both ran on the AgentSession core (ADR-019). They shared similar needs (discovery, loading, configuration, UI access) but had separate loaders, separate types, and separate documentation. Adding a new hook often meant duplicating infrastructure in the custom-tools loader. Neither system knew about the other, so users had to choose between two systems with overlapping capabilities.

## Decision

Merge hooks and custom-tools into a unified extensions system. A single `ExtensionAPI` provides `registerTool()`, `on()`, and UI methods. Tools receive an `ExtensionContext` with UI access (unlike the old `CustomToolContext`). There is no `onSession` callback on tools. Hooks replace that pattern via `pi.on()`. Extensions are discovered via `package.json` manifests and can be plain directories with an `index.js`. The old hooks and custom-tools directories still work but trigger deprecation warnings. Neither is deprecated overnight. Doesn't mean they'll stay forever.

## Consequences

- One extension system replaces two. New capabilities (entry loading, UI access, configuration) benefit both hooks and tools without duplication.
- Tools now have UI access — they can prompt, select, show notifications — which was previously only available to hooks.
- `pi.on()` replaces `onSession` callbacks, giving tools access to session lifecycle events.
- Extension discovery via `package.json` enables npm-published extensions. A user can `npm install` an extension and configure it in settings.
- The merge required migration: old hooks and custom-tools directories still load but with warnings. The `commands` setting was renamed to `prompts`.
- The extension API is broader than the sum of hooks and tools, which means more surface area to maintain and document.

## Confidence

High. Multiple commits with design docs and migration strategy, documented in CHANGELOG and extensions.md.
