# 046: Constrained Sampling for Structured Output

**Date:** 2026-04-10
**Source:** Commit `24bace27`

## Context

The agent could request structured output from models through tool calls and system prompts via the provider abstraction (ADR-003), but had no way to enforce structural constraints on the model's free-form text responses. JSON was requested via prompting alone. Doesn't mean the model complied. Models could deviate from the expected schema, and there was no mechanism to constrain generation to valid JSON, follow a grammar, or respect a regex pattern. Providers like OpenAI and Anthropic started supporting constrained sampling (JSON schema, grammar) but the agent had no integration.

## Decision

Add constrained sampling support to the AI provider abstraction. Pass JSON schema, grammar, or format constraints through `StreamOptions` to providers that support them. Providers translate constraints to their native format (e.g., OpenAI's `response_format`, Anthropic's structured output). Unsupported providers ignore the constraint and fall back to unconstrained generation.

## Consequences

- Structured output requests can enforce JSON Schema compliance instead of relying on prompting alone.
- The constraint model is provider-agnostic: the agent specifies what it wants, each provider translates to its native format.
- Unsupported providers fall back silently. No error, just unconstrained output. Callers that depend on structured output must verify the response.
- Constrained sampling may increase latency (providers process constraints during generation) and may not compose with all features (e.g., streaming with certain constraint types).

## Confidence

High. Commit body documents the constraint model and provider integration.
