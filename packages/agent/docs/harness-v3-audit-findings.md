# harness-v3.md — open audit findings (second cold read, gpt-5.6-sol)

Working file: fix each in `harness-v3.md`, check it off, delete this file when empty.
First cold-read round (10 findings) is already fixed (`8431bfbea`).

## P0

1. **Retention contradicts the core storage model.** §0.5 "there is no third place" / inventory "carries no authority"; §1.1 entries/usage "never deleted" — vs §6.2 ledger rows disappearing with inventory standing in, §6.6 authoritative header aggregate. Fix: make retention an explicit scoped exception; define authoritative aggregate storage and the exact `getStats()` formula (live sum + retired aggregates).
2. **SettlementKernel cannot perform its claimed settlement.** §7.4 stores only untyped id arrays; synthetic settlement needs entry kind, parent, tool call id/name, entry↔usage association, and operation-owned vs lane-owned pending separation. Fix: discriminated pending-effect records + separated pending id lists, sufficient to construct valid entries and `LaneLastResult`.
3. **Retention preflight can drop entries open-state validation requires.** §6.3 pins only reserved ids; §3.3/§4.4 need prompt, trigger, latest-assistant, completed-result, source/target ids to resolve. Fix: preflight pins every materialized and reserved id directly referenced by each open operation (op.meta included).

## P1

4. **JSONL snapshot compaction vs sequence continuity.** §1.7 requires persisted seq continuity; compaction leaves gaps. Fix: snapshot header carries a seq high-water mark; validate monotonic snapshot state + consecutive post-snapshot commits only.
5. **Retention-marker APIs contradict each other.** §2.5 finders return `truncatedAt`; §5.3 types return plain entries; §6.4 says `Entry[]` stays; `getRetentionBoundary` missing from the §5.3 interface; paged results can't derive the marker. Fix: expose `getRetentionBoundary` in `SessionTree`, forbid marker inference from paged results, align §2.5 wording.
6. **LaneExpired has no usable public contract.** Absent from §5.1 result unions; getters have no expiry shape; "always admitted" navigation undefined for `summarize:true` (needs the expired source). Fix: add to affected unions; restrict rebase to unsummarized navigation.
7. **Terminal prefix cleanup unsupported.** `Write` deletes exact keys only; `listRegisters` lists whole namespaces. Fix: add prefix listing/deletion to Storage, or retain owned keys durably for exact deletion.
8. **Deferred settlement/recovery lacks a complete transition table.** Old R/U abandonment vs synthetic settlement, poll numbering on replacement, ready-with-tools, pending/error transactions unstated. Fix: full deferred transition table (base spec §3.7 deferred rows + jot part 4 are the sources).
9. **Precise rewrite not implementable.** Redaction/legacy-id migration defined without old→new id remapping for parents, leaves, labels, fromId, ledger entryId, registers, tail writes. Fix: specify the id map and atomic reference transformation, including writes admitted during the copy.
10. **Restore pseudocode can't hydrate what validation requires.** `directEntryIds` lacks `op.meta` (prompt ids), `sourceLeafId`, navigation source/target. Fix: pass `meta.value`; enumerate those ids in hydration + validation.
11. **Register write typing loses namespace/value relationship.** §1.4 `set` takes `value: JsonValue`. Fix: mapped discriminated union keyed by namespace; serialization validation at admission.
12. **Close vs non-Result signatures.** §4.8 `Err(Closed)` for unaccepted calls, but setters return `Promise<void>`, appends `Promise<string>`. Fix: state these reject with `HarnessClosed`.
13. **Invariant 19 impossible as persistent invariant.** aborted-implies-cancelled unverifiable after terminal state deletion / forks. Fix: scope to the committing transaction.
14. **`BranchSummaryEntry.fromId` undefined.** Fix: define as the pre-navigation source leaf; name it in §3.10's publication TX.
15. **Empty prompts have no valid acceptance state.** `[]` prompt + no injections + no captured nextRun → no newest entry. Fix: reject with `InvalidMessage` when acceptance would append nothing.

## P2

16. **"No query may be a table scan" overstated** vs `scanEntries`. Fix: restrict to execution/recovery and branch hot paths.
17. **Provenance: `AgentEventSink`** is in `src/agent-loop.ts`, not `src/types.ts`. Fix list in §0.7.
