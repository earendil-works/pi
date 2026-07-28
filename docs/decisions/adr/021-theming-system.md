# 021: Theming System with User-Defined Themes

**Date:** 2025-11-20
**Source:** Commit `cc880951`

## Context

The TUI used hardcoded terminal colors throughout components: markdown, editor, selectors, footer. The TUI engine (ADR-011) provided the component system and rendering pipeline, but colors were still raw ANSI codes scattered across files. Users who wanted a different look (light theme, higher contrast, color-blind friendly palette) had no way to customize. Every new component needed manual color choices that might not match the rest of the UI. The team needed a centralized color system that components reference by semantic token rather than raw ANSI code.

## Decision

Create a `Theme` class with `fg()`, `bg()`, `bold()`, `italic()`, `underline()` methods that map semantic tokens (e.g., `theme.fg('text')`, `theme.bg('selection')`) to terminal escape codes. Define two built-in themes (dark, light) with 36 color tokens each stored as JSON files. Support custom themes in `~/.pi/agent/themes/*.json` with JSON schema validation. Add a `/theme` command with a selector UI. Save the selected theme to settings. Use `chalk` for cross-platform text formatting.

## Consequences

- Components reference semantic tokens instead of raw colors. A component uses `theme.fg('code')` and gets the right color regardless of which theme is active.
- Dark and light built-in themes cover the two main use cases. Custom themes cover the rest without code changes.
- JSON schema validation catches malformed themes with clear error messages: missing tokens, wrong types, invalid escape codes.
- The initial implementation (this commit) defined the theme system and tokens but didn't migrate all components. Some hardcoded colors remained as a TODO.
- Themes are loaded from `~/.pi/agent/themes/*.json` on the filesystem, making them shareable. Users can share theme files directly.

## Confidence

High. Commit body describes the architecture and TODO items, and the theme schema serves as the interface reference.
