# Artifacts

Artifacts are pages and documents the agent writes for the person: an html page (a chart, a tool, a game, an editor
such as Max's glyph editor) or a Markdown document. They belong to the session, keep every version, show in the
transcript where the agent shows them, open as views beside the chat (docs/views.md), and are listed in the artifacts
side panel. Plugin: `plugins/artifacts`. Decision: "Artifacts and views" in `apps/p3/docs/decisions.md`.

## What it does

- **The agent** works with them through code-mode tools in the namespace `artifact` (`tool.ts`, extension
  `p2-artifacts`): `artifact_list`, `artifact_read` (a version, default the newest), `artifact_write` (a new artifact,
  its ID made from the title unless given, or the next version of `id`), `artifact_edit` (exact replacements, each
  `old` once), `artifact_show` (in the transcript, right after the call), `artifact_open` (a view of its kind),
  `artifact_delete`, and for html pages `artifact_html_errors`, `artifact_html_logs`, `artifact_html_eval` (code run
  in a page open on some device), `artifact_html_state` (the whole state as an object) and
  `artifact_html_set_state`. Each returns a structured value. The prompt lists the namespace's description;
  `describeNamespace("artifact")` gives the instructions and the page API.
- **New page errors ride along**: errors the open pages report and no message carried yet go with the person's next
  message as an `<artifact-errors>` block (the views plugin's `MessageContexts`), once.
- **In the transcript** (`activity.tsx`): `artifact_show`, called from a script, places the artifact's pane in place
  after the script (`hasResult` "inline"; nested code-mode calls place results as top-level calls do,
  `src/web/activity/model.ts`). It works as beside the chat: people who may send change it (an html page saves its
  state) and select in it (the selection goes with their next message through `Views.selectInline`); viewers read it. The pane mounts only near the screen, with hysteresis so a card at the edge never
  flips: it mounts within one viewport of the transcript's scroller and unmounts only past two (two
  `IntersectionObserver`s rooted at the scroller). The card keeps the height its pane last had (`inline-size.ts`,
  remembered per artifact for the page's host) while the pane is away and while a remounted pane settles: an html
  frame starts at that height, and the reserve holds until the pane reports its real one (the page's size message, a
  document drawn) or 1.5 s pass, so scrolling back never shrinks the card under the reader. A card shows the
  artifact's newest version; a deleted artifact says so.
- **Beside the chat**: view kinds `html` and `md` (`panes.tsx`), with `item` the artifact's ID.
- **The side panel** (`web.tsx`): the top bar's button counts every artifact kind's items (`ArtifactKinds`, this
  plugin's html and md and any plugin's), the side panel lists them, newest first. A row opens the item as a view of
  its kind; for a reader who may not change the session's views (a read-only guest) it shows the item's pane in the
  side panel on their device only, not editable (`local-item.ts`). People who may send can remove items (`useRemove`).
  The command menu's "Open artifact…" and its root search do the same (`commands.tsx`).
- **TUI** (`tui.ts`): `/artifacts` lists them; Enter shows one (Markdown rendered, a page as its source) over the chat
  or in the side panel, following new versions; Ctrl+B opens a page in the browser.

## html pages

`/artifact-frame?session&id&version` (`server.ts`) serves an html version into its frame: the viewer is authorized
(`canView`, no cross-site requests), the page gets the CSP sandbox (`frame.ts`: an opaque origin, scripts and https CDN
resources, `eval` for the agent's code, no frames, forms or app identity; `frame-ancestors` names the Radius shell when
relayed). Two scripts go in front of the page: the diagnostics (errors, CSP violations, its content height for inline
cards) and the bridge (`bridge.ts`), which defines `window.p2view`:

- `onState(fn)`: calls `fn(state, from)` now (`from` is `init`) and at each change made elsewhere (`update`: the agent
  or another device).
- `state`, `readOnly` (people who may not send: their changes are not saved).
- `setState(next | fn)`: the page calls it on each edit; the pane saves it after 300 ms of rest.
- `select(summary, data)` and `clearSelection()`: the view's selection (beside the transcript only).
- `onDescribeRegion(fn)`: says what lies under a drawing. Without it, the bridge collects the labels and texts of the
  elements there.

The bridge also reports the page's text selection (for comments), applies highlights, posts console lines, and runs
the agent's code (an async function body; its JSON result or error goes back).

The page's posts are untrusted. The pane (`HtmlPane`) accepts them only from its own frame, saves only that
artifact's state, and checks the state's size (256 KiB of JSON). Each page holds `ArtifactPage {session, id}`
(variants viewer, editor): its summary, its state (`value`), the agent's requests (event `request`, answered with
`answer`; the first open page gets them; 30 s timeout), and `report` for its errors and logs (kept in memory per
artifact, the newest 50 errors and 500 lines, `pages.ts`). Results that come from pages are flagged to the agent as the
page's, not instructions.

## Who owns what

| Fact | Owner | Where |
| --- | --- | --- |
| A session's artifacts (kind, title, newest version, times) | the server | document `p2.artifacts`, keyed by the session's host address (`keyed: Session`) |
| Each version's content (at most 2 MiB) | the server | table `artifact_versions` with a `host(Session)` column, written once |
| An html artifact's state | the server | document `p2.artifact-states`, keyed by the session |
| What open pages reported | the server, in memory | `PageRegistry` (`pages.ts`) |

All writes go through one local object, `ArtifactStoreHost` (`server.ts`, `store.ts`); `Artifacts {session}` (variants
reader, editor, worker) and `ArtifactPage` derive from its documents. Being keyed by the session's address, the data
goes with the session's data export and import and is removed by its delete (`exportHostData`, `deleteHostData`); a
clone or fork copies it (`SessionCopied`). An archived session's pages still serve (no worker needed).

There is no migration: artifacts written before 2026-11-12 stay in the session's files (space `artifacts`), unused.

## Tests

- `test/p2/artifacts.test.ts`: the tools; the frame route; a page's state whole for page and agent; code run in an open
  page; errors with the next message, once; a read-only guest reads; export and delete carry the data.
- `test/p2/ui-inline-artifacts.test.ts`: Chromium. Markdown and html in place, fitted and capped at 70vh, for a guest
  too; a page scrolled out and back in keeps its height and the reader's place; an inline counter page changed and
  selected by the owner (saved, carried) and read-only for a guest; a deleted artifact.
- `test/p2/ui-views.test.ts`: the glyph-editor-style page's state and selection round trip.
- `test/p2/ui-viewers-search.test.ts`, `ui-command-menu-sharing.test.ts`: the side panel, the commands, a reader
  opening one in the side panel.
- `test/p2/fork-clone.test.ts`, `tui-p11.test.ts`.
