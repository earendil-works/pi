# 019: Standalone Binary Distribution with Bun

**Date:** 2025-12-02
**Source:** Commit `c4a65ad8`

## Context

The agent was distributed exclusively via npm (`npm install -g @mariozechner/pi-coding-agent`). This required Node.js, TypeScript compilation, and npm toolchain — friction for users who just wanted to download and run. Bun's ability to compile JavaScript/TypeScript into a standalone binary offered a path to zero-dependency distribution. The team also needed asset resolution that worked across npm install, Bun binary, and tsx development modes.

## Decision

Add a `build:binary` script that compiles the coding agent with `bun build --compile`. Create `paths.ts` for cross-platform asset resolution that detects whether it's running as a Bun binary, from npm, or via tsx. Set up a GitHub Actions workflow that builds binaries for Linux, macOS, and Windows on every release. Bundle the binary as `pi` inside the archive for a consistent command name.

## Consequences

- Users can download a single binary with no runtime dependencies. No Node.js, no npm, no build step.
- `paths.ts` abstracts asset resolution (themes, models, docs) across three execution modes: Bun binary (assets embedded), npm install (assets alongside source), and tsx development (assets resolved from source tree).
- Binary builds are automated in CI for every release. No manual build step.
- Bun compilation has quirks: `process.cwd()` edge cases, Windows path resolution, and binary size (~50MB for a TypeScript project).
- npm remains the primary distribution channel for most users. Binary distribution supplements rather than replaces it.

## Confidence

High. Commit body, CI workflow, and `paths.ts` implementation together document the distribution architecture.
