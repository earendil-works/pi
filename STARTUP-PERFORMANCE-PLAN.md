# Startup Performance Optimization Plan

## Goal

Reduce perceived and measured startup time for Pi significantly, especially:

- interactive TUI startup
- RPC startup / resume

Primary user-facing objective:

- the app should become usable quickly
- users should be able to type or issue RPC requests without paying for unrelated startup work

## Constraints

This plan is intentionally incremental and review-friendly.

- No large architectural rewrite up front
- No dedicated alternate entrypoint refactor as phase 1
- Prefer small, measurable patches
- Preserve behavior where possible
- Improve import graph by splitting modules and moving work later
- Avoid front-loading optional work before first usable state

## Profiling Workflow

Use the same reproducible startup scenarios before and after each optimization. The point is to compare profiles with the same workload, not to rely on subjective feel.

## Built-in startup profiler scripts

The startup profiler is now script-driven so an agent can run it in a tight optimization loop without hand-driving the CLI.

From the repo root, use:

### TUI startup

Node / built dist entrypoint:

```bash
npm run profile:tui
```

Bun / TypeScript entrypoint:

```bash
bun run profile:tui
```

### RPC startup

Node / built dist entrypoint:

```bash
npm run profile:rpc
```

Bun / TypeScript entrypoint:

```bash
bun run profile:rpc
```

### What these scripts do

#### `npm run profile:tui`

- builds `packages/coding-agent`
- profiles the built Node entrypoint `packages/coding-agent/dist/cli.js`
- uses the normal configured agent dir by default, so models, auth, settings, extensions, skills, and themes match a real user run
- still passes `--no-session` so benchmark runs do not create or mutate persistent sessions
- waits until the interactive UI reaches first usable state
- exits cleanly so Node flushes the `.cpuprofile`
- writes profiles to `profiles-node/`

#### `npm run profile:rpc`

- builds `packages/coding-agent`
- profiles the built Node entrypoint `packages/coding-agent/dist/cli.js --mode rpc`
- uses the normal configured agent dir by default
- starts a real RPC process
- sends a real `get_state` request
- measures startup until that `get_state` response arrives
- closes stdin so the RPC process exits cleanly and flushes the `.cpuprofile`
- writes profiles to `profiles-node/`

#### `bun run profile:tui`

- profiles `packages/coding-agent/src/cli.ts` directly with Bun
- uses the same benchmark flow as the Node TUI script
- writes profiles to `profiles-bun/`

#### `bun run profile:rpc`

- profiles `packages/coding-agent/src/cli.ts --mode rpc` directly with Bun
- uses the same RPC `get_state` measurement flow as the Node RPC script
- writes profiles to `profiles-bun/`

## Default benchmark behavior

The profiler defaults are intentionally optimized for iterative agent work:

- `--runs 1`
- `--warmup 0`
- controlled mode by default (`PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`)
- compact output
- prints the selected `.cpuprofile` path at the end

With a single measured run, the most important outputs are:

- wall-clock startup elapsed time
- selected profile path to inspect

For multiple runs, the script prints elapsed min/median/avg/max and selects the slowest measured run's profile for inspection.

## Recommended agent optimization loop

The intended loop is:

1. make one small startup-related change
2. run one benchmark for the relevant mode
3. inspect the selected `.cpuprofile`
4. compare elapsed time against the previous run
5. repeat

Examples:

```bash
npm run profile:tui
npm run profile:rpc

bun run profile:tui
bun run profile:rpc
```

When you want more stable timing comparisons, increase the run count explicitly:

```bash
npm run profile:tui -- --runs 3
npm run profile:rpc -- --runs 3
```

Use one run for hotspot discovery. Use multiple runs only when validating a claimed before/after timing improvement.

## Script options

The profiler script supports both runtimes and both modes via the same option set:

- `--mode tui|rpc`
- `--runs <n>`
- `--warmup <n>`
- `--profile-dir <dir>`
- `--label <name>`
- `--runtime node|bun|auto`
- `--no-offline`
- `--skip-build` (Node only)
- `--agent-dir <dir>`
- `--isolated-agent-dir`

Important defaults:

- by default the benchmark uses the normal configured `PI_CODING_AGENT_DIR`
- use `--agent-dir <dir>` only when you intentionally want a different config root
- use `--isolated-agent-dir` only when you intentionally want a fully clean benchmark environment

## Recommended benchmark scenarios

Collect profiles for these scenarios consistently:

1. TUI startup, controlled
2. TUI startup, real-world
3. RPC startup, controlled
4. RPC startup, real-world

Controlled examples:

```bash
npm run profile:tui
npm run profile:rpc
```

Real-world examples:

```bash
npm run profile:tui -- --no-offline
npm run profile:rpc -- --no-offline
```

If a change specifically targets one area, capture that scenario first, but keep at least one controlled benchmark for comparison over time.

## Why use both controlled and real-world benchmarks

Controlled benchmarks help isolate import-graph and CPU startup cost by removing network variance.

Real-world benchmarks validate that improvements still hold when:

- version checks are enabled
- package update checks run
- tool downloads/probes can occur
- network stack setup is present

## Main Findings

### 1. Startup is doing real CPU work, not mostly waiting

From the CPU profiles, the first ~2.5s are mostly busy.

#### Interactive / built Node runtime profile

- app reaches long idle/ready state at about `~2558ms`
- total sampled time: `~3941ms`
- pure idle time: `~1791ms`
- meaningful startup work before idle: `~2149ms`

Approximate startup buckets:

- General module loading/resolution: `~793ms`
- Syntax highlighting load: `~288ms`
- Network/update-check work: `~277ms`
- TypeBox/AJV setup: `~184ms`
- YAML/frontmatter parsing: `~111ms`
- Tool checks (`fd`/`rg`): `~109ms`
- Extension loader / `jiti` + Babel: `~91ms`

### 2. RPC startup is paying for too much unrelated code

From the RPC profiles:

- first `2500ms`: `~2115ms` non-idle in one run
- first `2500ms`: `~2235ms` non-idle in another run

The dominant cost is not session resume itself. It is mostly:

- Node ESM/CJS loader work
- package scope / package.json lookups
- filesystem probing/stat calls
- parsing and compiling modules

This strongly suggests import-graph cost is the main issue.

### 3. Session-file loading is not the main bottleneck

Session resume/history reconstruction appears relatively small compared to loader/import cost.

### 4. Interactive-only dependencies are leaking into non-interactive startup

The main smell is that RPC/core paths are pulling in interactive/theme/highlighting code. Even without a large entrypoint refactor, this can be improved incrementally by narrowing imports.

## Optimization Principles

1. **First usable state wins over background completeness**
   - users should be able to type or send an RPC request before optional work finishes

2. **Do not pay for optional features at startup**
   - syntax highlighting
   - version/package update checks
   - tool downloads/probing
   - expensive validation/setup not needed immediately

3. **Split heavy modules instead of redesigning everything**
   - move heavy imports out of widely imported modules
   - keep runtime/lightweight helpers separate from optional extras

4. **Measure after every change**
   - keep changes small and profile after each patch

## Ranked Optimization Work

## Priority 1: Stop pulling syntax-highlighting stack into hot startup

### Problem

`theme.ts` is a wide dependency surface, but it currently drags in syntax-highlighting work.

Observed cost:

- `cli-highlight`: `~288ms`
- `highlight.js`: `~226ms`
- language registration also shows up directly in profile

### Plan

Split theme responsibilities into smaller modules.

Suggested shape:

- `theme.ts`
  - global theme state
  - `Theme` class
  - color helpers
  - `initTheme`, `setTheme`, `getResolvedThemeColors`
- `theme-highlighting.ts`
  - `highlightCode`
  - highlighting-specific markdown helpers
  - imports `cli-highlight`
- `theme-validation.ts` or `theme-loader.ts`
  - parsing/validation helpers
  - imports TypeBox/AJV machinery if still needed there

### Expected outcome

Code that only needs theme state or colors should no longer pay for:

- `cli-highlight`
- `highlight.js`
- language registration

### Why this is likely reviewable

- no dynamic-import based redesign required
- behavior remains the same
- mostly import-graph cleanup and module extraction

## Priority 2: Move startup network checks out of the critical path

### Problem

Startup currently triggers network-related work very early:

- version check
- package update check
- associated `undici`/TLS setup

Observed cost:

- network/update-check bucket: `~277ms`
- `undici` subtree is highly visible in startup profile

### Plan

Delay these checks until after the first usable state.

Recommended order:

- first render / first usable editor state
- then schedule background checks
- optionally after first user input instead of immediately after startup

Candidate work to defer:

- `checkForNewVersion()`
- `checkForPackageUpdates()`
- tmux keyboard setup warning check if not essential for initial interaction

### Additional cleanup

Reduce universal `undici` startup cost by moving network bootstrap closer to the codepaths that actually need it.

### Expected outcome

- lower startup CPU churn
- less module-loading overhead up front
- snappier perceived startup even if checks still happen later

## Priority 3: Defer `fd` / `rg` availability work until after interactivity

### Problem

Startup currently waits for:

- `ensureTool("fd")`
- `ensureTool("rg")`

Observed cost:

- tool checks: `~109ms`
- `spawnSync` is clearly visible in profile

### Plan

Do not block first usable state on these tools.

Recommended behavior:

- app becomes interactive immediately
- start background readiness for `fd` and `rg`
- if user triggers autocomplete/grep before readiness completes, block at first use there instead

User-approved tradeoff:

- it is acceptable if first autocomplete or first grep waits
- it is not acceptable to delay initial typing/editor readiness

### Expected outcome

- improved time-to-first-keystroke
- easier to hide tool download/probe latency behind already-usable UI

## Priority 4: Continue removing TypeBox/AJV work from hot startup paths

### Problem

TypeBox/AJV still shows up prominently in startup.

Observed cost:

- validation/setup bucket: `~184ms`

One conservative candidate improvement is:

- defer `TypeCompiler.Compile(ThemeJsonSchema)` in `theme.ts`

### Plan

Profile current startup with the existing code, then identify what AJV/TypeBox work remains in startup.

Likely candidates:

- theme parsing/validation still on startup path
- model/config validation on startup path
- validation for resources not needed immediately

### Strategy

- keep validation behavior where possible
- move validation later when not required for first usable state
- split validation-heavy modules away from lightweight runtime modules

## Priority 5: Narrow RPC/core dependencies on interactive/theme code

### Problem

RPC startup appears to be paying for interactive-oriented imports.

Even without a large entrypoint refactor, this can be reduced by removing obvious cross-layer dependencies.

### Plan

Target small, reviewable dependency cleanups:

1. `rpc-mode.ts` should not import interactive theme code unless absolutely necessary
2. `agent-session.ts` should not depend on interactive presentation helpers if plain data/plain strings suffice
3. presentation formatting should live in interactive-facing layers where possible

### Goal

Without changing the whole startup architecture, reduce how much interactive-only code leaks into:

- RPC mode
- core session/runtime paths

### Expected outcome

- better RPC startup
- smaller import graph for non-interactive modes
- less accidental pull-in of highlighting/TUI/theme extras

## Priority 6: Defer resource loading not needed for first usable state

### Problem

Resource discovery/loading and YAML/frontmatter parsing are visible in startup.

Observed cost:

- YAML/frontmatter parsing: `~111ms`
- additional resource loading also contributes

### Plan

Audit what truly must be ready before the user can interact.

Possible candidates to defer:

- some skill loading
- some prompt-template loading
- some metadata/indexing work
- nonessential resource refresh work

### Important note

This should be done after the higher-value startup import cleanup, otherwise the profile remains noisy and harder to interpret.

## Priority 7: Reduce general import-graph pressure systematically

### Problem

The largest bucket is still overall Node module loading/resolution.

Observed cost:

- module loading/resolution: `~793ms`

Symptoms include:

- `internalModuleStat`
- `getPackageScopeConfig`
- `lstat`
- `compileSourceTextModule`
- `parseCJS`
- `getNearestParentPackageJSON`

### Plan

Audit top-level imports in startup-critical modules and move optional work into narrower modules.

Priority files to inspect:

- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/resource-loader.ts`

### Expected outcome

This is the long-term structural win, but it should be tackled incrementally through the smaller work items above.

## Proposed Patch / PR Sequence

### PR 1: Split syntax highlighting out of `theme.ts`

Scope:

- move `highlightCode` and highlighting-specific helpers into `theme-highlighting.ts`
- keep `theme.ts` lightweight

Why first:

- high impact
- low conceptual risk
- directly targets one of the biggest startup costs

### PR 2: Defer startup checks until after first usable state

Scope:

- move version check out of critical path
- move package update check out of critical path
- move tmux keyboard setup warning check later if safe

Why second:

- easy user-visible win
- low risk
- does not require import-graph redesign

### PR 3: Defer `fd`/`rg` readiness until after interactivity

Scope:

- startup no longer blocks on `ensureTool()`
- first use may wait if background readiness is incomplete
- use UI-safe notification behavior rather than background `console.log()` noise

### PR 4: Re-profile and remove remaining AJV startup work

Scope:

- rebuild after PRs 1-3
- identify remaining validation-heavy startup paths
- move nonessential validation later

### PR 5: Remove interactive theme dependency from RPC mode

Scope:

- replace interactive-theme-based formatting with plain formatting if possible
- keep change narrow and explicit

### PR 6: Reduce interactive presentation leakage from `agent-session`

Scope:

- move formatting concerns outward where feasible
- keep core logic presentation-agnostic where practical

### PR 7: Defer nonessential resource loading/indexing

Scope:

- postpone noncritical skill/prompt/resource work until after first usable state

## Measurement Plan

After each patch:

1. rebuild the relevant package(s)
2. record a fresh CPU profile
3. compare:
   - time to first usable state / first idle plateau
   - non-idle CPU in first 2500ms
   - presence/absence of specific heavy modules in startup profile

### Metrics to extract from each profile

At minimum, extract these numbers for every profile:

- total sampled time
- idle time
- non-idle CPU in first `2500ms`
- time until the first long idle plateau / first usable state
- top self-time frames
- top inclusive-time frames
- categorized startup buckets, for example:
  - module loading/resolution
  - syntax highlighting
  - network/update checks
  - validation/setup
  - YAML/frontmatter parsing
  - tool readiness/probing
  - resource loading

The most useful comparison is a before/after table for the same benchmark scenario.

### Recommended helper script outputs

A small analysis script is worth having because manual DevTools inspection does not scale well across many runs.

Suggested script outputs:

- profile file name
- total sampled milliseconds
- idle milliseconds
- non-idle milliseconds in first `2500ms`
- first long idle plateau start time
- top 20 self-time frames
- top 20 inclusive-time frames
- categorized bucket totals

### Current helper script

This workflow is now implemented by:

- `scripts/profile-coding-agent-node.mjs`
  - supports Node and Bun runtime selection
  - supports TUI and RPC startup scenarios
  - builds `packages/coding-agent` automatically for Node runs
  - profiles `dist/cli.js` for Node and `src/cli.ts` for Bun
  - writes profiles to `profiles-node/` or `profiles-bun/`
  - prints the selected `.cpuprofile` path for the next analysis step

A future follow-up script is still worthwhile:

- `scripts/analyze-cpuprofile.(py|mjs)`
  - summarizes `.cpuprofile` files into stable numeric output for comparison

That analyzer should stay generic and scenario-driven rather than embedding a single machine-specific workflow.

### Key success metrics

For interactive startup:

- reduced time to first usable editor state
- reduced non-idle CPU in first `2500ms`
- `cli-highlight` / `highlight.js` absent from startup unless actually needed
- version/package checks no longer visible before first usable state

For RPC startup:

- reduced non-idle CPU in first `2500ms`
- reduced interactive/theme-related imports in startup profile
- request handling becomes closer to session-resume cost rather than app-boot cost

## Non-Goals for Phase 1

These may be worthwhile later, but are not the first optimization targets:

- large startup architecture rewrite
- dedicated RPC entrypoint split as the first patch
- shutdown-path optimization
- TUI render micro-optimization
- tiny low-value filesystem tweaks before import-graph cleanup

## Expected Wins

Conservative expectation from the first few changes:

- splitting highlighting out of hot startup: large win
- deferring update checks: meaningful win
- deferring tool readiness: smaller but user-visible win
- removing remaining validation/import-graph weight after re-profile: additional meaningful win

Combined, these should materially improve startup feel without requiring a large refactor.

## Immediate Recommendation

Start with these three changes in order:

1. split syntax highlighting out of `theme.ts`
2. defer startup network/update checks until after first usable state
3. defer `fd` / `rg` readiness until after interactivity

Then re-profile before making the next wave of changes.
