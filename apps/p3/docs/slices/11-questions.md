# Slice 11: Questions

**Goal.** Asks and approvals: typed questions, answered from any device, the worker free to stop while waiting. `archive/base-inventory/` (Waiting Costs Nothing) and p2's `docs/questions.md`.

**Depends on:** slice 3.

**From the archive:** `archive/base-inventory/explainer/book.md` (Waiting Costs Nothing, Building Features: an approval before bash), `archive/status-2026-11-09.md` §5 (suspendable work in Durable).

**Read first:** suspendable work is built in Durable (commit 473515f9c, `packages/durable/src/signals.ts`; the built API parks: `api.checkpoint`, `api.wake` in `src/harness/types.ts`), though `packages/durable/docs/suspendable/spec.md` still says nothing is built; that spec; design.md §20; p2's `docs/waiting.md`, `docs/questions.md`; `archive/status-2026-11-09.md` §4 (the questions direction). The archive's approval example uses a draft API (`{ suspend }`, `api.resumed`). Worker liveness from Durable's wake state, if not in slice 3.

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

-  design §20 "The Questions service"; Chord dec. Q6 (633); `packages/durable/docs/suspendable/spec.md`
  (**not built**: decide whether Durable comes first); `apps/p2/docs/waiting.md`; `status-2026-11-09.md:87-95`;
  `merged.md` §2 #8 (wake bridge) and §5 tests 5-6; `sharing.md:25-26` (approvals stay the owner's: an owner
  decision).

**Open or to carry (docs audit):**

- Whether Durable's suspendable work is built: Fable found it built (commit 473515f9c, `src/signals.ts`), Opus read
  its spec as not built. Verify when detailing.
- "Approvals stay the owner's" (`archive/sharing.md` 25-26) was a recommendation, never decided: an owner call.
