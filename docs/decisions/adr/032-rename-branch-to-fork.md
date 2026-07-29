# 032: Rename /branch to /fork

**Date:** 2026-01-26
**Source:** Commit `df3f5f41`

## Context

The `/branch` command created a new conversation path within a session tree. The name "branch" collided with git terminology: users in a git repository would reflexively type `git branch` and get confused when the agent interpreted it as a session command instead of a git operation. The session tree (ADR-024) already used tree and branching metaphors, but "branch" was overloaded.

## Decision

Rename the `/branch` command to `/fork`. Update all documentation, help text, and hook API references. The term "fork" better describes the action (creating a divergent copy of the conversation at a point in time) without conflicting with git's `branch` terminology.

## Consequences

- `/fork` avoids confusion with git's `branch` command. Users can type `git branch` without the agent intercepting it.
- "Fork" more accurately describes the action: the session tree splits at a point, creating an independent path.
- The rename is breaking for any hooks or scripts that reference `ctx.branch()` or the `/branch` command. A compatibility alias could be added but wasn't.
- Documentation, changelog, and help text all needed updating simultaneously to avoid confusion during the transition.

## Confidence

High. Single-purpose commit with clear motivation.
