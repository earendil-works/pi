# 002: Custom TUI Engine with Differential Rendering

**Date:** 2025-08-10
**Source:** Commit `afa807b2`
**Replaced by:** [ADR-011](011-tui-rewrite-with-three-strategy-differential-rendering.md)

## Context

The agent needed a terminal UI for interactive chat sessions. Existing Node.js TUI libraries (blessed, react-blessed, ink) were evaluated but found to be either unmaintained, overly complex, or tied to specific rendering paradigms that didn't fit the streaming-first, async-heavy chat workflow. The team wanted full control over rendering performance to handle real-time token streaming without flicker.

## Decision

We will build a custom TUI engine with a terminal abstraction layer (`ProcessTerminal` for production, `VirtualTerminal` using `@xterm/headless` for testing) and a double-buffer differential rendering system that only updates changed lines instead of clearing and redrawing entire sections.

## Consequences

- Full control over rendering pipeline — flicker-free streaming output even at high token rates
- VirtualTerminal enables accurate headless testing of rendering logic without a real terminal
- Higher initial development cost compared to using an existing library
- Ongoing maintenance burden for terminal compatibility (signals, resize, escape sequences)
- The abstraction makes it possible to swap rendering strategies without changing component code

## Confidence

High. The commit body and test suite together document the architecture, alternatives, and design decisions.
