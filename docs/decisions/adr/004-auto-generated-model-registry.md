# 004: Auto-Generated Model Registry with Type-Safe Factory

**Date:** 2025-08-25
**Source:** Commit `da66a97e` | Commit `c7618db3` | Commit `efaa5cdb`

## Context

The AI package needed to support hundreds of models across dozens of providers, each with different capabilities (tool use, vision, streaming), pricing, and base URLs. Manually maintaining model metadata was error-prone and didn't scale. The team needed a system that could keep model data fresh without manual updates.

## Decision

We will generate `models.generated.ts` from external data sources (models.dev and OpenRouter) using a build-time script. The generated file produces a type-safe `createLLM()` factory with TypeScript overloads for each provider, including auto-detected base URLs, environment variable names, and capability flags. The generated file is excluded from git and rebuilt on every `npm run build`.

## Consequences

- Type safety: calling `createLLM()` with a model name provides autocompletion and type-checking per provider
- No manual model list maintenance — regenerate to pick up new models
- Generated file excluded from git avoids churn but means builds require the generation script to succeed
- Two data sources (models.dev for direct providers, OpenRouter for third-party) creates a split sourcing architecture
- Model capability metadata (tool use, vision) in the data source directly drives API behavior at runtime

## Confidence

High. Three commits with detailed bodies tracing the evolution from initial codegen to unified model system to models.dev sourcing.
