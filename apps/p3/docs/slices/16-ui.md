# Slice 16: Web and terminal

**Goal.** The web page on Elanor and the terminal client, from the team's UI work (owner, 2026-11-14): transcript, composer, sidebar, sheets.

**Depends on:** slices 14 and 15.

**From the archive:** `archive/views.md` §5 (phones and terminals), `archive/apps/web-ui-direction.html`; p2's Elanor integration on main (`apps/p2/src/web/elanor.css`, `ElanorMarkdown.tsx`, the sidebar on Elanor's side navigation; commits 6af57fa0b, 1d79ac79e). Elanor is a React design system: the terminal client has its own components.

**Read first:** `.pi/skills/p2-ui.md`; p2's `docs/p2-tui-port.md`, `docs/optimistic-ui.md`; Chord decisions "A reloaded UI part shows its loading state" and "A restarting page object's old UI may show unstyled"; `archive/layouts/mocks.html`, `archive/coding-flow/index.html`; `archive/efficiency.md` §2.

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

-  `map/book.md:703-796`; `step-0/book.md:103-125`; `handoff.md:60-61`; Chord dec. "answers follow state"
  (2026-11-05); `apps/p2/docs/optimistic-ui.md`; `packages/chord/docs/guide-plugins-hosts/book.md` (Optimistic UI);
  `src/react/README.md`, `src/tui/README.md`, `src/node/surfaces/README.md`; `people/book.md:195-206`
  (`SignInOptions`, `TuiSignIns`); p2 `plugins/web-shell/`, `drafts/`; locks review B1 (MessageData rendering).

**Open or to carry (docs audit):**

- No slice builds the web entry or the API's `web` and `terminal` modules yet: they belong here (`archive/map/book.md`
  703-796, `archive/step-0/book.md` 103-125: the `Page` slot, new sessions named with `crypto.randomUUID()`, the
  transcript held only after the row is listed, drafts in `usePageState`). Optimistic UI (`useOptimistic`,
  `TuiScope.optimistic`).
- Blocked tasks of a moved session shown with reason and abort (Chord dec. 573).
