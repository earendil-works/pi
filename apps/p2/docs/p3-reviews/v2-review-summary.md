# Chord v2 review round 1: consolidated

**Status:** K list confirmed with changes to K7, K9, K16, K17, K21 and D11 decided (see the decision log, "Review
round 1"). Remaining D items are discussed one at a time.

Sources: `v2-review-astra.md` (A), `v2-review-fable.md` (F), both on committed HEAD `e5864dd82` (before the natives
step), plus the implementation subagent's open questions (Q). Status per item: **fix** (the design already decides it;
a kernel bug), **decide** (needs the owner), **cut?** (a reviewer proposes removing something).

## Kernel fixes (the design already decides; bugs or missing pieces)

| # | Sev. | Finding | Source | Fix |
| --- | --- | --- | --- | --- |
| K1 | blocker | remote methods run as the host principal; `ctx.get` escalates | A1, F1 | caller's principal in remote method `ctx` and its `ctx.get` (design §5) |
| K2 | blocker | an incoming hold executes the consumer's schemas (regex DoS, ~300 ms per 24 chars, exponential) | A2 | normalize/validate with the provider's schemas; consumer descriptions only checked within a bounded grammar |
| K3 | major | a dependency failing after `live` leaves the dependent live with stale values | A3 | supervise declared dependencies for the whole attempt |
| K4 | major | no drain deadline: an uncooperative handler hangs object end, `revoke`, `host.close` | A4, F3 | callers rejected at once; drain bounded by `closeTimeout`; `revoke` does not await drains (check what step 6 already did) |
| K5 | major | `host.root` scopes are not cancelled by `host.close` | A5 | host-owned cancellation and bounded tracking |
| K6 | major | one incompatible consumer fails the shared provider for everyone | A6 | binding-local mismatch |
| K7 | major | method dispatch uses the first variant's signature | A7 | dispatch by the active variant (or forbid differing signatures: decide) |
| K8 | major | zero-hold bindings and failed-address backoffs are never removed | A8, F13 | evict bindings; TTL/cap for backoffs |
| K9 | major | SQLite replays the whole delta tail on every commit (quadratic) | A9 | default checkpointing; validation without full replay |
| K10 | major | byte validation enumerates every index (1 MiB: ~100 ms) | A10 | constant-time `Uint8Array` recognition |
| K11 | major | references do not re-hold after a routed link drop; passive viewers stay `loading` | F2 | schedule re-resolve with the per-address backoff while holds exist (design §3) |
| K12 | major | IPC links have no flow control (frames unsized) | A note, F7 | size IPC frames, apply the window |
| K13 | major | a facet failure is permanent and poisons its objects | F4, Q2 | facets retry like objects (transient backoff) |
| K14 | major | permanent relay failures (`forbidden`, `invalid/placement`, `contract_mismatch`) retry forever; calls lose the cause | F10 | classify as `broken`; calls reject with the cause |
| K15 | major | a worker start is aborted when its first requester leaves | F11 | a resolve that produced a link finishes; abort only resolvers without a link |
| K16 | minor | unbounded per-link resources (calls, holds, first snapshots) | F14 | defaults for max calls, holds per link, unacked bytes |
| K17 | minor | deeply nested frames crash IPC peers (recursive `isValue`) | F15 | iterative or depth-limited |
| K18 | minor | keyed reads take the exclusive line | F16 | reads shared, transactions exclusive |
| K19 | minor | state frames encoded up to three times on WebSocket | F19 | encode once |
| K20 | minor | remote dependency cycles spin forever | F20 | detect two-hop cycles or mark the second timeout `broken` |
| K21 | minor | footguns: `tx.get` returns live authority values; in-memory `keys()` scans all; read-only tx after a version bump writes bases | F21 | freeze or copy; index; document |
| K22 | major | playground: no data-directory or worker lock; a replacement can start before the old worker exited | A11 | exclusive server lock, worker lock, replacement after confirmed exit |
| K23 | minor | documentation drift (walkthrough open points, `RefState` shape, execution-as-host in step docs, linger text, per-get overrides not implemented, `principalKey` must be identical on all hosts) | F18 | fix docs |

## Decisions for the owner

| # | Topic | Problem | Options |
| --- | --- | --- | --- |
| D1 | registry `compose` vs natives | staging cannot read natives (not open yet), entries may carry natives | (a) staging composes static descriptors plus lazy functions; runtime availability is a separate state that gates required consumers (A12) |
| D2 | code mode reload vs pinned Durable phase | a phase pins the old tool entry, waits in an approval hook; the old sandbox is sealed and closed; the delayed start hits a closed sandbox | (a) execution lease before the phase can wait; (b) keep the old sandbox until leases end; (c) the old entry uses the current sandbox at start (A13) |
| D3 | natives that must follow relocation | a native never changes; a cwd change leaves a watcher on the old path | (a) pattern: a native manager switches its internal watches with generation fencing; (b) generation-keyed native owners (A14) |
| D4 | jobs and their owner's lifetime | start a job, release the reference: the owner ends and aborts the job | (a) running and unacknowledged jobs pin their owner; (b) job owners must be host-lifetime; (c) jobs as objects (open #9) (A15, F jobs verdict) |
| D5 | reloading native objects | terminals (PTY owner = byte pump) and the harness restart on any change of their plugin, killing shells and agent tasks; in-flight transactions of a swapped pure object throw `gone` | (a) opt-in keep of a native across reload when the new factory declares the same one; (b) such plugins are "restart only"; plus: old handles stay valid until their calls settle (F6) |
| D6 | `accepts` adapters | authors must hand-build readables for adapted state | (a) adapters map values per member; Chord wraps them as derives (F8) |
| D7 | revocation and work in cores | a revoked guest's jobs, flows and queued work in principal-free cores survive | (a) a revocation hook for cores (`host.onRevoke` or a registry); (b) cores key guest work by a revocation label and reconcile (F9) |
| D8 | lingering and keep-alive | consumer-side linger is dropped with the link, so it cannot keep anything alive after a tab closes; keep-alive (#1) undecided | (a) cut consumer-side linger, keep provider-side `linger` plus `host.references`; decide #1 (F12) |
| D9 | validation cost of large state | whole-value validation per change at the provider per binding and at every consumer (500 KB: 8 ms per change, 54 ms with 3 viewers) | (a) validate once per publication at the provider; (b) validate ops by path; (c) skip consumer-side validation on trusted hops (F5) |
| D10 | storage failure on the server | the host closes, the process lives on as a zombie | (a) Chord exits with a distinct code; (b) the app supervises via `onError` (F17) |
| D11 | method signatures across variants | variants may declare different arities for one name | (a) dispatch by the active variant; (b) forbid it in contracts (A7) |
| D12 | `retryOn` sources | references are released while failed, so a reference-member source ends | (a) only attempt-independent sources; (b) a hidden hold (Q1) |
| D13 | per-type park deadline for remote consumers | per-type override lives on the provider; remote consumers park on their own host | (a) per-`get` `{ parkTimeout }`; (b) a hint in the contract (Q3) |
| D14 | published projections | every hold on a worker-placed type starts the worker; no read-without-start | decide before the sessions plugin (design #19) |

## Proposed cuts (F section D, A "scope to cut")

Cross-relay reset coordination (~300 lines); per-binding diffing for adapted bindings (if D6 a); JSONL storage;
`MemoryDocumentStorage.prepareCommit/snapshot` (built for the removed Durable adapter); consumer-side linger cache (D8);
`accepts` on host values; dev-mode freezing of local values; the Questions service (keep flows); defer the HTTP and
channel components, middleware phases and the Durable Object profile until the kernel fixes and one real
harness/native/registry proof are done.

## Reviewers' strategic advice

- First real proof: models and environments → harness → one tool, with an approval pause and a code-mode reload
  (instead of more "notes plus a counter").
- Rollout with mixed revisions is undemonstrated; test server commit plus worker rejection, a joining worker, a
  client ahead of the server.
- Durable stays the resumable workflow engine; Chord jobs stay small.
