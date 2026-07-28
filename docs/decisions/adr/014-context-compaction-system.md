# 014: Context Compaction System

**Date:** 2025-12-04
**Source:** Commit `c89b1ec3` | Commit `5daef11b` | Commit `a38e6190`

## Context

Long agent sessions accumulate conversation history that grows beyond the model's context window. Previously the agent had no mechanism to shorten history. Once the context filled, the only option was to start a new session or manually trim. The team needed a way to compress the conversation while preserving essential context, ideally triggered automatically when the window got tight.

## Decision

Implement a compaction system with three modes: manual (`/compact`), automatic (toggled via `/autocompact`), and auto-triggered when context usage exceeds `contextWindow - reserveTokens`. Compaction works by sending the conversation to the LLM with instructions to produce a condensed summary, which replaces the original history. The compaction is visible in the TUI as a collapsible component and renders in HTML exports as a collapsible summary. A `CompactionComponent` shows the summary expanded by default, then collapses it on subsequent renders.

## Consequences

- Context overflow is no longer a session-ending event. The agent recovers by compacting.
- Automatic compaction means users don't have to think about context limits during normal use.
- The compaction itself consumes context (the LLM reads the full history to summarize it). On very long sessions, the compaction prompt alone might push past the window. The system detects this and handles overflow recovery.
- The compacted summary is lossy. Details the LLM deemed unimportant during summarization are gone. The `/branch` command provides an alternative: it preserves the full conversation up to a point and starts a fresh branch.
- Early versions had a proactive abort-then-retry pattern that was later simplified to `Agent.continue()` for retry, reducing complexity.

## Confidence

High. Multiple commits with detailed bodies, research documents, and the compaction flow is well-documented in the code and README.
