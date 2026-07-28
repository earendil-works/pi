# 001: Monorepo with npm Workspaces and Lockstep Versioning

**Date:** 2025-08-09
**Source:** Commit `a74c5da1`

## Context

The project shipped three packages from day one — `pi-tui`, `pi-agent`, and `pi` (pods) — that shared TypeScript tooling, linting, and a release cycle. Each one needed to land on npm independently, but their versions had to stay compatible: a breaking change in `pi-tui` meant `pi-agent` had to pin or bump. Alternatives like Lerna, Turborepo, and Nx all added toolchain overhead. The team knew npm workspaces and wanted something that Just Worked.

## Decision

npm workspaces monorepo with a dual TypeScript config: a root `tsconfig.json` for development (path mappings so packages can import each other at source), per-package `tsconfig.build.json` files for clean production builds. All packages share one lockfile. A custom `sync-versions.js` script keeps them on the same version.

## Consequences

- One `npm install` at root, every package is ready. Simple onboarding.
- Lockstep versioning means a release always bumps everything together. No "which version of pi-agent works with pi-tui 0.5.2" questions.
- Dual tsconfig keeps `tsc` fast in dev (path mappings avoid intermediate builds) and outputs clean artifacts in production (no path mapping artifacts leak into the `.js` files).
- No Lerna, no Turborepo, no Nx. Less to learn. Also no build caching, no task orchestration, no dependency graph. Builds stay serial and full.
- New packages don't get scaffolded. Someone has to copy the tsconfig pattern and wire up the workspace entry by hand.

## Confidence

High. First commit of the repository with a detailed body explaining the structure and rationale.
