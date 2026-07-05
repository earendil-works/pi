---
description: Scan the full codebase for improvements across all areas
---

Run a comprehensive, read-only improvement audit of the whole repo. Output a single structured report covering every area below. Do not edit files.

## Scope

This repo is a TypeScript monorepo:
- `packages/ai` — unified multi-provider LLM API
- `packages/agent` (`pi-agent-core`) — agent runtime
- `packages/coding-agent` — interactive coding agent CLI
- `packages/tui` — terminal UI library

Audit each package individually and the repo as a whole. Note cross-package issues (e.g. duplicated logic in `ai` and `agent`, drift between DTOs).

## Pre-flight

1. Read `AGENTS.md`, `CONTRIBUTING.md`, root `README.md`, and each package's `README.md` and `CHANGELOG.md` `[Unreleased]`.
2. Map entry points and boundaries: `packages/*/src/index.ts`, `packages/*/package.json` `exports`.
3. Run `npm run check` and capture the full output. Every error, warning, and `info` is a finding unless already tracked.
4. Run `./test.sh` from the repo root (NOT `npm test` — that includes e2e). Capture failures.
5. Inspect `package-lock.json` and each `packages/*/package.json` for outdated / duplicated / unused deps. Direct deps must be exact-pinned per `AGENTS.md`.
6. Confirm `packages/ai/src/models.generated.ts` is not stale vs `packages/ai/scripts/generate-models.ts`. Never propose editing `models.generated.ts` directly.

## Categories

For each area: cite `path:line`, severity (P0/P1/P2/P3/P4), effort (S/M/L/XL), breaking (yes/no), and a concrete fix (a real diff, command, or specific refactor). No "consider refactoring" without saying how. If a claim can't be verified without running the app, tag it `[unverified]`.

1. Architecture & module boundaries — layering (`tui` → `agent` → `ai`), dep direction, circular deps, god-objects, leaking abstractions. Quit on the question: would a new contributor understand the call graph in 10 minutes?
2. Code quality & maintainability — duplication, complex functions (high cyclomatic / deep nesting / >~300-line files), magic strings/numbers that belong in `DEFAULT_*` constants (see keybinding rule in `AGENTS.md`), dead code, leftover `TODO`/`FIXME`, inconsistent naming. No `any` unless justified (repo rule).
3. Types & data modeling — `any`, unsafe casts, `@ts-ignore`, `eslint-disable`, missing validation at trust boundaries (provider HTTP, MCP, tool inputs), schema drift between providers and the unified message/tool types.
4. Security — secret leakage in source, prompt-injection surface across providers/tools, unsafe `eval`/template/regex, supply-chain (dep lifecycle scripts not on the `coding-agent` shrinkwrap allowlist), credential handling in `packages/ai/src/env-api-keys.ts`, sensitive data in logs/sessions, SSRF via provider URLs.
5. Performance — N+1 over provider calls, unbounded memory (history, sessions), blocking work in the TUI render loop, missing cancellation (`AbortSignal`) propagation, streaming backpressure, repeated serialization, O(n²) hot paths.
6. Reliability & error handling — swallowed errors, empty `catch`, `console.log` instead of structured handling, missing timeouts/retries/circuit-breaking for network, unhandled rejections, race conditions in the agent loop, non-atomic multi-step ops, idempotency of tool calls.
7. Testing — coverage gaps on critical paths (provider streaming, tool-call round-trip, abort, TUI diff renderer), brittle tests, missing edge cases (empty/unicode/abort/overflow), non-`harness.ts`/faux-provider usage in `packages/coding-agent/test/suite/` (repo rule violation), tests that touch real provider APIs/keys.
8. DX & tooling — `biome.json` rule drift, disabled rules without comment, missing npm scripts, pre-commit gaps, `tsconfig` path drift, codegen workflow clarity.
9. Observability — log-level hygiene, no secrets in logs, correlation/session ids, structured logs, traceability of a failed turn end-to-end.
10. Documentation — README install/run steps that actually work, public API JSDoc, `docs/` accuracy against current code, onboarding friction for a new package.
11. Configuration & environment — `.env.example` drift from real env usage, unsafe prod defaults, hardcoded values that should be env/config, per-package config hygiene.
12. Accessibility & UX (`packages/tui` and any web UI the repo ships) — see "UI/UX inspiration benchmarks" below.
13. Build, release & infra — `npm run release:local` correctness, multi-stage build caching, lockfile/shrinkwrap hygiene, CI `npm audit --omit=dev` gaps, reproducibility.
14. Dependencies — outdated, duplicated functionality, unused, lockfile/shrinkwrap consistency, `min-release-age` compliance.

## UI/UX inspiration benchmarks

`packages/tui` is a terminal UI; pi-tui uses differential rendering (a real differentiator — cite it). For subjective UI findings, anchor comparison to a recognized benchmark instead of taste. Name the principle (Laws of UX: Hick's/Fitts's/Miller's/Jakob's/Aesthetic-Usability/Von Restorff/Doherty threshold; Nielsen's 10; Gestalt; CRAP; WCAG 2.2 AA where browser UI exists).

TUI references (primary for this repo's `packages/tui`):
- `ratatui` (Rust) gallery — https://ratatui.rs/showcase/ — layout, color, widget patterns.
- `Textual` (Python) — https://textual.textualize.io — CSS-styled TUI, app structure, command palette.
- `packages/tui` itself — local reference for differential rendering; compare other TUI code in the repo against it.

Web app / product UI references (use if the repo or its docs ship browser UI):
- `shadcn/ui` — https://ui.shadcn.com — Radix-based accessible primitives, theming tokens.
- `Radix primitives` — https://radix-ui.com — focus/keyboard/popover/dialog/menu behavior.
- `Linear` — https://linear.app — dense, keyboard-first B2B SaaS benchmark; cite for perceived perf (Doherty threshold <400ms).
- `Vercel dashboard` — https://vercel.com — clean hierarchy, empty/error/loading states.
- `Resend` — https://resend.com — restrained motion, typography.
- `Stripe dashboard` — https://stripe.com — forms, tables, inline validation, payment-grade error states.
- `Raycast` — https://raycast.com — keyboard-first navigation, command palette, list UI.

How to use benchmarks:
- Concrete: "Linear's command palette matches fuzzy without exact prefix; ours rejects 'stg' for 'settings' (linear.app). [Jakob's: match user's mental model]." Not "search could be better".
- State the principle and the measurable difference; don't appeal to authority alone.
- A benchmark is a comparison anchor, not a prescription. Translate the pattern to this repo's stack. Do not invent benchmarks or attribute design choices without checking.

## Output

```
# Improve audit

## Summary
- Repo: pi @ <commit>
- Tools run: npm run check (<pass/fail counts>), ./test.sh (<pass/fail>), dep audit notes
- Headline: 2-4 sentences on the biggest themes

## Findings by package / cross-cutting

### packages/ai
- [P0/P1/P2/P3/P4][effort][breaking?] path:line
  Problem: ...
  Fix: ```diff
  // concrete fix
  ```

### packages/agent
...

### packages/coding-agent
...

### packages/tui
...

### Cross-cutting / repo
...

## Recommended order of operations
1. (P0) ...
2. ...
```

## Rules

- Read files in full before auditing them; do not rely on search snippets (repo rule).
- Cite real `path:line` only. No invented locations.
- One concrete fix per finding.
- Never propose editing `packages/ai/src/models.generated.ts` directly; propose the change to `generate-models.ts` instead (repo rule).
- Never propose adding or widening dynamic/inline imports (`await import()`, `import("pkg").Type`) in TypeScript checked by the root config (repo rule). Use top-level imports only.
- Never propose backward-compat shims unless asked (repo rule).
- Never edit files. Read-only audit.
- If a category doesn't apply (e.g. no browser UI), say so explicitly — proves it was considered.
- Be exhaustive: quantity of genuine findings is the point.
