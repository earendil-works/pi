# Slice 6: locks

**Goal.** A plugin declares what can be switched off or limited, registers it, and enforces it where it hands things
out; values per layer (org, Pi, app, session) only narrow; one sheet per layer; the agent's lock tools.

**Builds:** plugin `locks` (the registry, the stored values, each session's values computed live, the sheet, the
candidates), the plugin switch, Chord's rendering of another plugin's messages.

**Depends on:** slices 1–5.

**Read first, in full:** `decisions.md` ("Locks", "Tool access"); `archive/locks/design.md`; Fable's review on slayer
(`/home/badlogic/chord-notes/research/p3-people-2026-11-13/locks-review-adm-fable.md`: four blocking fixes, a simpler
candidates design, cuts); design.md §17 and §23 "Messages and languages"; `packages/chord/src/surfaces/messages.ts`;
`packages/chord/docs/shared-holds/design.md` §3; p2's `src/runtime/session-lock.ts`, `tool-access.ts`,
`plugins/sessions/locks.ts`. From the archive: `rundown/book.md` (The Filters), `org-managed/book.md`,
`people/book.md` (Locks, The Plugin Switch, Layers and Sheets: the first version).

**Open (owner):** Fable's cuts: `version`/`migrate` on locks (the session recommended them on 2026-11-13; Fable
recommends cutting), the plugin switch as one `plugins` lock, tools declaring their lock (an earlier ruling says no
new fields on tool declarations, decision "Tool access"), dropping `coding.bash` and `mcp.tools` into
`harness.tools`, `maximumLock`; candidates as a function next to the lock, called when the picker opens. Lock ids
follow `names.md` (`locations.places` becomes a location; plugins `conversations`, `subagents`, `terminals` exist or
the ids change).

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

- **research:** `org-session-os-opus.md:6-19` (inventory A-J), `org-session-draft.md` (p2's lock facts).
- **p2:** `apps/p2/src/runtime/session-lock.ts`, `tool-access.ts`, `apps/p2/plugins/mcp/placement.ts`,
  `prompt/worker.ts`, `envs/schema.ts`, `sessions/` (its locks store), `views/worker.ts` (any pane kind).
- **Chord:** `src/surfaces/messages.ts` (`renderKey` 124-140, the foreign-namespace report 165-171), design §23
  "Messages and languages", §17 Registries, `src/registries/entries.ts` (`keyedEntries`).
- **archive:** `people/book.md:306-308, 334, 392`; `model-stress/report.md:864-886`; `merged.md` §4 Q15 (plugin trust
  in locked sessions); `rundown/book.md` review "plugin tools in a locked session" (The Filters, end).

**Open or to carry (docs audit):**

- What locks must cover: the inventory of what a plugin puts into a session (`research/org-session-os-opus.md` 6-19,
  groups A-J; e.g. p2's `views/worker.ts` opens a pane of any kind).
- A lock that closes mid-session: each plugin stops what it started (`archive/model-stress/report.md` 864-886).
- From `archive/people/book.md`: value formats `glob()` and `ref(kind)`; `terminals.use` hides the button; the owner may
  change an app's defaults in either direction within the org and Pi values.
- The one check at the call: the server checks `locks.manage` in `set` (locks review S3), against "no check at the
  call": an owner call.
- Whether locks carry `version`/`migrate` is open (decisions.md's "Locks" entry lists no version).
- From the resource model, per Fable's comparison (`research/resources-vs-locks-adm-fable.md`): the harness enforces
  (a tool or extension names its lock and is left out when composed) instead of each plugin; fail closed (an unknown
  lock reads closed); one allow/deny shape and one `allows(value, name)` for every lock that is a set of names. Not
  covered by locks: several people's logins in one session, giving (how an org's shared login reaches a Pi), expiry.
