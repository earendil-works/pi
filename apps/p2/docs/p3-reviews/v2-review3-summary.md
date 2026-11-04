# Chord v2 review round 3 (final): summary for the owner

Sources: `v2-review3-fable.md` (F), `v2-review3-astra.md` (A), both read from `origin/private` at `138268fa3`/`1fbadcf1e`.
Verdicts: Fable "up overall, buildable after two majors; not yet minimal"; Astra "down for final sign-off: 1 blocker,
6 majors". Nothing here is decided.

## 1. Text fixes (no decision: they apply existing decisions) (done, owner OK 2026-10-19)

| # | Fix | Source |
| --- | --- | --- |
| T1 | §3, §5 table, §27 still say "only untrusted callers are validated": apply R7 everywhere | F B1, A B1 |
| T2 | §24 still says the harness's activation is the start barrier: apply R17 | F B2, A B2 |
| T3 | §24 example passes `registry` once: pass a function reading the composed registry, like `models` | F B3 |
| T4 | §9 `Settings` and §15 `ShellResult` examples lack the required `checkpointWhen` | F B4, A B5 |
| T5 | §9 "handles may be used in transactions of their own object (or of the facet that serves it)" reverses the facet rule | A B4 |
| T6 | §21 "the registries hold everything that will be there" vs. facets retrying with backoff: soften (late contributions recompose; R17 covers it) | F B7 |
| T7 | §30 cost guard "one encode per link": count part encodes at the origin, none at relays | A B9 |
| T8 | §15 job outcome and §20 flow state are not tagged by `kind` (rule 6) | A B10 |
| T9 | §31 rejects "validating state by walking values" but R8 validates migration output once: narrow to commits | A B11 |
| T10 | §6 "same documents and natives" for pure objects (they have no natives) | F B13 |
| T11 | log entries superseded but unmarked (broken dependency, staging conflicts, per-module digest, copying arguments, `Context.telemetry: TelemetryContext`) | F B8, B12 |

## 2. Decisions, one at a time (blocker and majors first)

| # | Sev. | Problem | Proposals |
| --- | --- | --- | --- |
| Q1 (decided: ignore unknown ids on both sides) | blocker | "Unknown id closes the link" (R4) turns normal races into link resets: a `result` crossing a `cancel`, a `call` crossing `gone`, a `release` crossing a state part (F D1, A D1) | F: answer, don't punish: `call` on an unknown hold gets `result` with `gone`, `release`/`cancel` on unknown ids are ignored, only a malformed header closes. A: retiring states with terminal acknowledgements, distinguishing retired ids from never-issued ones, bounded bookkeeping |
| Q2 (decided as proposed) | major | Size limits (R2): `ws.maxPayload` closes the whole WebSocket (1009), so it cannot fail one call; one `state` message carries many holds' parts, so one big part fails all; a relayed compressed part is decoded only in the worker, where IPC has no limit (F D3, A D2) | Limits per part, from the header sizes, before decoding: an oversized part fails only its hold or call; a snapshot over the limit fails that hold without automatic re-hold. The decoded limit travels with relayed work (stamped at admission), so the worker enforces the client limit. `maxPayload` stays only as the transport's hard cap (closes the link) |
| Q3 (decided as proposed) | major | R19's re-hold waits for credits covering the snapshot size, which can never happen for a snapshot larger than the window: permanent stall (A D3) | Re-hold once the previous snapshot's debt has drained (credits back to the full window), not once credits exceed its size; keep the minimum interval |
| Q4 (decided: one binary format and byte window on every link) | major | IPC flow control counts frames, but R1 parts are bytes: memory unbounded in bytes (F B6, D5) | One byte window for every link kind, from the part sizes in the header |
| Q5 (decided: rejected; activation chain of instance ids across hosts) | major | Dependency cycles: with R18 failed dependents keep their references, so A↔B never lose their last reference (A D4) | Reject declared dependency cycles before activation waits (also cycles introduced by a reload), as a broken declaration |
| Q6 (decided: host under a context key, `chord(context, fn)`) | major | Plugin tools in Durable cannot get a Chord `ctx`: `host.root` is on the host object, which plugins never hold (F D2) | The facet's `host` gets `root(fn, { principal?, signal? })`; the core harness passes a Chord call scope to every tool execution (host principal, abort linked to the task) |
| Q7 (decided: R16 stands, 30 s at most) | major | R16: a code mode script with a 5-minute deadline, 40 s in at a reload, is killed at 30 s; its turn fails (F D4) | Dispose of the detached sandbox when its scripts finish or hit their own deadline; `closeTimeout` bounds only `close` (which returns at once). Owner said 30 s is plenty; the reviewer reopens it with this trace |
| Q8 (decided: one declaration from the defining facet; accepts stays; mismatches left out and reported; use sites guard) | major | Registry definition ownership on reload: plugin A reloads registry R with a new `compose`; unchanged plugin B still imports the old token (A D6) | The defining facet holds the one authoritative declaration; other tokens only identify the registry; a reload replaces the declaration atomically |
| Q9 (decided: unsettled runs only; the owner dedupes after completion) | major | Job dedupe and record retention have no end: 100,000 keyed jobs stay in memory, or a retried key reruns its effect (A D7) | Define the dedupe horizon (only unsettled runs, or retained completed history) with record retirement; or shrink/defer jobs (C3) |
| Q10 (decided: forward evolution in code; implemented `7d2bb8ea8`) | major | `accepts` keeps old member schemas but the old fingerprint covers the old input too: an input change cannot bind old holds (A D5, B8) | Prohibit input changes through `accepts` (a new object type instead); or remove `accepts` entirely (C2) |
| Q11 (decided: singletons always have a value) | minor | Singleton existence: §9 says an absent document reads `undefined`, also "a singleton that does not exist yet reads `initial()`" (F B11, A B3) | Singletons read `initial()` (never undefined); `undefined` only for absent keyed documents; singleton existence needs no API |
| Q12 (decided 2026-10-21: closed schemas, unknown fields rejected) | minor | Stripping arguments (R7) vs. "nothing is copied": stripping a shared object must not delete fields from it (A B7) | Copy on change: a stripped argument is a new object only when it had extra fields; never mutate the caller's value |
| Q13 (decided 2026-10-21: relays stamp the origin incarnation) | minor | `ctx.incarnation` on relayed calls is undefined: the worker's handshake is with the server (F B9) | Relays stamp the origin host's incarnation, as they stamp the principal |
| Q14 (decided 2026-10-21: only JSON readables back state members) | minor | A writable holding functions could be exposed as a state member and reach the encoder (F B10) | Only members with a JSON schema in the contract are exposable; checked when the object is served |
| Q15 (decided 2026-10-21: local arguments validated too) | minor | `local` arguments are "neither validated nor copied" in §5's table, but R7 says every caller (A B1) | Apply R7 to `local` too, or keep `local` as the one exception |

## 3. Primitives to remove or merge (owner choices)

| # | Cut | Source | What breaks |
| --- | --- | --- | --- |
| C1 (rejected, owner: `local` stays its own kind) | merge `local` into one object kind with `principals: false` | F C1 | nothing in p3 |
| C2 (moot: `accepts` stays, third-party plugins are a goal) | remove `accepts` for object types and registries (and adapted-binding diffs); strict fingerprints only, since hosts install before anything is routed | F C2, A C6 | a plugin built against an older contract fails to bind instead of being adapted |
| C3 | shrink jobs to a runner over documents (no job versions, `accepts`, `blocked`, `persist`), or move jobs out of the kernel into an optional component | F C3, A C1 | `defineJob` loses versioning; or core-only users lose `self.job` |
| C4 | routines: `on` and `loop` only (`every` a helper; a due time that must survive is a document) | F C4 (A: keep four forms over one runner) | `every`'s due time across reloads |
| C5 | merge `lifetime: "host"` objects into the facet (the facet may open natives and contribute); every served object is referenced | F C5 | a plugin's always-on natives share one failure domain |
| C6 | remove `broken()` for opens and `retryOn` (bad configuration retries with the backoff) | F C6 | nothing; reload and Retry still work |
| C7 | remove provider-side `linger` (app keeps a hold for N minutes) | F C7 | nothing; ten lines of app code |
| C8 | remove `state: false` (method-only references) | F C8 | a method-only consumer pays one snapshot |
| C9 | remove `previous` from derives (`mapShared` covers it) | F C9 | derives that used `previous` |
| C10 | one `cell(initial)` for `constant` and `writable` | F C10, A C3 | nothing |
| C11 | remove `ctx.trace` (use `traceIn(ctx, …)`) | F C11 | nothing |
| C12 | remove call credits (the byte window covers calls) | F C12 | nothing |
| C13 | two timeouts (`closeTimeout`, `readyTimeout`) instead of eight | F C13 | per-thing overrides |
| C14 | remove `handle.change`/`handle.retire` shorthands | F C14 | nothing |
| C15 | remove `inVariant`/`expectVariant` (keep `RefIn`) | F C15 | nothing |
| C16 | remove facet-owned mutable documents and the two-line transaction exception (shared data in an ordinary local object) | A C2 | atomic writes across a served object and its facet move to one owner |
| C17 (decided 2026-10-21: accepted, log "The harness is an ordinary object") | no harness-specific barrier exception: the harness is an ordinary object the app's start code holds after `load` | A C7 | pre-barrier factories cannot depend on the harness |

Implementation notes (no decision): one subscription substrate for writable, constant, derives and registry values
(A C3); one runner for routines (A C4); one lease implementation behind `host.get`/`hold`/`self.get`/`ctx.get` (A C5).
