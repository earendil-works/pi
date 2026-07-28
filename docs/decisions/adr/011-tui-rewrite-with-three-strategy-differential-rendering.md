# 011: TUI Rewrite with Three-Strategy Differential Rendering

**Date:** 2025-11-10
**Source:** Commit `97c730c8`
**Replaces:** [ADR-002](002-custom-tui-engine-with-differential-rendering.md)

## Context

The original TUI (ADR-002) used a double-buffer differential rendering approach that compared old and new screen states to compute minimal updates. It worked but had performance issues with large outputs and stream-heavy content. The rendering was single-strategy: always compute diff, always apply minimal updates. The team found that different content types (streaming text, static markdown, file trees) benefited from different rendering approaches, and the single-strategy engine couldn't adapt.

## Decision

Rewrite the TUI with a three-path differential rendering engine. Path 1 (first render): sync output burst with no diff. Path 2 (terminal resize or changes above viewport): sync output, clear screen, full redraw. Path 3 (incremental content): compare old and new line arrays, find first and last changed indices, update only the changed range. All paths wrap output in CSI 2026 synchronized sequences to prevent terminal flicker. New components (Editor, Markdown, Loader, SelectList, Spacer) share the same interface as the old ones. Markdown renderer uses RGB background colors instead of the previous limited palette.

## Consequences

- Strategy selection is state-dependent, not per-component: initial paint, viewport-invalidating change, or incremental line diff. Markdown, text, and tool output all go through the same path selection logic.
- Editor component gains file autocomplete, slash commands, and large paste markers. Features the old TUI couldn't support.
- RGB background colors in markdown renderer give richer code block styling
- The rewrite happened ~3 months after the original TUI (ADR-002). The original architecture was sound enough that the component interface stayed compatible, but the rendering engine was completely replaced.
- Rewrites are expensive. A slower evolution of the original engine might have reached the same result with less churn.
- The component interface defined here later hosted the theming system (ADR-021), which replaced hardcoded ANSI codes with semantic color tokens across all TUI components.

## Confidence

High. The commit message and the `doRender()` implementation together document the three rendering paths and their triggering conditions.
