# 037: Custom Provider Support via Extensions

**Date:** 2026-02-10
**Source:** Commit `177c6944` | Commit `3256d3c0`

## Context

Custom providers required editing `models.json` (ADR-013) with a fixed set of API types, or using the built-in provider implementations (ADR-003). Extensions had no way to register a provider programmatically. They could add models to the existing built-in providers but couldn't define a new provider with its own OAuth flow, unique request/response handling, or custom authentication. The model registry and provider system were separate systems that didn't talk to each other.

## Decision

Add a provider registry (`apiProviders`) alongside the model registry. Extensions register providers via `registerProvider()` with a `streamSimple()` function that implements the LLM streaming contract. The registry integrates with model resolution so extension-registered providers appear in the model selector alongside built-in ones. Refactor OAuth into a separate registry with per-provider login/logout handlers.

## Consequences

- Extensions can define entirely new providers with custom streaming logic, OAuth flows, and API handling. This goes beyond model overrides.
- The provider registry and model registry now work together: a registered provider's models are available for selection and session use.
- OAuth per-provider decouples auth from the provider implementation. A provider can be added without modifying the OAuth infrastructure.
- Extension-based providers face the same maintenance burden as built-in ones: API changes, new features (vision, tools, streaming), and edge cases must be handled by the extension author.

## Confidence

High. Multiple commits with integration tests and example providers (GitLab Duo, custom-provider).
