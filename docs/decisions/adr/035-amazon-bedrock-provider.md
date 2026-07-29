# 035: Amazon Bedrock Provider

**Date:** 2026-02-04
**Source:** Commit `fd268479`

## Context

AWS customers running Claude models through Amazon Bedrock had no native provider. They could configure a generic OpenAI-compatible endpoint, but Bedrock's API is fundamentally different. It uses the AWS SDK (`@aws-sdk/client-bedrock-runtime`) with IAM credentials, regional endpoints, and the Converse API instead of a REST endpoint. Prompt caching on Bedrock also works differently than the direct Anthropic API. The provider abstraction (ADR-003) assumed REST-based providers; Bedrock broke that assumption.

## Decision

Add a native Bedrock provider using the AWS SDK. Support IAM, ECS, IRSA, and Bearer token auth. Implement the Converse API with streaming. Add Bedrock-specific prompt caching for Claude models. Use regional endpoint resolution. Mark the provider as experimental initially.

## Consequences

- AWS customers get native Bedrock support without configuring a generic endpoint or managing raw SDK calls.
- Bedrock is the first provider to use the AWS SDK instead of REST. It sets the pattern for other SDK-based providers.
- Prompt caching works Bedrock's way instead of Anthropic's way, requiring separate cache control logic.
- Regional endpoint resolution means the provider needs credentials that work across regions, which isn't always the case with IAM roles.
- The AWS SDK dependency adds ~50MB to the binary size. Users who don't use Bedrock pay the size cost anyway.

## Confidence

High. Commit body and the Bedrock provider implementation document the architecture.
