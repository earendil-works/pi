# 012: Hierarchical Context File Loading for Monorepos

**Date:** 2025-11-12
**Source:** Commit `dca3e1cc`

## Context

The agent needed project-level instructions: files like `AGENTS.md` or `CLAUDE.md` that tell the LLM about project conventions, architecture, and rules. A single file in the working directory worked for flat projects but broke down in monorepos: a package inside `packages/foo/` wouldn't see the root-level `AGENTS.md` that defined monorepo-wide conventions. Meanwhile, the agent had no global context either. No way to set user-wide preferences independent of any project.

## Decision

Walk up parent directories from the working directory, collecting every `AGENTS.md` or `CLAUDE.md` found. Load global context from `~/.pi/agent/AGENTS.md`. Insert each file as a separate system message in load order: global first, then top-most parent, all the way down to the working directory. Prefer `AGENTS.md` over `CLAUDE.md` when both exist in the same directory.

## Consequences

- Monorepo packages inherit root-level conventions automatically. No symlinks, no copying.
- Global context gives every session user-wide instructions (preferred models, coding style) without per-project files.
- Each context file is its own message, which means the LLM sees them as distinct sources. It can reference "the monorepo rules" vs "this package's rules."
- The walk stops at filesystem root. No risk of infinite loops.
- Loading many context files increases system prompt size. Deep directory trees could accumulate significant context before the user types anything.

## Confidence

High. Commit body documents the loading order, file priority, and global context path.
