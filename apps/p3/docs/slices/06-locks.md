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
