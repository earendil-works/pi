# pi — design handoff

Work in numbered order. Each unit is self-contained and independently testable;
later units consume earlier ones.

```
01-harness/
  01-delta/            op vocabulary, tracker, applier, codec   [LANDED IN CHORD]
  02-scopes/           storage scopes and list tags              [STEP 1 ACTIONABLE]
  03-execenv/          bounded Shell output, capture, spill      [PRODUCTION CODE + TESTS]
  04-tool-output/      the ToolOutput sink                       [SPEC ONLY]
  05-assistant-output/ assistant partials, symmetric with 04     [SPEC ONLY]
02-plugins/
  01-facets/           the facet system                          [SPEC ONLY]
  02-sandbox/          isolated-vm membrane                      [CODE + 412 tests]
```

Base everything on a clean checkout of `origin/dev`.

## Read this first

**Three units ship working code. Four are specifications.** The table above says
which. Do not assume a doc describes something that exists.

**`01-delta/FINDINGS.md` is historical evidence, not an implementation queue.** Production lives in `packages/chord/src/delta/index.ts`: flush-time dirty tracking fixed D1, and production remeasurement closed D2. The explicit append/truncate API is rejected; see [`01-harness/01-delta/append-decision.md`](01-harness/01-delta/append-decision.md). The code beside the handoff remains prototype and benchmark evidence.

**If a doc and the code disagree, the code wins** — fix the doc and say so in the
commit.

**Port the tests before the implementation.** Each group's comment explains the
failure it guards against, and several of those failures are silent: wrong output,
no exception.

**Benchmark with `node --experimental-strip-types`, never through a transpiler.**
Measuring this module through `tsx` inflates results 2.6x. `FINDINGS.md` D5 lists
five more measurement traps, each of which produced a confident wrong conclusion.

## Unit status

| unit | ships | state |
| --- | --- | --- |
| **01-delta** | production implementation and tests in `packages/chord`; prototype evidence here | landed; D1 fixed, explicit text API rejected after production remeasurement |
| **02-scopes** | spec + [actionable Step 1 handoff](01-harness/02-scopes/implementation-handoff.md) + `scopes.variance.ts` | Step 1 scopes/list tags actionable, not implemented; JSONL Chord encoding/address interning deferred to separately approved Step 2 |
| **03-execenv** | production implementation in `packages/agent`; prototype evidence here | source-bounded adaptive output, lazy spill backpressure, and bash migration landed; bash's temporary checkpoint cadence moves to `ToolOutput` next |
| **04-tool-output** | spec + design notes | **not built.** The piece every measurement of the op encoding depends on |
| **05-assistant-output** | spec | not built. Same shape as 04; do it after |
| **02-plugins/01-facets** | spec, ~1800 lines | not built. §14 rewritten to match the sandbox PoC |
| **02-plugins/02-sandbox** | working PoC, 412 assertions | `npm install && npm run audit` |

## Suggested order

1. **`02-scopes` Step 1** — follow the [actionable implementation handoff](01-harness/02-scopes/implementation-handoff.md); stop for approval before its separate Step 2.
2. **`04-tool-output`** — reuse the landed adaptive publisher for generic tools, Chord event/durable batches, terminal flushes, and atomic memo checkpoints.
3. **05**, then **02-plugins**.

## Live bugs on `origin/dev`, independent of this design

- `drive/tools.ts:257` — `clearReplayCheckpoint` deletes `pendingToolOutput` before
  re-executing a replay-safe tool. Memos exist so a replayed tool skips work, and
  skipped work emits nothing, so output for memoised work is lost today. Seed from
  it instead (`harness-tools.md` §7.4).
- `runtime/progress.ts:44` — `commitWrite(item)` captures the value at call time
  and writes fire-and-forget, so an older checkpoint can land after a newer one.
- memo and checkpoint are two transactions (`drive/tools.ts:112` vs
  `progress.ts:44`). They must be one (`harness-tools.md` §7.5).

**Expected test churn:** nine tests assert the old cleanup write set and will fail
once `retireScope` replaces the per-address deletes. That is the change landing.

## Environment

- Node 22+ for every shipped `.ts` file. They run under
  `node --experimental-strip-types` with no build step and no dependencies.
- In the pi repo, tests run from the package:
  `cd packages/agent && npx vitest run --config vitest.harness.config.ts`.
  The root vitest config does **not** alias `@earendil-works/pi-ai`; the
  per-package harness config does.
- Typecheck with `npx tsgo --noEmit` from the repo root. **Baseline is ~788
  pre-existing errors**, almost all in `packages/ai/test`. Count only:
  `grep "error TS" | grep -E "packages/(agent|session-backends)/src"`.
- `packages/ai` cannot be built offline — model data is fetched at build time.
