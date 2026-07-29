# 034: TUI Overlay Compositing

**Date:** 2026-02-02
**Source:** Commit `f9064c2f` | Commit `a4ccff38`

## Context

The TUI engine (ADR-011) provided the rendering pipeline and component system. Extensions could display custom UI via `ctx.ui.custom()` (ADR-030), but the result was embedded inline with chat content. Modal dialogs, popup menus, and floating panels weren't possible. Everything was part of the scrollable message stream. Extensions that needed focused input (select from a list, confirm an action, display temporary information) had no way to present content above the normal layout. No floating panels, no modals.

## Decision

Implement an overlay compositing system for the TUI. Extensions create overlays via `ctx.ui.custom()` with positioning options: `top`, `bottom`, `left`, `right`, `center`, or CSS-like value strings. Overlays render above the normal content with proper z-ordering, focus management, and cleanup. Multiple overlays can stack. The system handles keyboard focus routing between overlays and the underlying content.

## Consequences

- Extensions can display modal dialogs, popup menus, and floating panels without hacking inline content.
- CSS-like positioning values (`"top right"`, `"center"`, `"bottom left"`) make positioning intuitive for web developers.
- Focus routing between stacked overlays and content is handled by the compositor instead of each extension.
- Overlays increase TUI complexity: z-ordering, focus management, and cleanup on session switch all need compositor support.
- The overlay API is marked experimental initially, giving room to adjust positioning semantics.

## Confidence

High. Multiple implementation commits and overlay tests document the compositing architecture.
