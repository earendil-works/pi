# Architecture Proposal

## Summary
Implement prompt caching as a provider-neutral `cache plan` / `prompt layer` abstraction centered in `packages/ai`, then project that plan into provider-specific payloads. The core design should improve all providers via deterministic stable-prefix serialization, while Anthropic gains additional explicit `cache_control` optimization.

## Approved Direction
- Boundaries: broaden beyond Anthropic-only.
- Abstractions: use a prompt-layer/cache-plan abstraction.
- Tradeoffs: prioritize cross-provider abstraction first.
- What matters most: cache hit-rate / lower cost.

## Proposed Boundaries
- Core abstraction in `packages/ai/src/prompt-cache-policy.ts` and adjacent shared prompt/planning helpers.
- Provider projections in:
  - `packages/ai/src/providers/openai-completions.ts`
  - `packages/ai/src/providers/openai-responses.ts`
  - `packages/ai/src/providers/anthropic.ts`
- Prompt assembly integration in `packages/coding-agent/src/prompts/*` and, only if needed, `packages/agent/src/agent.ts` for replay-shape stability.
- Verification harness uses real saved sessions from `~/.mu/sessions` without changing session persistence semantics.

## Key Abstractions
- **CachePlan**: provider-neutral description of prompt layers and invalidation reasons.
- **PromptLayer**: stable system prefix, tool/schema layer, volatile context layer, conversation history layer, optional cache-breaker layer.
- **ProviderProjection**: maps a `CachePlan` to a concrete provider payload without changing semantics.
- **ReplayVerifier**: reads real session transcripts, reconstructs context with imported modules, projects payloads, and emits stable-prefix metrics.

## Tradeoffs
- Prefer one shared abstraction over provider-local optimizations.
- Accept modest prompt-assembly restructuring if it improves cross-provider prefix stability.
- Anthropic-specific `cache_control` remains valuable but must stay additive.
- Replay-based verification is heavier than unit-only checks, but gives much stronger evidence.

## What Matters Most
1. Cross-provider cache hit-rate / lower cost.
2. Deterministic prompt serialization.
3. Minimal semantic drift.
4. Evidence from real sessions, not just synthetic fixtures.

## Approval Record
- User approved broader boundaries, prompt-layer/cache-plan abstraction, cross-provider-first tradeoff, and cache hit-rate / lower cost priority on 2026-04-06.
