# Slice 14: Views

**Goal.** Pane kinds, layouts per app, slots, the workbench; collaborative views as plugins with server objects, state and events; the agent's plugin tools (write a plugin, apply it). `archive/views.md`, `archive/apps/web-ui-direction.html`.

**Depends on:** slices 2, 3.

**From the archive:** `archive/views.md`, `archive/apps/web-ui-direction.html`, `archive/apps/views-mockup.html`, `archive/layouts/mocks.html`, `decisions.md` ("The agent writes plugins", "Artifacts and views").

**Read first:** `decisions.md` ("groupings and views are plugins", "UI is contributed from a plugin's facet", "The agent writes plugins", "Artifacts and views": `ViewKinds`, `PaneProps`, `ArtifactKinds` supersede views.md's `WebViews`/`TuiViews`); `archive/rundown/book.md` (Views and Items, Who Sees Which View, its open questions on views); `archive/sharing.md` (views know who is there); p2's `docs/views.md`, `docs/agent-plugins.md`, `docs/tool-ui.md`; `archive/efficiency.md` §2. Superseded in the files cited: `views.md` §4 "Promoted", §4a, §7.1; rooms, the sketch library and one connection per view in `web-ui-direction.html`. Groupings have their own slice (15). `apps/views-mockup.html` is rendered by script: open it in a browser. **Depends also on:** slices 5 (layouts per app) and 6 (the page side of the plugin switch).

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

-  `rundown/book.md:1056-1280`; decisions.md:42-56 (groupings, addendum) and :29-33 (UI from facets);
  `people/book.md:550-558`; locks §5 (the page side of the plugin switch); `sharing.md:90-93` (presence);
  efficiency §2; `org-session-os-opus.md` group H.
- **Chord:** design §11 "Events", §19 Presence; Chord dec. "Events" (2753), "Call windows only for untrusted links"
  (2741), "References share one wire hold" (3506); `src/react/README.md`, `src/tui/README.md`.
- **p2:** `apps/p2/docs/views.md`, `src/web/view-kinds.ts`, `artifact-kinds.ts`, `plugins/views/`, `rollups/`,
  `plugins/dev-tools/`; `apps/p2/docs/rooms-v3/` (use cases only). The rundown's `apps/p2/docs/views-mock/` does not
  exist on main.

**Open or to carry (docs audit):**

- `archive/people/book.md` 550-558: slots of switched-on third-party plugins in reused views; a page with several
  sessions composes panes, slots and commands per session.
- Sidebar groupings (decision of 2026-11-07; `archive/apps/web-ui-direction.html` §4: built-in sections, sections from
  plugins and scripts; open: one session in several sections).
- Hidden panes release expensive state (`archive/views.md` §6).
- From the t3code comparison (if the owner agrees): theme tokens and themes as data with a tested contract of stable
  markup hooks, a CSS filter against exfiltration, safe mode, the agent seeing a screenshot of what it changed, a
  personal layer per person or device.
