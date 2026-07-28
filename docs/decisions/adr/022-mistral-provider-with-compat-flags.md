# 022: Mistral AI Provider with Extended Compat Flags

**Date:** 2025-12-10
**Source:** Commit `99b4b1ac`

## Context

The OpenAI-compatible provider implementation assumed a certain level of API compatibility: standard tool call formats, no requirement for tool result names, no synthetic assistant messages between tool and user content. Mistral's API, while broadly OpenAI-compatible, diverged in several ways: tool results needed an explicit `name` field, the API required an empty assistant message between tool results and user messages, thinking blocks had to be sent as `<thinking>` text, and tool IDs had to be exactly 9 alphanumeric characters. The provider abstraction (ADR-003) handled provider-specific quirks through the unified LLM interface, and the validation infrastructure from the TypeBox switch (ADR-007) provided the pattern for declaring these per-provider flags.

## Decision

Add Mistral as a known provider with a set of compatibility flags in the OpenAI-completions provider: `requiresToolResultName`, `requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `requiresMistralToolIds`. Extend the provider to check these flags and adjust serialization accordingly. Generate Mistral models alongside existing providers. Update all tests (abort, handoff, streaming, tokens, surrogates) to include Mistral.

## Consequences

- Mistral users get native support without configuring a generic OpenAI-compatible endpoint in models.json.
- The compat flag pattern formalizes what was previously ad-hoc: each provider declares its quirks and the provider implementation adapts.
- Mistral had the most compat flags of any provider at the time of addition, suggesting the "OpenAI-compatible" umbrella covers a wide range of actual behavior.
- Every test suite had to be updated for Mistral, adding ~400 lines of Mistral-specific test code. The test surface grows linearly with each provider, which isn't ideal.
- The compat flags approach is more maintainable than forking the provider implementation per API variant, but it adds conditional branches in the serialization hot path.

## Confidence

High. Commit body documents each compat flag and its purpose, and the test suite covers Mistral-specific behavior.
