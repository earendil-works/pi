# 041: Models Runtime with Provider-Owned Auth

**Date:** 2026-04-16
**Source:** Commit `f63095cf` → `10a575b7` (8 phases)

## Context

The AI package had grown organically since the original provider abstraction (ADR-003). Provider implementations, model catalogs, authentication, OAuth flows, and custom provider support (ADR-039) were scattered across the package. The generated model registry (ADR-004) produced static type definitions, but the runtime logic for resolving models, managing provider auth, and selecting providers was mixed with the provider implementations. Adding a new provider meant touching the model generation script, the provider registry, the OAuth system, and the auth storage. There was no single entry point for "give me a Models instance" that handled everything.

## Decision

Refactor the AI package into a `Models` runtime that owns provider authentication and model resolution. Implement in 8 phases: (1) Models runtime with provider-owned auth, (2) lazy API wrappers in `src/api`, (3) provider factories with per-provider model catalogs and `createProvider()`, (4) OAuth adapted to `OAuthAuth`, (5) compat entrypoint with core-only barrel, (6) AgentHarness streams through Models, (7) Models is the harness's only auth path, (8) `ImagesModels` collections mirroring the chat-side design.

## Consequences

- `Models` becomes the single entry point for provider access. Consumers call `createModels()` and get a fully wired instance with auth, model resolution, and provider selection.
- Provider factories isolate each provider's model catalog and auth configuration. Adding a new provider adds a factory file and a catalog entry, not changes across the package.
- Lazy API wrappers in `src/api` mean provider SDKs are loaded on demand, not at import time.
- The refactoring took 8 phases over ~2 weeks. Phase boundaries were defined by working tests at each stage.
- The old entry points still work through compat wrappers, but the `Models` API is the recommended path. Doesn't mean the old ones disappear overnight.

## Confidence

High. Commit messages document each phase and the migration path.
