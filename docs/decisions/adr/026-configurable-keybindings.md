# 026: Configurable Keybinding System

**Date:** 2026-01-12
**Source:** Commit `8f268257`

## Context

Keyboard shortcuts were hardcoded throughout the TUI: Ctrl+C to interrupt, Tab to cycle models, Escape to cancel. Users with different terminal emulators, muscle memory from other editors (Vim, Emacs, VS Code), or accessibility needs had no way to remap them. Every new shortcut required a code change and a keybinding documentation update.

## Decision

Add `~/.pi/agent/keybindings.json` that maps action names to key sequences. Define a typed `KeyId` for every action: editor navigation (`cursorUp`, `cursorDown`, `deleteWordBackward`), app controls (`interrupt`, `submit`, `cycleModelForward`), and selectors (`selectConfirm`, `selectCancel`). The `matchesKey()` function checks configured bindings before falling back to defaults. All selectors, lists, and the editor use keybindings instead of hardcoded key checks.

## Consequences

- Users can remap any shortcut without modifying code. Vim-style bindings, Emacs-style, or custom layouts are all configuration.
- `matchesKey()` replaces scattered key checks throughout the codebase. New actions just need a `KeyId` entry and default binding.
- The default keybindings serve as documentation — the `DEFAULT_EDITOR_KEYBINDINGS` and `DEFAULT_APP_KEYBINDINGS` maps are the reference.
- The keybinding system doesn't cover modifier-only chords (e.g., holding Shift). The Kitty keyboard protocol is queried to determine which keys the terminal supports.

## Confidence

High. Commit body documents all action types and the default bindings serve as the interface reference.
