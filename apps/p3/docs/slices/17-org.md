# Slice 17: Org

**Goal.** Enrollment, the org profile as the top lock layer, the startup gate, loader admission. `archive/org-managed/book.md` (its settings layer superseded by locks).

**Depends on:** slice 6.

**From the archive:** `archive/org-managed/book.md` and its `details.md`, `archive/locks/design.md` §8 (companies and Radius), `archive/direction-pi-roam.md`.

**Read first:** the private org consultations on slayer (`/home/badlogic/chord-notes/research/p3-people-2026-11-13/org-consult-*.md`, `org-session-*.md`); `archive/org-managed/details.md` (its open decisions); `archive/people/book.md` (Companies).

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

-  `people/book.md:395-418` (profile JSON); decisions.md:153-174 (withdrawn, but the enrollment specifics
  match book.md) and :207-210 (dates); `research/org-consult-*.md` (adversaries, cache, "needs now"); conflict
  2.2 #14; `apps/p2/plugins/envs/` (Gondolin), `apps/p2/docs/remote-envs.md`; `src/node/plugins/discover.ts` (first
  root wins).

**Open or to carry (docs audit):**

- A failure never makes an enrolled Pi unmanaged and never opens what the last good profile closed
  (`archive/org-managed/details.md` 2160-2161); the profile cache is a file (needed before the store opens);
  `pluginSources` bounds what a stolen org key can push.
- Roots: the locks design's two kinds (base, user) against org-managed's four (app, system, org, member, pinned hashes):
  reconcile.
