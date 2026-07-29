# TDR-005: Truecolor Assumed for All Terminals

**Date:** 2026-01-29
**Source:** Commit `b4fb6770`
**Related to:** [ADR-015](adr/015-theming-system.md)

The TUI now assumes truecolor support for all terminals except those reporting `dumb`, empty, or `linux` as `$TERM`. This fixes missing colors over SSH (where the local terminal supports truecolor but the remote `$TERM` doesn't advertise it). The assumption is that virtually all modern terminals support truecolor, but users on legacy terminals (pre-2015, serial consoles, some CI environments) may see garbled output or missing colors. There is no opt-out or fallback configuration.
