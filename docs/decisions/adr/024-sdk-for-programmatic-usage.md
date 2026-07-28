# 024: SDK for Programmatic AgentSession Usage

**Date:** 2025-12-19
**Source:** Commit `5482bf3e`

## Context

The coding agent's `AgentSession` API (ADR-016) was usable from inside the CLI but had no clean entry point for external programs. Importing `@mariozechner/pi-coding-agent` gave access to internal modules but no documented factory function that set up everything — session manager, model registry, auth storage, skills, hooks, custom tools — with correct defaults. Every external consumer duplicated setup logic.

## Decision

Add a `createAgentSession()` factory in `src/core/sdk.ts` that takes a configuration object and returns a fully wired `AgentSession`. Update all loaders (skills, hooks, custom-tools, slash-commands, system-prompt) to accept `cwd`/`agentDir` parameters so they work outside the CLI context. Export the SDK from the package index. Document with SDK usage examples.

## Consequences

- External programs can create an `AgentSession` with one function call instead of wiring a dozen subsystems manually.
- The SDK becomes the documented entry point, making internal module imports unnecessary.
- `cwd`/`agentDir` parameters on loaders decouple file discovery from the CLI startup path. SDK users can point at any directory.
- The SDK doesn't cover every configuration option. Some edge cases still require direct access to internal modules via subpath imports.

## Confidence

High. Commit body and SDK documentation cover the factory design and configuration options.
