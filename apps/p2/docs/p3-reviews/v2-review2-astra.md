# Chord v2 review round 2 (design): Astra

Reviewed `packages/chord/docs/design.md` at `92ecf063b` against the decision log and `v2-cost-model.md`.
Proposals only; the owner decides. Kept verbatim from the reviewer's answer.

Reviewed `92ecf063b`, the full decision log, and cost model.

1. **Blocker — §§3, 22: opaque forwarding lacks a safe routing unit.** One worker→server commit can contain holds belonging to different clients. Forwarding that opaque body to both leaks the other client’s state; splitting it requires a defined segmentation format. Native IPC→WebSocket also needs an encoding location. **Proposal:** specify independently routable opaque segments, authenticated routing metadata, and atomic commit assembly at each destination.

2. **Major — §5: contract-cache poisoning is not excluded.** The worker’s parent link multiplexes different principals. If a guest supplies an incorrect description under a legitimate fingerprint, caching it per `(link, fingerprint)` can affect later owner bindings. **Proposal:** require recomputing and verifying the description’s fingerprint before caching; malformed descriptions must fail the originating binding, not the shared parent link.

3. **Major — §§3, 22: compressed-input limits are undefined.** An authenticated client can send a compressed frame below the encoded-byte limit that expands enormously before provider schema validation. Opaque relaying can carry this into IPC, whose limit is unrestricted. **Proposal:** separately bound compressed size, decoded size and framing metadata; enforce expansion limits during decoding and preserve them across relays. This requires no state-validation walk.

4. **Major — §§6, 17, 21, 24: the harness start barrier is circular or premature.** The barrier includes every host-lifetime object, including Harness, but Harness activation itself resumes Durable. Waiting for the complete barrier inside its opener waits for itself; resuming earlier can run persisted work before a tool contributor depending on Harness becomes live. **Proposal:** make Harness live while paused, then resume through an explicit post-activation coordinator.

5. **Major — §§17, 21, 24: approval can resume during the sandbox replacement gap.** Restart removes the old contributor immediately; draining its sandbox can delay the replacement. A previously pinned tool’s `execute()` then looks up the “current” sandbox and finds none. Registry access has no reference-style parking guarantee. **Proposal:** specify a cancellation-aware readiness gate for the current sandbox, with distinct behavior for replacement, failure and plugin removal.

6. **Major — §§9, 21: old-call guarantees conflict with document migration.** A v1 method awaits external work; reload migrates its document to v2; the method resumes and uses its supposedly still-valid v1 handle. Section 9 requires that access to throw, while §21 promises old calls and transactions keep working. **Proposal:** define the schema-changing exception: defer migration for affected old calls, or explicitly terminate those calls before upgrading.

7. **Major — §§5, 27: adapted-argument validation order is missing.** V1 accepts `{text}`, V2 accepts `{body}`, and its adapter renames the field. Stripping or validating against V2 before adaptation rejects valid V1 calls; using the consumer’s schema contradicts the trust rule. **Proposal:** define provider-owned legacy signatures and an explicit strip/validate/adapt order. The peer must never supply the executable validation schema.

8. **Major — §6: dependency recovery has no retained wake-up mechanism.** A becomes broken because B is broken, releases its references, and receives no automatic retries. B later recovers through another reference’s `retry()`, but A has nothing observing that recovery. “Recovery … is immediate” therefore does not follow. **Proposal:** retain dependency-recovery subscriptions independently of attempt-owned references, and distinguish dependency failure from an intrinsically broken factory.

9. **Major — §§4, 25: reconciliation alone leaves a post-revocation dispatch race.** A guest-origin Durable task is paused for approval. Its grant is revoked, but approval resolves before the shared store’s reconciliation routine runs; the next tool effect starts under the host principal. **Proposal:** keep reconciliation for cleanup, but require current-grant checks when accepting answers and dispatching new effects. This does not require a revocation hook.

10. **Major — §9: transaction results can escape as revoked drafts.** The advertised consistent-read pattern permits `return (await tx.draft(doc)).items`. That returns a draft-backed object, which throws after commit; wrapping it in another object does not help. **Proposal:** specify safe immutable result extraction, or explicitly prohibit escaping drafts and document how consistent reads return nested data without copying the entire document.

11. **Minor — §§12, 30 and cost-model target: structural sharing is not O(change) for wide containers.** Updating one item in a large flat array still copies its containing array; `mapShared` still maps and compares every element. Ten viewers multiply that work despite all proposed “no walks/no deep copies” counters passing. **Proposal:** document the container-width cost and benchmark long arrays, allocations and element visits; use bounded windows or partitioned documents where needed.

12. **Minor — §31 contradicts §§17, 24.** The rejected list still includes “dynamic registries” and “late-bound registry entries,” while runtime-changing contributions and execute-time sandbox lookup are required behavior. **Proposal:** remove or narrowly define those rejected terms so implementation does not accidentally forbid the first proof’s required handoff.
