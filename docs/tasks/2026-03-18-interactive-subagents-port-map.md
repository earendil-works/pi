# Interactive Subagents Port Map

## What

Evaluated `HazAT/pi-interactive-subagents` against the current local subagent and plan-mode stack in `pi-mono`, then turned the result into a file-level port plan.

## Why

The external repo adds a better interactive terminal UX, but it also duplicates core orchestration you already have. The goal is to port only additive pieces and avoid replacing stronger local behavior.

## Changed

Created this file as the working port map and decision record.

## Verified by

- `gh api repos/hazat/pi-interactive-subagents/...`
- `rg -n ... packages/coding-agent/examples/extensions/...`
- `nl -ba ... | awk ...`

No code changes were made in this step.

---

## Current Local Baseline

These existing files already cover the core orchestration surface:

- `packages/coding-agent/examples/extensions/subagent/index.ts`
  - Isolated `pi` child-process execution in JSON mode.
  - Supports `single`, `parallel`, and `chain`.
  - Has bounded parallelism and rich result rendering.
- `packages/coding-agent/examples/extensions/subagent/agents.ts`
  - Discovers user and project agents.
  - Supports override hierarchy.
- `packages/coding-agent/examples/extensions/plan-mode/index.ts`
  - Owns `/plan`, `/todos`, phased plan generation, plan gating, execution waves, and verification.
- `packages/coding-agent/examples/extensions/plan-mode/prompts.ts`
  - Already routes planning through `subagent` for `memory`, `explore`, `librarian`, `metis`, and `momus`.

This means the external repo should not replace your planner or your main `subagent` execution model.

---

## Port Now

### 1. `pi-extension/subagents/cmux.ts`

Status: `PORT MOST OF IT`

Why it matters:

- This is the main additive capability.
- It gives you pane creation, pane splitting, mux detection, title updates, screen reads, and exit polling for `cmux`, `tmux`, and `zellij`.

What to keep:

- mux detection and preference selection
- `createSurface()` / `createSurfaceSplit()`
- `renameCurrentTab()` / `renameWorkspace()`
- `sendCommand()`
- `readScreen()` / `readScreenAsync()`
- `closeSurface()`
- `pollForExit()`
- shell helpers such as `shellEscape()` and `exitStatusVar()`

How it should land:

- Add a new mux helper module under `packages/coding-agent/examples/extensions/subagent/`.
- Keep this separate from the current JSON-mode runner.
- Treat it as an optional transport, not the default execution model.

Recommended shape:

- Add a transport split inside the local subagent extension:
  - `transport: "json" | "pane"`
- Default stays `json`.
- Interactive flows such as `/iterate` should use `pane`.

Do not do:

- Do not replace the current JSON-mode implementation for normal autonomous work.
- Do not make mux a hard dependency for `subagent`.

### 2. `pi-extension/subagents/session.ts`

Status: `PORT PARTIALLY`

Why it matters:

- Needed for resumable pane sessions and summary extraction from session files.

What to keep:

- `getLeafId()`
- `getEntryCount()`
- `getNewEntries()`
- `findLastAssistantMessage()`

What to skip for now:

- `appendBranchSummary()`
- `copySessionFile()`
- `mergeNewEntries()`

Reason:

- Your current flow does not need branch-summary writes yet.
- Resume and summary extraction are the immediate value.

How it should land:

- Add a small session helper module under `packages/coding-agent/examples/extensions/subagent/`.
- Keep it focused on reading existing `.jsonl` sessions.

### 3. `pi-extension/subagents/subagent-done.ts`

Status: `PORT AS-IS OR INLINE`

Why it matters:

- This gives pane-mode autonomous agents an explicit self-termination tool.
- Without it, pane-mode agents rely only on shell exit behavior.

How it should land:

- Add it next to the new mux transport helpers.
- Load it only for pane-mode child sessions.

### 4. `pi-extension/subagents/index.ts`

Status: `PORT SELECTIVELY`

This file should not be adopted wholesale. It mixes genuinely useful UX with behavior you already implement better.

Keep from it:

- `/iterate`
  - Worth porting.
  - Best use of pane-mode plus `fork: true`.
- `subagent_resume`
  - Worth porting.
  - Useful when a pane session is interrupted or needs follow-up.
- `set_tab_title`
  - Worth porting.
  - Can improve both planner and execution visibility.
- progress model ideas for pane-mode tasks
  - elapsed time
  - session message count
  - session byte growth

Do not port directly:

- the external `subagent` tool implementation
  - It would conflict with the current local `subagent` semantics.
- `parallel_subagents` as a separate tool
  - You already have parallel mode in the local `subagent` tool.
  - If desired, port only the pane tiling/progress ideas into the existing parallel mode later.
- `subagents_list`
  - You already have better agent discovery logic in `agents.ts`.
- `/subagent`
  - Low value, mostly convenience sugar.
- `/plan`
  - Must not be imported.
  - It duplicates and weakens your current plan-mode flow.

Recommended landing strategy:

- Extend the current local `subagent` tool rather than replace it.
- Add a pane-mode branch only for:
  - interactive `/iterate`
  - resume
  - future live-review sessions if needed

### 5. `pi-extension/session-artifacts/index.ts`

Status: `PORT`

Why it matters:

- This is the second best addition after mux support.
- It gives session-scoped artifact persistence under `~/.pi/history/<project>/artifacts/<session-id>/`.
- It is a clean handoff mechanism between agents and between sessions.

What to keep:

- `write_artifact`
- `read_artifact`
- path safety checks
- current-session-first lookup, then recent sessions fallback

How it should land:

- Add as a separate extension, not inside `plan-mode`.
- Then update plan-mode prompts to tell research and planning subagents to persist structured outputs there.

Best uses in your system:

- planner writes plan drafts
- scout/explore writes context summaries
- reviewer writes structured findings
- resume flows reopen previous work products cleanly

---

## Skip

### 6. `pi-extension/subagents/plan-skill.md`

Status: `SKIP`

Reason:

- Duplicates your local `/plan` and plan-mode behavior.
- The external planning flow is simpler and less aligned with your current gating model.
- Importing it would create another planning entry point with different assumptions.

### 7. `agents/planner.md`

Status: `SKIP`

Reason:

- You already have a stronger custom planner flow in `plan-mode`.
- This would compete with your existing Prometheus-style planning layer.

### 8. `agents/scout.md`

Status: `SKIP`

Reason:

- You already route discovery through your existing agent roster and prompts.
- If the prompt ideas are good, copy phrasing only, not the file.

### 9. `agents/worker.md`

Status: `SKIP`

Reason:

- You already maintain your own worker behavior and model mapping.

### 10. `agents/reviewer.md`

Status: `SKIP`

Reason:

- You already have a reviewer role and plan-mode verification flow.

### 11. `agents/visual-tester.md`

Status: `SKIP FOR NOW`

Reason:

- Potentially useful later, but unrelated to the terminal UX gap that prompted this review.
- Port only if you intentionally want a dedicated visual QA agent.

### 12. `package.json`

Status: `SKIP`

Reason:

- Not relevant to local integration.
- Your repo already owns package structure and dependency management.

### 13. `test/test.ts`

Status: `SKIP`

Reason:

- Not directly reusable.
- If you port the mux layer, write tests against your local extension API and session model.

---

## Recommended Integration Order

### Phase 1

Add pane primitives without changing behavior:

- port `cmux.ts`
- port the minimal read-only parts of `session.ts`
- port `subagent-done.ts`
- add `set_tab_title`

Goal:

- prove mux integration works
- no planner changes yet

### Phase 2

Add interactive session features:

- add `/iterate`
- add `subagent_resume`
- add pane-mode transport to the local `subagent` extension

Goal:

- keep normal autonomous subagents on JSON transport
- use pane transport only where live interaction is a clear advantage

### Phase 3

Add artifact persistence:

- port `write_artifact`
- port `read_artifact`
- update plan-mode prompts to use artifacts for handoff and recall

Goal:

- make plans, context, and reviews resumable across sessions

### Phase 4

Optional polish:

- port pane tiling ideas from `parallel_subagents`
- expose a simple `/subagent-resume` slash command if needed
- add progress titles to plan-mode phase transitions

---

## Hard Rules For Integration

- Do not replace `packages/coding-agent/examples/extensions/subagent/index.ts`.
- Do not replace `packages/coding-agent/examples/extensions/plan-mode/index.ts`.
- Do not import the external `/plan`.
- Do not import the external planner/worker/reviewer agent files.
- Do not make mux required for existing autonomous subagent flows.

The external repo is a UX donor, not a new orchestration source of truth.

---

## Concrete Recommendation

Port these external files:

- `pi-extension/subagents/cmux.ts`
- `pi-extension/subagents/session.ts` (partial)
- `pi-extension/subagents/subagent-done.ts`
- `pi-extension/session-artifacts/index.ts`

Port selected behaviors from this file:

- `pi-extension/subagents/index.ts`
  - `/iterate`
  - `subagent_resume`
  - `set_tab_title`
  - pane progress reporting ideas

Do not port these files:

- `pi-extension/subagents/plan-skill.md`
- `agents/planner.md`
- `agents/scout.md`
- `agents/worker.md`
- `agents/reviewer.md`
- `agents/visual-tester.md`
- `package.json`
- `test/test.ts`

---

## Next Implementation Cut

If you want the first real integration pass, the safest change set is:

1. add mux helpers under `packages/coding-agent/examples/extensions/subagent/`
2. add `subagent_resume`
3. add `/iterate`
4. add `set_tab_title`

That gives you the visible upgrade without destabilizing your current planner or autonomous execution flow.
