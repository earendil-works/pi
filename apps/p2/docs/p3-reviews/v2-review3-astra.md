# Chord v2: final design review — Astra

Reviewed `origin/private` at `138268fa3`.
Read the design, decision log and round-2 summary in full;
incorporated the subsequent `host.activity` change.
This reviews the target, not the frozen implementation.

**Overall: thumbs down for final sign-off.**
The remaining problems are specific protocol, ownership and lifecycle gaps,
not a request to restore the discarded validation or copying layers.
R9, R10, R12 and R13 are treated as owner decisions, not reopened here.
All changes below are proposals.

## A. Verdict per area

- **Hosts and links — thumbs down.** Oversized-snapshot recovery can wait forever (D3).
- **Principals and revocation — thumbs up.** No new blocker beyond the explicitly accepted revocation window.
- **Object types and compatibility — thumbs down.** Old fingerprints cover more than `accepts` supplies (D5); validation rules also disagree (B1).
- **Objects and lifecycle — thumbs down.** Retained failed dependencies need an explicit cycle-rejection rule (D4).
- **References — thumbs down.** Late replies after cancellation/release lack a safe retirement protocol (D1).
- **Ctx — thumbs up.** Keep one owned call scope; fold `ctx.incarnation` from §25 into the §8 API definition.
- **Documents and store — thumbs down.** Absent singleton reads and facet access permissions contradict themselves (B3–B4).
- **Derives — thumbs up.** No new blocker; do not add a second projection engine.
- **Natives — thumbs up.** One sequential open/close lifecycle suffices; the sandbox exception needs consistent wording (B6).
- **Routines — thumbs up.** Implement the four forms over one runner, not four lifecycle engines (C4).
- **Jobs — thumbs down.** Completed-record, dedupe-key and waiter retention has no contract (D7).
- **Facets — thumbs up.** Reuse the object machinery; consider removing the cross-owner transaction exception (C2).
- **Registries, including `self.writable` — thumbs down.** The authoritative definition/composer across reloads is unspecified (D6).
- **Start data — thumbs up.** No further primitive is needed beyond an ordinary object and constant readable.
- **Reload and rollout — thumbs down.** The harness is simultaneously inside and outside the barrier (B2); registry-definition replacement is also unresolved (D6).
- **Wire — thumbs down.** D1–D3 prevent signing off the protocol.
- **Telemetry — thumbs up.** Reuse the existing adapter and span APIs; do not add another instrumentation abstraction.
- **Cost model — thumbs down.** Its counting example asserts the superseded encoding unit (B9).

## B. Contradictions

Quotes are from `design.md` unless identified as log entries.
Line numbers refer to the reviewed revision.

### B1. Validation still has three incompatible descriptions

§3, lines 237–238:
> Values are validated only where they enter from an untrusted caller

§5's table, line 288:
> validated once at the provider when the caller is not a host principal

§5, lines 312–314:
> Method arguments are always stripped to the provider's schema and validated with it, whoever the caller is

§27, line 1343:
> v1 arguments are validated against the provider's v1 schema (untrusted callers, as in section 5)

Log R7 says:
> Method arguments are always stripped to the provider's schema and validated with it (compiled once), whoever the caller is

Apply R7 consistently. Also explicitly resolve whether the table's local
“neither validated nor copied” remains an exception to the unqualified rule.
Do not let the implementation infer the trust boundary from whichever paragraph
it encounters first.

### B2. Harness activation both is and is not the barrier

§24, line 1235:
> its activation is the start barrier

§21, lines 1088–1089:
> the Durable harness starts after the barrier, it is not part of it

Log R17 chooses the latter. Remove the former and specify how app startup
expresses the ordering without a Harness-specific branch inside Chord (C7).

### B3. An absent singleton has two different values

§9, lines 548–549:
> `handle.value` / `handle.get` give `undefined` for an absent one

§9, lines 570–571:
> A singleton that does not exist yet reads `initial()` through its handle; retiring resets it to `initial()`.

These cannot both describe `handle.value`. Choose one singleton rule;
keep the keyed-document absence rule separate. This is not a request for
transactional existence checks.

### B4. The facet-document permission is reversed in one paragraph

§9, line 571:
> Handles may be used only in transactions of their own object (or of the facet that serves it).

§9, lines 580–581:
> A served object's transaction may span its own documents and its facet's documents
> the facet never reaches into a served object's documents.

The first sentence permits the forbidden direction. A served object may use
its facet's handles, not the reverse.

### B5. The opening document example violates required checkpointing

§9's complete `Settings` declaration is:

```ts
const Settings = defineState("settings", {
  schema: SettingsSchema,
  version: 1,
  initial: () => ({ theme: "dark" }),
  persist: true,                                   // default: in memory
});
```

§10, line 647:
> `checkpointWhen` (required on every definition, no default, R14; as in Durable)

Add an explicit policy to the example. Otherwise the first copied example
fails the chosen API.

### B6. Code mode's close still describes the superseded drain

§24, lines 1257–1258:
> the old sandbox is sealed and drained in `close` (running scripts finish or hit their deadline, then it ends)

§13, lines 766–767:
> `close` detaches the old resource, returns at once, and disposes of it when its work has finished or after `closeTimeout` (30 s)

Log R16 is explicit:
> the default `closeTimeout` (30 s, no override)

Use the R16 rule consistently: detached background disposal, with a hard
30-second bound for code mode, not an arbitrary script deadline or a blocking close.

### B7. “Nothing is copied” conflicts with stripping shared arguments

§5, lines 312–317:
> Method arguments are always stripped to the provider's schema
> Nothing is copied in process: same-host calls pass values by reference

§3, line 239:
> nobody mutates a value it got

Pass a shared `{ allowed, private }` object to a method accepting only
`{ allowed }`. Stripping cannot both preserve that object and pass it unchanged.
Specify **no unconditional defensive clone**, with copy-on-change normalization.
Do not implement stripping by deleting fields from shared arguments.

### B8. Accepted fingerprints need more than member schemas

§5, line 306:
> The fingerprint covers input, variants and members, not placement.

§27, lines 1340–1342:
> `accepts[v]` carries the provider's own copy of version v's member schemas plus value mappings
> The provider computes v1's fingerprint from those schemas

The old input schema is missing. This becomes a functional failure, not just
wording, when the input changes (D5).

### B9. Cost guards count links instead of encoded parts

§30's table, line 1440:
> one encoding per hold part at its origin (that hold's Delta encoder)

§30's test example, line 1450:
> one encode per link

R1 explicitly says two holds encode separately. Ten client holds multiplexed
over one worker IPC link require ten part encodes, not one. Count part encodes
at the origin, message assembly separately, and zero payload encodes at relays.

### B10. The tagged-union rule is not followed by its examples

§1, line 33:
> States, results and outcomes are discriminated by `kind`

§15:
> Outcome: `{ ok: true, result } | { ok: false, error: "threw" | "aborted" | "lost" }`

§20:
> `state { status: "running" | "done" | "failed" | "cancelled", step?: { id, kind, … }, notices }`

Use the chosen discriminant consistently before these become public types.
The flow example also permits a completed flow with an active step.

### B11. The rejected list still rejects the new cold-path checks

§31:
> validating state and documents by walking values in production

§9, lines 594–596:
> the result of `migrate` and of `initial()` is validated against the new schema once, when it is produced

Narrow the rejected item to repeated state/commit validation; retain R8.

## C. Primitives to remove or merge

These are simplification proposals, not implementation instructions.
Do not estimate a 6–7k-line core while silently counting another runtime
inside optional helpers as free.

### C1. Move the job engine out of the mandatory kernel

**What:** job definitions, persisted records, dedupe, concurrency, progress,
version adapters, current-code finish, retries and owner pinning.

**Replacement:** an optional job component built on the same document store
and owned scopes. Keep the transaction integration there. The first proof
already uses Durable tasks and need not require a second task engine.

**What breaks:** core-only users no longer get `self.job`/`tx.start`.
Moving jobs directly to Durable is **not** a transparent substitute:
Chord intent and Durable submission cannot commit atomically. A full removal
would require moving the whole workflow's intent/outcome into Durable.

This is the largest credible scope cut; it requires an explicit owner choice.

### C2. Remove facet-owned mutable documents and the transaction exception

**What:** transactions spanning a served object and its facet, with two lines
and a special ownership permission.

**Replacement:** facets declare types and contributions; mutable shared data
belongs to an ordinary local object. Put data needing one atomic invariant
under that one owner.

**What breaks:** existing designs atomically updating instance documents and
facet documents must move those writes into the shared owner. Keeping the
current split while replacing the second lock with a method call is incorrect.

This trades some ownership flexibility for one transaction rule everywhere.

### C3. Merge writable, constant and derived subscription machinery

**What:** `self.writable`, `constant`, derives and registry-composed readables
should not each introduce a subscriber list and disposal implementation.

**Replacement:** reuse one host-local cell/subscription substrate.
`constant` has no writer; `self.writable` is an attempt-owned writer;
derives and registry composition are managed computations.
Keep `replicatedState`'s ordered-op/snapshot interface for replicated data.

**What breaks:** nothing if the public contracts remain.
Do **not** make arbitrary native-carrying cells exposable as wire state.
Old-generation setters must not update new-generation contributions;
ending an attempt must detach its subscriptions.

### C4. Merge the four routine forms into one owned runner

**What:** `on`, `every`, `loop`, `custom`.

**Replacement:** one named runner owning cancellation, call scope, cleanup,
error reporting and reload handover. The four forms are small setup helpers.

**What breaks:** nothing if `every` retains its next-due timestamp by name
and `on` keeps gapless attachment. Four separate state machines would make
those guarantees harder, not stronger.

### C5. Merge acquisition APIs into one lease implementation

**What:** `host.hold`, awaited `host.get`, `self.get`, `ctx.get`.

**Replacement:** one acquisition returning a lease and one readiness waiter.
Factory/call/host APIs choose the lease owner; awaiting is convenience.
Use the same owned-scope cleanup for call cancellation and reference release.

**What breaks:** nothing if failed/aborted awaits release their lease and
parked calls retain their reference-specific deadline. Do not merge the
provider object's lifetime with a consumer lease's lifetime.

### C6. Move registry-version adaptation into composition

**What:** the kernel's registry `accepts` engine and newer-version load refusal.

**Replacement:** compose receives versioned contributions. A pure helper
adapts supported versions; the owner omits and reports unsupported ones,
like other runtime composition conflicts.

**What breaks:** unsupported newer contributions no longer reject a load;
they become an owner notice and are excluded. If that load-time guarantee is
required, retain the metadata check but still share one composition path.

Do not replace document or remote-contract version checks this way:
those protect different boundaries.

### C7. Remove the Harness-specific startup exception from Chord

**What:** “all host-lifetime objects except the harness.”

**Replacement:** register Harness as an ordinary referenced object; app startup
holds it after `await host.load(...)` and releases it at shutdown.
Pre-barrier contributors look up Harness lazily when executing work.

**What breaks:** pre-barrier factories/openers cannot eagerly depend on Harness.
Such dependencies already defeat R17: they wait for a post-barrier object,
time out, and falsely appear as failed plugins before Harness starts.

This keeps the owner's post-barrier startup decision without teaching the
portable kernel a p3 service name or adding another lifetime mode.

**Do not add:** a job-object lifetime, a second flow protocol, a projection
algebra, a native-replacement engine, or a second retry scheduler.
Use ordinary addressed views, owner scopes and the existing readable path.

## D. Remaining blockers and majors

### D1. Blocker — ordinary cancellation can close a healthy link

**Sections:** 7, 22; R4.

Trace:
1. Client cancels call C and retires its pending entry.
2. Provider's result for C was already sent in the opposite direction.
3. Result arrives: C is now an unknown id.
4. §22 closes the link, failing unrelated calls and holds.

The reverse race is equally valid: the provider completes and retires C
before the client's cancel arrives. Release versus an already-sent state
part has the same problem. Ordered delivery within each direction does not
order the two directions against each other.

**Proposal:** specify retiring states and terminal acknowledgements, using
`result`/`gone` where possible. Distinguish legitimately retired ids from
never-issued ids. Bound the retirement bookkeeping and test its reclamation;
keeping every canceled entry forever is not an alternative.

### D2. Major — the decompression budget can disappear at the relay

**Sections:** 3, 22; R1–R2.

Trace: a guest sends a small compressed call that expands past 64 MiB.
The server checks `maxPayload` and forwards the opaque part over IPC.
The worker performs the only decode. Applying the stated “none on IPC”
policy there bypasses the client-WebSocket decoded limit.

There is a second incompatible promise: `ws.maxPayload` rejects the whole
WebSocket message with close code 1009. It cannot report only that call as
`too_large` while preserving the link. The installed ws receiver confirms
this behavior; it is not a hypothetical application choice.

**Proposal:** carry a trusted ingress decode budget with forwarded work,
independent of the final physical link. Stamp it at admission, not from a
client-controlled field. Define per-part and aggregate decoded limits.
Separate sender/application `too_large` errors from transport-limit breaches:
the latter close the connection. No payload walk is required.

### D3. Major — R19's re-hold condition is impossible for an oversized snapshot

**Section:** 3, Flow control; R19.

Trace with a 256 KiB window and a 500 KiB snapshot:
1. The snapshot is admitted; credits become negative.
2. Changes overflow while it is in flight; the hold is released.
3. Its acknowledgement restores the window to 256 KiB.
4. Re-hold waits for credits covering 500 KiB. That can never happen.

The initial re-hold storm has been replaced by a permanent stall.

**Proposal:** permit one oversized snapshot when outstanding snapshot debt
has drained, rather than requiring free credits to exceed its size.
Keep the minimum re-hold interval. Specify the accounting equation and test
this exact case plus a growing replacement snapshot.

### D4. Major — retained failed dependencies can form an immortal component

**Sections:** 6, 28; R18.

Trace:
1. A's factory gets B; B's factory gets A.
2. Both time out and become transient failures.
3. Both retain their dependency references for recovery.
4. The external caller releases A.
5. Neither object loses its last reference; retries and retained generations
   can survive indefinitely.

§28 requests cycle tests but does not define the expected outcome.

**Proposal:** reject declared dependency cycles before activation waits,
release the cycle's acquisition leases, and report a broken declaration.
Do not introduce tracing garbage collection for object-reference cycles.
Test the cycle introduced by a reload as well as first activation.

### D5. Major — accepted versions cannot reconstruct old input identity

**Sections:** 3, 5, 27; R6–R7.

Trace: V1 input is `{ session }`; V2 changes it to `{ sessionId }` and
advertises an `accepts[1]` entry containing V1 member schemas.
The V1 fingerprint includes its old input schema, which that entry lacks.
Normalizing the V1 hold with the current schema also drops `session` before
placement and object identity can be resolved.

**Proposal:** retain the complete provider-owned old contract, not only its
members. For the minimal first implementation, explicitly prohibit input
shape/identity changes through `accepts`; require a new object type for them.
If they must be supported, define validated input adaptation before canonical
current identity and placement. Do not improvise it from peer data.

### D6. Major — registry definition ownership is missing during reload

**Sections:** 17, 21, 27.

Trace: plugin A owns registry R and reloads its composition to V2.
Unchanged plugin B still has an imported V1 token, including its old
`compose`, and calls `host.registry(R1)` or contributes through it.
The design says how contribution values are adapted, but never says which
registered definition owns R, how that definition is replaced, or how an
old reader token is prevented from reinstalling the old composer.

First-token-wins leaves stale behavior; last-token-wins makes behavior depend
on activation timing. Keeping one table per token splits one extension point.

**Proposal:** give the defining facet one authoritative declaration for R.
Other tokens identify a registry but cannot install its composer. Reload
replaces that declaration atomically; specify reader-version compatibility
and disposal of superseded subscriptions. Reuse the facet declaration table,
not a second loader or lifecycle engine.

### D7. Major — job dedupe and result retention have no end condition

**Section:** 15.

Trace: a host-lifetime owner completes 100,000 uniquely keyed jobs.
If acknowledged records and key-to-run entries remain, the live process
retains an unbounded history. If they are dropped immediately, retrying a
completed request with the same key starts a second effect instead of
returning the existing run. Outstanding `outcome(ctx)` handles add another
retention owner. No lifetime or collection rule is specified.

**Proposal:** define the dedupe horizon, record retirement and result-handle
ownership together. State explicitly whether dedupe covers only unsettled
runs or a retained completed history. Release all waiter and scope references
when settled; persisted history must not imply a permanent in-memory cache.
Test completed runs, repeated keys, blocked finishes and removed definitions.
If the full job component is deferred (C1), defer this complexity with it.
