# Slice 15: Groupings

**Goal.** The ways sessions (and other things) are grouped in a sidebar are plugins: built-in ones (recent, by
folder, by project, archive), ones from other plugins (triage by repository, sections by state), and ones written as
scripts (rollups). Each grouping renders its own header and rows, without stepping on other plugins' groupings.

**Depends on:** slices 1, 3, 14; Chord's lists by key (pending: `/home/badlogic/chord-notes/research/chord-for-p3-fable.md`).

**Decided:**

- Groupings and views are plugins (decision of 2026-11-07, with its addendum: the layout itself is plugin-defined, the
  data model of addressable things, groupings and views is the point). A grouping shows things; it gives nothing (the
  resource-carrying groupings of 2026-11-08 are superseded by locks).
- A route names one thing (kind and params), never a group; selecting a row opens that thing's view in the current app.

**Designed in the session's talks (2026-11-10 to 2026-11-12; history of 8b6ab5cc, around entries 276700–276760),
recorded here so it is not lost:**

- Pins and archive are sets on the server keyed by the thing, independent of every grouping, so every grouping gets
  "pinned first" and "hide, show or only archived" for free; archiving may be refused while a session still has running
  work (its plugins answer an activity question).
- Computed groupings (by folder, recent, by state) and curated ones (projects: their own server table of members).
  Dropping a row on a grouping's entry is that grouping's business: a projects grouping adds the session to the
  project's table; a computed one accepts no drops. A dragged item carries only the thing's address.
- Group keys are computed apart from the things (one repository across worktrees and machines), with per-item
  overrides; a collapsed group shows a dot for the most urgent state inside.
- Sections by state as one grouping (pinned, working, waiting, settled), a drop into a section calling a verb on the
  session.
- Child sessions (subagents, branches) get no row of their own; an open child highlights its listed parent.
- Row seats: small slots on each row (leading, trailing, hover) and a row menu that plugins extend; they get only the
  thing's address, so drawing a row never loads the session.
- Open: whether one session may appear in several sections (p2 allows it).

**Read first:** `decisions.md` (2026-11-07, groupings and views); `archive/apps/web-ui-direction.html` §4 (the coding
app's sidebar: built-in sections, from a plugin, from a script); `archive/views.md`; `archive/rundown/book.md` (Views
and Items); p2's `plugins/rollups/`, `plugins/sessions/sidebar/` (`Sidebar.tsx`, `Row.tsx`), `docs/p2-notes.md` (the
sidebar of rollups); the session's history around entries 276700–276760 (the sidebar research and the drop question).

The brief is filled out when the slice is next.
