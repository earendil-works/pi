---
mode: build
---

# Summary & Recommendation
Implement a provider-neutral prompt-layer/cache-plan system that improves prompt-cache stability for `openai-completions`, `openai-responses`, and `anthropic` first, while benefiting all providers through deterministic prompt serialization and stable-prefix preservation. Verify the work by replaying real sessions from `~/.mu/sessions` through imported payload-building modules and comparing adjacent-turn provider payloads.

# What Must be True
- One canonical cache plan describes stable system prefix, tool/schema layer, volatile context layer, and conversation history layer.
- `openai-completions`, `openai-responses`, and `anthropic` all consume the same logical cache plan.
- Tool ordering and any cache-relevant section ordering are deterministic.
- Stable prefix bytes remain unchanged across adjacent turns in ordinary append-only conversations.
- Anthropic-specific `cache_control` usage is a projection of the shared cache plan, not a separate semantic model.
- Verification uses real sessions from `~/.mu/sessions` plus real imported modules from this repo.

# What Must Never Happen
- Anthropic request shape must never become the canonical internal abstraction.
- Provider-specific logic must never redefine prompt meaning.
- Historical messages must never be rewritten casually in ways that invalidate reusable prefix bytes.
- Dynamic values must never be injected into the earliest stable prefix unless intentionally invalidating cache.
- Verification must never rely only on toy contexts when real-session replay is available.

# Inputs / Outputs
- Input: system prompt template and prompt-building modules in `packages/coding-agent/src/prompts/*`.
- Input: provider payload builders in `packages/ai/src/providers/*`.
- Input: real saved sessions from `~/.mu/sessions`.
- Input: tool definitions, context files, and message history.
- Output: provider-neutral cache plan.
- Output: improved provider payload shaping for `openai-completions`, `openai-responses`, and `anthropic`.
- Output: replay evidence showing stable-prefix preservation and provider payload diffs.

# Edge Cases
- Model switch or provider switch mid-session.
- Toolset changes mid-session.
- Context file changes and file-tree changes.
- Image-bearing history.
- Thinking-block stripping or replay normalization.
- Compaction or clear flows that intentionally reset prompt shape.
- Continued/resumed sessions with older message formats.

# Constraints
- Preserve user-visible prompt semantics.
- Keep the abstraction provider-neutral, with provider-specific capabilities layered on top.
- Avoid `any` unless absolutely necessary.
- Keep verification executable with scripts, assertions, logs, and diffs.
- Run `npm run check` before mission completion.
- Do not depend on Anthropic-only features for cross-provider correctness.

# Definition of Done
- A shared cache-plan abstraction exists and is consumed by `openai-completions`, `openai-responses`, and `anthropic`.
- Deterministic ordering is proven for cache-relevant layers.
- Replay scripts over real sessions produce stable-prefix hashes and adjacent-turn diff metrics.
- Anthropic request payloads place `cache_control` only as an optimization of the shared cache plan.
- `npm run check` passes.
- Mission evidence includes real-session replay outputs and provider payload assertions.

# What needs to be done to deliver the spec
1. Define the provider-neutral cache-plan abstraction and its invariants.
2. Add targeted red tests for deterministic cache-plan serialization and provider projection.
3. Add real-session replay scripts in `/tmp` that import actual modules and project adjacent turns into provider payloads.
4. Implement cache-plan-driven serialization for `openai-completions`, `openai-responses`, and `anthropic`.
5. Audit prompt-building and replay normalization paths for accidental cache-breaking mutations.
6. Add diagnostics and evidence outputs for stable-prefix hashes, tool-layer hashes, and adjacent-turn diff metrics.
7. Run targeted verification and `npm run check`.
