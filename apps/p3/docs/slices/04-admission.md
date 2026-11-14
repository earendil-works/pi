# Slice 4: admission (Chord)

**Goal.** A remote object's provider decides, before its factory, whether a principal gets it and at which level, from
live data (`host.serve(Type, factory, { admit })`).

**Builds:** admission in Chord (`host/attempt.ts`, `object.ts`, `dependencies.ts`, `staging.ts`, presence), the new
failure kind `denied` (a protocol version bump), the per-acknowledgement binding fence (`remote/hold.ts #bindTo`),
tests (the admission design §8) and an example.

**Read first, in full:** `packages/chord/docs/admission/design.md`; the reviews on slayer (private):
`/home/badlogic/chord-notes/research/p3-people-2026-11-13/admission-review-*.md` and `admission-review2-adm-fable.md`
(round 2: three blocking fixes, six should-fixes, two cuts, builder notes; not yet folded into the design);
`packages/chord/docs/shared-holds/design.md`; `packages/chord/docs/slices.md` (feature map, carry-over, bumping
`PROTOCOL_VERSION`); the Chord v2 code style (root `AGENTS.md`); the code: `packages/chord/src/host/attempt.ts`,
`object.ts`, `dependencies.ts`, `parked.ts`, `staging.ts`, `revocation.ts`, `reference.ts`, `reference-source.ts`,
`host.ts` (bind, revoke, the staging pass), `presence.ts`, `remote/hold.ts`, `remote/provider.ts`,
`remote/remote-object.ts`, `link/message.ts`, `link/binary.ts`, `link/text.ts`, `data/failure.ts`. From the archive:
`people/book.md` (the session check admission replaces), `rundown/book.md` (The Rule Under Everything).

**Open (owner):** the staging rule (recommended: stage the new admit's declarations, rehearse the new factory with the
current level); drop last values on a denial (recommended: yes); the route stays coarse (recommended: yes); what a lost
decision source does (Fable's S4: seal with `unavailable`, or keep the decision while the source only loads).

**Done when:** the design §8 tests pass, the design is updated with round 2, design.md §6, §7, §16, §19, §21 say it.
