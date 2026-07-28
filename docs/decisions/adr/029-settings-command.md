# 029: Settings Command with Unified Settings UI

**Date:** 2025-12-23
**Source:** Commit `c53b22db`

## Context

Configuration was scattered across files: `settings.json` for preferences, `models.json` for providers, `keybindings.json` for shortcuts, `oauth.json` for tokens. Users who wanted to change a setting had to know which file to edit and what format it used. There was no in-app way to browse or modify settings. Only command-line or text editor access.

## Decision

Add a `/settings` slash command that opens a unified settings menu in the TUI. The menu groups settings by category (General, Models, Keys, Appearance) and provides toggle switches, text inputs, and selectors for each option. Changes are written to the appropriate configuration file and take effect immediately.

## Consequences

- Users can browse and modify settings without leaving the TUI or knowing file paths.
- The settings menu groups related options together, making discovery easier than browsing JSON files.
- Each setting type gets the appropriate UI widget: toggle for booleans, text input for strings, selector for enums.
- The settings menu doesn't cover all configuration. Less common options (custom themes, extension directories) remain file-only.
- Changes take effect immediately, no restart needed.

## Confidence

High. The commit body and settings UI implementation together document the design.
