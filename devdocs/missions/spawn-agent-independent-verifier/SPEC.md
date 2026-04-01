---
mode: build
---

# 1. Summary & Recommendation

Add an optional independent verifier flow to `spawn_agent`.

Recommended v1 design:

- `spawn_agent` accepts opt-in verification inputs
- when verification is requested, the parent first spawns the worker
- after the worker finishes, the parent spawns a separate verifier agent
- the verifier checks both correctness and adherence to the relevant `SPEC.md`
- the verifier uses the same model as the worker in v1 unless explicitly changed later
- the verifier returns a simple report: `PASS` or `FAIL`, plus concrete issues
- the parent decides whether to retry, accept, or abort

Meta-learning rule for this mission:

- this mission must practice the design before the product feature fully exists
- therefore, milestone gates and other non-trivial validation work in this mission must use independently spawned verifier agents as an internal mission rule
- this is a mission operating rule first, and a product feature second

# 2. What Must be True

- `spawn_agent` can be asked to verify a spawned task.
- Verification is optional for general tasks.
- Verification defaults to enabled for mission startups and can be explicitly opted out.
- The verifier is a separate spawned agent/session from the worker.
- Verification is sequential in v1: worker finishes before verifier starts.
- The verifier checks both:
  - correctness of the worker output
  - adherence to the mission or task specification
- When mission startup is used, the verifier can locate `SPEC.md` from `missionPath`.
- The verifier report is returned to the parent in a simple, legible form.
- The parent remains the decision-maker after verifier findings.
- Prompt and policy surfaces describe the verification behavior consistently.
- `~/.mu/agent/AGENTS.md` documents the policy for spawned-agent verification.
- This mission’s own acceptance gates use independent spawned verifiers and record their findings as evidence.

# 3. What Must Never Happen

- Worker and verifier must never share the same session or hidden working context.
- The verifier must never silently modify source files.
- The verifier must never silently “fix forward” and claim success.
- The parent must never lose access to the raw worker result because verification was requested.
- Verification findings must never be reduced to an ungrounded thumbs-up without evidence or issues.
- Mission gate tasks must never be marked done without independent verification evidence.
- The implementation must never broaden into unrelated multi-agent orchestration redesign.
- The feature must never require `npm run dev`.

# 4. Inputs / Outputs

## Input surface

- `spawn_agent({ message, verify, verificationChecks, model, reasoning })`
- `spawn_agent({ startup: { type: "mission", missionPath }, verify, verificationChecks, model, reasoning })`
- `wait_agent({ ids, timeoutMs })`

## Verification inputs

- `verify?: boolean`
- `verificationChecks?: string[]`
- `missionPath` when mission startup is used
- worker output/session details

## Success output

- worker session id and session file
- optional verifier session id and session file
- verification report with:
  - `status: PASS | FAIL`
  - `issues: string[]`

## Failure / escalation output

- clear verifier failure if verification cannot complete
- clear report when verification fails
- parent-visible decision point: retry, accept, or abort

# 5. Edge Cases

- `verify: true` with no explicit `verificationChecks`
- mission startup with missing or unreadable `SPEC.md`
- worker succeeds but verifier times out
- verifier finds issues that are warnings versus truly blocking defects
- worker output is empty or incomplete
- multiple child sessions are spawned and both worker and verifier need waiting
- verifier disagrees with the worker about a subtle requirement
- mission default verification is explicitly opted out for a startup
- prompt/policy text says one thing while runtime does another

# 6. Constraints

- Keep the v1 implementation centered on `packages/coding-agent/src/tools/spawn-agent.ts` and adjacent prompt/report surfaces.
- Keep the verifier runtime read-only with respect to repo source files.
- Use the same model as the worker for v1 by default.
- Keep v1 sequential rather than parallel.
- Keep the report shape simple: `PASS|FAIL` plus issues.
- Do not add `any` types.
- Run `npm run check` after code changes.
- Do not run `npm run dev`.
- Keep policy/doc changes scoped to the verification feature.
- Internal mission rule: before accepting any milestone gate, spawn an independent verifier agent that checks the slice against this `SPEC.md`, the milestone contract, and the observed evidence.

# 7. Definition of Done

- `spawn_agent` exposes verification inputs with documented semantics.
- Mission startups default to verification-on unless explicitly disabled.
- The worker and verifier run as separate child sessions.
- The verifier reads `SPEC.md` from `missionPath` when mission startup is used.
- The parent receives a simple verification report.
- The runtime keeps parent control after verifier findings.
- Tool descriptions and short system-prompt descriptions are updated.
- `~/.mu/agent/AGENTS.md` is updated to describe the policy.
- Targeted tests prove schema/defaulting, verifier sequencing, report shape, and prompt/policy consistency.
- `npm run check` passes after implementation.

# 8. Verification Contract

## Red checks

- `spawn_agent` does not yet accept verification inputs.
- Mission startup does not yet default verification on.
- No independent verifier child is orchestrated after worker completion.
- No simple verification report is returned to the parent.
- Prompt/policy text does not yet fully describe the behavior.

## Green checks

- Targeted contract tests pass for verification inputs and defaults.
- Runtime tests pass for sequential worker → verifier orchestration.
- Report-shape tests pass for `PASS|FAIL` plus issues.
- Prompt/policy tests pass for `tools.yaml`, `system.yaml`, and `~/.mu/agent/AGENTS.md` changes.
- `npm run check` passes.

## Internal mission verifier rule

For this mission itself:

- any milestone acceptance gate must be checked by an independently spawned verifier agent
- the verifier must review:
  - the relevant milestone contract from `MILESTONES.json`
  - this `SPEC.md`
  - the changed files or test evidence for that slice
- the verifier must return `PASS` or `FAIL` and list concrete issues
- the verifier output must be saved as mission evidence before the gate task is marked done
- if the verifier fails the slice, create follow-up fix tasks before advancing

# 9. What needs to be done to deliver the spec

- add verification fields to the `spawn_agent` tool schema and request resolution path
- define the parent-side worker → verifier orchestration flow
- define the verifier prompt contract and spec-discovery behavior
- return verifier details/report to the parent in a stable shape
- update spawned-agent reminders/reports as needed for verifier sessions
- update `packages/coding-agent/src/prompts/tools.yaml`
- update `packages/coding-agent/src/prompts/system.yaml`
- update `~/.mu/agent/AGENTS.md`
- add targeted red tests, then implement to green
- verify milestone gates using independent spawned verifier agents and save evidence under this mission directory
