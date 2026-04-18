# Architecture

## Mission

Add Morph-backed compaction to the coding agent, with an explicit `/morph-compaction` slash command that controls whether Morph compaction is `on`, `off`, or `auto`.

This mission covers both:

- the new user-facing control plane for Morph compaction policy
- the end-to-end compaction strategy that decides when Mu should use Morph, native provider compaction, or local fallback summarization

## Why this needs an architecture checkpoint

This is not just a new slash command.

Compaction currently sits on a correctness-critical boundary:

- it changes how context is rewritten into `context_compaction` checkpoint messages
- it affects session resume behavior
- it can preserve or discard provider-specific hidden replay state
- it changes when remote APIs are called and what gets sent to them

That means the architecture must be explicit before implementation starts.

## Current system boundaries

### 1. TUI command and orchestration boundary

Current TUI command flow lives in `packages/coding-agent/src/tui/tui-renderer.ts`.

Relevant responsibilities:

- slash command registration
- slash command parsing and dispatch
- building handoff / compaction details
- deciding when auto-handoff / compaction should happen
- applying `context_compaction` checkpoints to the active session

### 2. Compaction adapter boundary

Current compaction adapter logic lives in `packages/coding-agent/src/compaction-adapter.ts`.

Relevant responsibilities:

- detect whether upstream OpenAI/Codex compact is supported
- transform Mu messages into compact endpoint input
- call the remote compact endpoint
- translate compact output back into Mu replacement messages
- fall back to local summary if remote compact fails

### 3. Session persistence boundary

Session persistence lives in `packages/coding-agent/src/session-manager.ts`.

Relevant responsibilities:

- append `context_compaction` entries
- restore compacted message history on resume
- treat `replacementMessages` as the new effective thread history

### 4. Hidden provider-state boundary

Opaque replay items are represented by `__muCompactResponseItem` in `packages/ai/src/compact-history.ts`.

This boundary matters because native OpenAI/Codex compaction can preserve hidden replay state that is not reducible to plain visible text.

### 5. Settings / preference boundary

Persistent user preferences live in `packages/coding-agent/src/settings-manager.ts`.

This is the right place for the Morph compaction mode preference.

## Proposed boundaries

### A. Add a separate Morph compaction policy boundary

Introduce a distinct persisted mode:

- `type MorphCompactionMode = "on" | "off" | "auto"`

This boundary should not be folded into `/compact` or `autoHandoffMode`.

Reason:

- `/compact` means “compact now / control auto compaction behavior”
- `/morph-compaction` means “which compaction backend policy should be used”

These are related, but not the same concern.

### B. Add an explicit compaction strategy selector

Add one strategy-selection function that decides among:

- `native-replay-compact`
- `morph-compact`
- `local-summary-fallback`
- optionally `skip-compaction`

Inputs should include at minimum:

- current model
- presence of `MORPH_API_KEY`
- saved Morph compaction mode
- whether the history contains native replay items that require opaque preservation
- estimated history tokens
- current model context window
- whether compaction was explicitly requested or is automatic

This selector should be the only place that decides which compaction backend to use.

### C. Add a projection boundary for Morph input

Do not mix Morph request shaping directly into the strategy selector.

Create a dedicated projection layer:

- Mu message history -> Morph `messages`
- Mu message history -> Morph transcript `input`
- Mu history + goal -> normalized Morph `query`

Reason:

- native compact expects provider-shaped response items
- Morph expects plain text or simple `{ role, content }` messages
- these are different data contracts and should not be conflated

### D. Add a ratio-selection boundary

Dynamic ratio selection should be encapsulated in one helper that:

- uses Mu’s existing token estimation heuristics
- targets `40%` of context window
- clamps to `0.3..0.7`
- can return “skip compaction” when history already fits the target budget

This should be a pure function so it is easy to test.

## Recommended architecture

### Recommendation

Adopt a hybrid strategy:

- default Morph mode: `auto`
- prefer Morph when it can safely compact visible context
- retain native OpenAI/Codex compaction when hidden opaque replay semantics matter
- keep local fallback summary for unavailable or failed remote compaction paths

### Why hybrid is recommended

It preserves the strongest existing correctness property:

- native OpenAI/Codex compact can preserve provider replay state

while still delivering the desired product behavior:

- Morph compaction is available broadly
- users can force it on/off
- automatic mode can use it whenever the safety conditions are satisfied

### Why not “Morph always when key exists”

Because current native compact is semantically richer than plain-text compaction.

If Morph always replaces native compact, then Mu risks losing:

- opaque replay items
- provider-specific resume semantics
- behavior that depends on hidden compact state being replayed on the next turn

That tradeoff may be acceptable if explicitly desired, but it should not be implicit.

## What should count as “native replay semantics matter”

The strategy selector should conservatively treat native replay as required when either is true:

1. the history already contains hidden compact replay carrier messages
2. the current model/provider path supports native upstream compact with opaque replay items and the operation is a checkpointing path intended for same-provider resume

This should bias toward correctness rather than aggressively maximizing Morph usage.

## Slash command design

### New command

`/morph-compaction [on|off|auto|status|toggle]`

Recommended semantics:

- `/morph-compaction on` -> always prefer Morph textual compaction where compaction is performed
- `/morph-compaction off` -> never use Morph
- `/morph-compaction auto` -> use Morph only when safe and available
- `/morph-compaction status` -> report saved mode, effective mode, and whether `MORPH_API_KEY` is available
- `/morph-compaction toggle` -> cycle `auto -> off -> on -> auto`

Reason for including `toggle`:

- it matches existing command patterns in this codebase
- it is convenient in TUI use

### Why `/morph-compaction` should be separate from `/compact`

`/compact` currently mixes:

- explicit checkpoint creation
- auto-handoff control

Adding backend policy into the same command would overload it further and make the user model harder to understand.

Separate command = cleaner mental model.

## Dynamic ratio design

### Goal

Choose a Morph `compression_ratio` dynamically so the compacted history aims to fit within `40%` of the current model context window.

### Proposed behavior

Given:

- `estimatedHistoryTokens`
- `contextWindow`

Compute:

- `targetTokens = floor(contextWindow * 0.4)`
- if `estimatedHistoryTokens <= targetTokens`: return `skip`
- else `requiredKeepFraction = targetTokens / estimatedHistoryTokens`
- `selectedRatio = clamp(requiredKeepFraction, 0.3, 0.7)`

### Why this is the right abstraction

It is:

- simple
- testable
- explainable to users
- aligned with existing heuristic token counting
- bounded so it will not choose extreme values accidentally

### Expected qualitative behavior

- already fits comfortably -> skip or use very light compaction
- slightly too large -> ratio near `0.7`
- moderately over target -> midrange ratio
- far too large -> ratio near `0.3`

## Query construction design

Do not use the raw last user message blindly.

Instead, build a normalized query from:

- explicit current goal when available
- otherwise the latest user-authored task/request text after stripping timestamp wrappers
- optionally a short synthesized task label derived from the current explicit compaction goal

This matters because some user messages contain pasted docs, transcripts, or secrets, which make poor Morph queries.

## Abstractions to add

Recommended new modules:

- `packages/coding-agent/src/morph-compaction-mode.ts`
  - mode type
  - parser
  - mode application
- `packages/coding-agent/src/morph-compaction-strategy.ts`
  - strategy selector
  - effective-mode logic
- `packages/coding-agent/src/morph-compaction-projector.ts`
  - Mu history -> Morph request shapes
  - query builder
- `packages/coding-agent/src/morph-compaction-ratio.ts`
  - pure ratio selection helper

Whether these end up as four files or fewer is an implementation detail; the important part is keeping these concerns separate.

## Tradeoffs

### Tradeoff 1: correctness vs maximum Morph usage

- Hybrid strategy favors correctness.
- Morph-first-everywhere favors uniformity and simpler product messaging.

Recommendation: correctness first.

### Tradeoff 2: text projection fidelity vs implementation simplicity

- Flattening tool calls and tool results into text is simple and works with Morph.
- It loses structure compared with native provider compact inputs.

Recommendation: accept this tradeoff on Morph paths, but keep native replay path when structure matters.

### Tradeoff 3: exact tokenizer accuracy vs heuristic speed and availability

- Exact tokenizer parity per provider is expensive and brittle.
- Heuristic estimates are already how Mu thinks about handoff sizing in several places.

Recommendation: use heuristics for policy selection; do not block on exact tokenizers.

## What matters most

In priority order:

1. Session resume correctness
2. Predictable user control over Morph compaction policy
3. Safe automatic selection in `auto` mode
4. Dynamic ratio selection that is stable and explainable
5. Broad Morph usage where safe

## Human approval requested

Please approve the following architecture choices before implementation:

1. **Boundaries**
   - separate `/morph-compaction` from `/compact`
   - separate strategy selection from request projection and ratio selection

2. **Abstractions**
   - explicit mode module
   - explicit strategy selector
   - explicit projection helper
   - explicit ratio helper

3. **Tradeoffs**
   - choose hybrid compaction strategy over Morph-always
   - use heuristic token estimates rather than exact tokenizers

4. **What matters**
   - prioritize resume correctness over maximizing Morph usage

## Approval status

- status: pending human approval

