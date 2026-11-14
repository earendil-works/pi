# Slice 4: admission (Chord)

**Goal.** A remote object's provider decides, before its factory, whether a principal gets it and at which level, from
live data (`host.serve(Type, factory, { admit })`).

**Builds:** admission in Chord (`host/attempt.ts`, `object.ts`, `dependencies.ts`, `staging.ts`, presence), the new
failure kind `denied` (a protocol version bump), the per-acknowledgement binding fence (`remote/hold.ts #bindTo`),
tests and an example.

**Read first:** `packages/chord/docs/admission/design.md`; the reviews in
`/home/badlogic/chord-notes/research/p3-people-2026-11-13/admission-review*.md` (round 2 by Fable: three blocking
fixes, six should-fixes, not yet folded into the design).

**Open (owner):** the staging rule (recommended: stage the new admit's declarations, rehearse the new factory with the
current level); drop last values on a denial (recommended: yes); the route stays coarse (recommended: yes); what a lost
decision source does (Fable's S4: seal with `unavailable`, or keep the decision while the source only loads).
