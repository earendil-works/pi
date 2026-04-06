# Progress

## Baseline
- Mission created on 2026-04-06.
- Architecture direction approved by user: broader boundaries, prompt-layer/cache-plan abstraction, cross-provider-first, optimize cache hit-rate / lower cost.
- Current known baseline:
  - deterministic tool sorting exists in `packages/ai/src/prompt-cache-policy.ts`
  - Anthropic has explicit `cache_control` usage
  - OpenAI providers expose cache metrics but do not yet consume a shared cache plan
  - verification strategy should use real sessions from `~/.mu/sessions`

## Completed Tasks
- ✅ architecture-approval
- ✅ replay-harness-red-tests
- ✅ cache-plan-abstraction
- ✅ openai-completions-projection
- ✅ openai-responses-projection
- ✅ anthropic-projection
- ✅ prompt-assembly-audit

## Reopened Tasks
- ✅ replay-evidence-and-diagnostics
- ✅ milestone-core-gate
- ✅ final-check

## Baseline Capture
- Starting commit for implementation work: `78b92894 chore: bump version to 0.24.173`
- Working tree already contained unrelated generated/package changes; prompt-caching work added only new mission/test files for this task.

## Current State
- Red replay harness now exists in `packages/coding-agent/test/prompt-cache-replay.red.test.ts`.
- Fixture transcript in session-manager JSONL format lives at `packages/coding-agent/test/fixtures/prompt-cache-replay-session.jsonl`.
- Current red failure is expected: missing `packages/coding-agent/src/prompt-cache-replay.js`.
- `packages/ai/src/prompt-cache-policy.{ts,js,d.ts}` now expose cache layers in deterministic order: `system`, `tools`, `context`, `history`.
- Stable layers produce `stablePrefixFingerprint`, which is unchanged when only volatile context/messages change.
- `packages/ai/src/providers/openai-completions.ts` now projects cache-plan layers into separate leading `developer`/`system` messages and uses normalized tool ordering from the shared plan.
- `packages/ai/src/providers/openai-responses.ts` now projects cache-plan layers into separate leading input entries and uses normalized tool ordering from the shared plan.
- `packages/ai/src/providers/anthropic.ts` now projects cache-plan `system` and `context` layers into separate `system` blocks, each with additive `cache_control`.
- `packages/coding-agent/src/prompts/index.ts` now exposes explicit system-prompt sections so stable instructions, context files, and metadata are assembled in a deterministic stable-first order.
- `packages/coding-agent/src/prompt-cache-replay.ts` can now discover real Mu sessions, project provider payloads, and emit stable-prefix/tool-layer/LCP diagnostics.
- Independent review found two remaining gaps:
  - replay projection currently rebuilds contexts from message history only, so it misses system prompt, context files, and tools
  - request-surface evidence is still a local payload preview, not a real provider-bound capture
- Those gaps are now closed:
  - replay projection rebuilds full prompt-shaped contexts using session cwd, project context files, built system prompt sections, and deterministic tool selection
  - `m1-curl-surface.txt` now captures actual provider-bound request bodies from local provider-compatible servers using the same replay session as `replay-report.json`, and explicitly records Anthropic `system` blocks plus `cache_control` placement

## Next Recommended Task
- Mission complete.

## Notes
- Evidence files should be written under `devdocs/missions/prompt-caching-cross-provider-v1/evidence/`.
- Red test output captured in `devdocs/missions/prompt-caching-cross-provider-v1/evidence/replay-harness-red-tests.txt`.
- Cache-plan unit verification passed with `npm test -w @kennyfrc/mu-ai -- prompt-cache-policy.test.ts`.
- OpenAI Completions cache-plan projection passed with `npm test -w @kennyfrc/mu-ai -- openai-completions-prompt-cache-policy.test.ts prompt-cache-policy.test.ts`.
- OpenAI Responses cache-plan projection passed with `npm test -w @kennyfrc/mu-ai -- openai-responses-prompt-cache-policy.test.ts prompt-cache-policy.test.ts openai-completions-prompt-cache-policy.test.ts`.
- Anthropic cache-plan projection passed with `npm test -w @kennyfrc/mu-ai -- anthropic-prompt-cache-policy.red.test.ts prompt-cache-policy.test.ts openai-completions-prompt-cache-policy.test.ts openai-responses-prompt-cache-policy.test.ts`.
- Prompt assembly sectioning passed with `npm test -w @kennyfrc/mu-coding-agent -- system-prompt-sections.test.ts todowrite-integration.test.ts`.
- Real-session replay evidence captured in `devdocs/missions/prompt-caching-cross-provider-v1/evidence/replay-report.json` and provider-specific `m1-replay-*.txt` files.

## Verification Follow-up
- After verifier review, the replay and request-surface gaps were fixed and revalidated.

## Final Verification
- `npm test -w @kennyfrc/mu-ai -- prompt-cache-policy.test.ts openai-completions-prompt-cache-policy.test.ts openai-responses-prompt-cache-policy.test.ts anthropic-prompt-cache-policy.red.test.ts`
- `npm test -w @kennyfrc/mu-coding-agent -- prompt-cache-replay.red.test.ts system-prompt-sections.test.ts prompts/index.test.ts`
- `npm run check`
- Mission evidence present:
  - `devdocs/missions/prompt-caching-cross-provider-v1/evidence/m1-targeted-tests.txt`
  - `devdocs/missions/prompt-caching-cross-provider-v1/evidence/m1-replay-openai-completions.txt`
  - `devdocs/missions/prompt-caching-cross-provider-v1/evidence/m1-replay-openai-responses.txt`
  - `devdocs/missions/prompt-caching-cross-provider-v1/evidence/m1-replay-anthropic.txt`
  - `devdocs/missions/prompt-caching-cross-provider-v1/evidence/m1-review.json`
  - `devdocs/missions/prompt-caching-cross-provider-v1/evidence/m1-curl-surface.txt`

## Final Summary
- Shared cache-plan layers now exist and drive prompt shaping for `openai-completions`, `openai-responses`, and `anthropic`.
- Prompt assembly is now explicit about stable instructions vs context files vs metadata.
- Replay diagnostics can project real session histories into provider payloads and compute stable-prefix/tool-layer/LCP metrics.
- Mission acceptance evidence is stored under `devdocs/missions/prompt-caching-cross-provider-v1/evidence/`.
