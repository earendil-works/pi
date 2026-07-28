# 042: Image Output Generation

**Date:** 2026-04-03
**Source:** Commit `e3d066da` | Commit `62d91326` | Commit `e9b0af0a`

## Context

The agent could process images (view, analyze, describe) via the provider abstraction (ADR-003) but couldn't generate them. The image processing pipeline had known compromises (TDR-003, TDR-006) for input handling. Providers started supporting image generation APIs, but the agent had no abstraction for image output: no types, no registry, no streaming interface.

## Decision

Add image output types, a provider registry for image generation, a streaming interface, and model metadata. Providers implement `generateImages()` through the registry. The image output pipeline mirrors the chat streaming design: events for progress, completion, and error. Model metadata includes image generation capabilities alongside chat capabilities.

## Consequences

- The agent can generate images through supported providers and display them inline.
- The image output API is separate from the chat API but follows the same event pattern, familiar to consumers of the existing streaming interface.
- Not all providers support image generation. The model metadata distinguishes chat-only from image-capable models.
- The initial implementation handles OpenRouter and direct provider paths, with model-specific image catalogs.

## Confidence

High. Multiple implementation commits and test coverage document the design.
