# 035: Azure OpenAI Responses Provider

**Date:** 2026-02-23
**Source:** Commit `85601229`

## Context

Azure customers running OpenAI models through Azure's OpenAI service had no native provider. The provider abstraction (ADR-003) didn't handle deployment-aware routing or Azure-specific API versions. Azure's API is similar to OpenAI but diverges in deployment naming (models are deployed to named deployments), API versions (embedded in the URL path), and auth (API keys or Entra ID). The OpenAI-compatible provider path didn't handle deployment-aware routing or Azure-specific response formats.

## Decision

Add an `azure-openai-responses` provider that maps model names to Azure deployment names, embeds the API version in the base URL, and shares the OpenAI Responses provider logic through a refactored common layer. Support deployment-aware model mapping that translates canonical model IDs (e.g., `gpt-4o`) to Azure deployment names.

## Consequences

- Azure customers get native support without configuring a generic endpoint with manual URL construction.
- Sharing logic with the OpenAI Responses provider via refactored common code prevents drift between the two providers.
- Deployment name mapping means users don't need to remember Azure's deployment naming conventions — they use standard model IDs.
- Azure's API version strategy means the provider hardcodes a version in the URL, which may need updates as Azure phases out old versions.

## Confidence

High. Commit body and the shared provider refactoring document the design.
