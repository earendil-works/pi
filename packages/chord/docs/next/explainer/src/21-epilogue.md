
# What's Next {.epilogue lede="Where Chord v2 stands, what is still undecided, and where the written sources disagree with each other."}

The guide built Studio from one object to a p2-sized app. Every piece used the same few rules: one owner per thing,
factories that only declare, state that changes only in transactions, long-lived behaviour in declared forms, and
mappings and migrations owned by the provider. Those rules are what let Mario press Reload on his phone in the
preface while the agent keeps running. This last chapter says how much of that exists and what is still open.

## Status

:::stats
- ~10k | lines in the frozen first kernel (steps 1 to 6, 443 tests), kept as a reference only
- 1 of 11 | layers of the rebuild started: L1 contracts, built and reviewed
- 6–7k | target size of Chord v2 without tests
:::

- **The design is decided** except the points marked below. `packages/chord/docs/next/design.md` is the target;
  `packages/chord/docs/next/decisions.md` is the log and wins where they differ.
- **The rebuild** goes layer by layer, each with a one-page spec the owner approves, a minimal build with counting and
  garbage-collection tests, the cost-guard metrics, and a cleanup loop: L1 data and contracts; L2 readable and
  derive; L3 documents and store; L4 objects; L5 references and `ctx`; L6 protocol and links; L7 relay, routes,
  revocation; L8 routines and jobs; L9 registries; L10 reload and rollout; L11 telemetry in Chord.
- **Built:** the contract layer (`src/next/contracts/`, commit `7d2bb8ea8`, chapter XVI). In pi: Delta,
  `pi-telemetry`, `chord/context`, `chord/telemetry-sqlite`, pi-ai and Durable telemetry, Durable's required
  `checkpointWhen`.
- **Next, in order** (`apps/p2/docs/p3-handoff.md`): decide Q12 and Q15, which the L1 spec needs; write the spec for
  the rest of L1 (values, inputs and identity, argument checks, principals, errors; draft in
  `packages/chord/docs/next/layer-1.md`); then Q11, Q13, Q14 and the cuts C3 to C17 before the layers they affect.
- **In pi:** `mapShared` and bytes as atomic leaves in Delta's `diffRevisions`.
- **Then** the playground web shell (React, esbuild) with the reload control and a preview at `p3.mariozechner.at`,
  and the first real proof: the harness, one tool with an approval pause, a code mode reload. Then the HTTP and
  channel components, then p3, domain by domain.

## Deferred decisions

Kept with stable numbers in `design.md` §26, each waiting for a concrete case:

| # | Topic | When | Chapter |
| --- | --- | --- | --- |
| 9 | jobs as objects: a record inside the owner, or an object addressed by its id | when login is ported | XI, XIX |
| 11 | where a flow lives: a keyed document of its owner, or an object `LoginFlow { id }` | when login is ported | XII |
| 14 | project plugins: per-directory plugins with trust prompts and snapshots | own pass over `plugin-loading.md` | XV |
| 16 | a Durable Object profile | when a DO target becomes concrete | |
| 17 | session files: one `SessionFiles { session }` owner on the server (proposed) | p3 design | XX |
| 18 | session delete: retire by tag plus a session directory, or owner hooks | p3 design | XIX |
| 20 | connection pools: one owner of SSH connections per environment, or per-use connections | p3 design | XX |
| 21 | config files with a single writer: one owner on the server, others follow | p3 design | XVIII |
| 22 | file formats (`envs.json`, downloads, uploads) as versioned interfaces | p3 design | XX |
| 23 | the terminal host process: inside the revision or deliberately outside | p3 design | XX |

## Open from review round 3

Decisions (`apps/p2/docs/p3-reviews/v2-review3-summary.md`; Q1 to Q10 are decided):

| # | Problem | Proposal |
| --- | --- | --- |
| Q11 | a singleton that does not exist yet: `undefined` or `initial()`? | singletons read `initial()`; `undefined` only for absent keyed documents |
| Q12 | stripping arguments (R7) against "nothing is copied" | copy on change: a new object only when the argument had extra fields; never mutate the caller's value (proposed in the L1 draft) |
| Q13 | `ctx.incarnation` on relayed calls | relays stamp the origin host's incarnation, as they stamp the principal |
| Q14 | a writable holding functions exposed as a state member | only members with a JSON schema in the contract are exposable, checked at serve |
| Q15 | arguments of `local` methods: validated or not | apply R7 to `local` too, or keep `local` as the one exception |

Cuts the owner may choose (each removes a primitive this guide teaches):

| # | Cut | What it costs |
| --- | --- | --- |
| C3 | shrink jobs to a runner over documents (no versions, `accepts`, `blocked`, `persist`), or move jobs out of the kernel | job versioning, or `self.job` for core-only users |
| C4 | routines: `on` and `loop` only | `every`'s due time across reloads |
| C5 | merge `lifetime: "host"` objects into the facet | a plugin's always-on natives share one failure domain |
| C6 | remove `broken()` for opens and `retryOn` | nothing; reload and Retry still work |
| C7 | remove provider-side `linger` | ten lines of app code |
| C8 | remove `state: false` (method-only references) | a method-only consumer pays one snapshot |
| C9 | remove `previous` from derives | derives that used it move to `mapShared` |
| C10 | one `cell(initial)` for `constant` and `writable` | nothing |
| C11 | remove `ctx.trace` (use `traceIn(ctx, …)`) | nothing |
| C12 | remove call credits (the byte window covers calls) | nothing |
| C13 | two timeouts (`closeTimeout`, `readyTimeout`) instead of eight | per-thing overrides |
| C14 | remove the `handle.change` and `handle.retire` shorthands | nothing |
| C15 | remove `inVariant` and `expectVariant` (keep `RefIn`) | nothing |
| C16 | remove facet-owned mutable documents and their transaction exception | atomic writes across an object and its facet move to one owner |
| C17 | no harness-specific start-barrier exception | factories before the barrier cannot depend on the harness |

## Where the sources disagree

This guide follows the decision log where it is newer than the design, and the design where it is newer than
everything else. The places that need a fix in the sources:

:::review | Review: drift in the written sources
- `design.md` §26 lists only the deferred decisions; it omits the open review-3 items Q11 to Q15 and the cuts C3 to
  C17.
- `design.md` §3 has a garbled sentence, "Values are method arguments are stripped".
- `apps/p2/docs/p3-handoff.md` §3 is stale: it says all R items are decided and, two lines later, that R2 to R5 and
  R7 to R26 are open, and "resume R6 next".
- `kernel.md` and `step-*.md` describe the frozen code: host values, a development freeze, consumer-side linger,
  JSONL storage, descriptions on the wire, and a link closed on an unknown id. None of these is the target.
- `chord-next-walkthrough.md` lags the log: validation by trust (now R7, every caller), dev mode and freeze (removed
  by R9), descriptions once per link (gone with R6), an IPC frame-count window (now one byte window, Q4), job outcome
  `{ ok }` (now `{ kind }`), harness activation as the start barrier (R17), registries "newer refused at load" (Q8),
  and hooks using `host.root` (now `chord(fn, context)`, Q6).
- `apps/p2/docs/questions.md` uses `self.resource` and `replace` (both rejected) and `host.root` in hooks.
- `apps/p2/docs/p3-reviews/v2-cost-model.md`: the measurements are current, its "Decisions this needs" section is
  not (chapter XVII).
- L1's `Implementation<C>` shape differs from the factory return value used in the design (chapter XVI).
:::
