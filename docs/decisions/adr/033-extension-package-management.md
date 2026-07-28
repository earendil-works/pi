# 033: Extension Package Management with ResourceLoader

**Date:** 2026-02-12
**Source:** Commit `b846a4bf`

## Context

Extensions were loaded from local directories. Users who wanted to share or install extensions had to clone repos manually, copy files into the right directory, and manage updates themselves. There was no way to install an extension from a git URL or npm package, no dependency resolution, and no conflict detection. The extension system (ADR-025) provided the runtime API but no package management layer.

## Decision

Add a `ResourceLoader` that discovers and manages extension packages from multiple sources: git URLs, local paths, npm packages, and bundled dependencies. Implement `/reload` for hot-reloading extensions without restarting the agent. Add package deduplication, collision detection, and progress callbacks for git operations. Support glob patterns in manifest arrays for filtering resources. Extensions installed via git get `.gitignore` added to their install roots.

## Consequences

- Users install extensions with a URL instead of manual file copying. `pi add github:user/repo` works.
- `/reload` makes extension development iterative (edit, reload, test, repeat) without restarting the agent.
- Collision detection catches conflicting shortcuts, tools, and events at install time. Instead of at runtime.
- Glob patterns in manifest arrays give package authors fine-grained control over what gets loaded.
- Git operations add latency to startup when remote extensions need cloning or updating. Doesn't affect local extensions.

## Confidence

High. Multiple implementation commits and the resource loader tests document the package management flow.
