# Views

Views are panes next to the transcript that the person and the agent share. The transcript is one pane. A view shows
an item of a kind: a Markdown file, the working tree's changes, an artifact (an html page or a Markdown document the
agent wrote, docs/artifacts.md), or a plugin's item (a board, a game). The person arranges the panes as they like.
Their selections and annotations reach the agent with their next message. Plugin: `plugins/views`.

## What it does

- **The agent** opens and arranges views with code-mode tools in the namespace `view` (`tool.ts`, extension
  `p2-views`): `view_list` (the views, the last arrangement, selections, unresolved annotations), `view_open`
  (`{kind, item?, title?, id?}`, returns `{id}`; an existing ID shows that view again), `view_close`, `view_arrange`
  and `view_resolve`. Each returns a structured value. The prompt lists only the namespace's one-line description
  (code mode's section); `describeNamespace("view")` gives its instructions. Artifacts open as views through
  `artifact_open` (docs/artifacts.md).
- **View kinds** (`ViewKinds`, `@p2/app/v1/web`, `src/web/view-kinds.ts`): a web facet contributes
  `{ <kind>: { Pane } }`. A pane gets `PaneProps`: `session`, `item` (what the view shows: a file, a path, an
  artifact's or a plugin item's ID), `inline` (true in the transcript, false beside it), `view` (beside the transcript
  only), `editable`, `select`, `annotations`. Kinds:
  - `markdown`: a workspace file (`item`), rendered and rendered again when the working tree changes.
  - `changes`: the working tree's diffs, optionally only below the path `item`.
  - `html`, `md`: artifacts (the artifacts plugin's panes).
  - **A plugin's kind**: any other well-formed name (`ViewKindNameSchema`, lowercase, up to 64 characters). The worker
    accepts any name: a kind no loaded plugin registers shows "Unknown view kind" until one does (the page reloads onto
    a new bundle by itself). Multiplayer or persistent things are plugins (docs/agent-plugins.md).

  Each pane renders inside an error boundary (`PaneBoundary` in `Workbench.tsx`): a pane that throws shows its error in
  its own pane instead of taking the page down, and a reloaded plugin's new component starts afresh.
- **Listable items** (`ArtifactKinds`, `src/web/artifact-kinds.ts`): plugins that keep several items per session
  contribute an artifact kind (title, icon, live `useItems`/`useCount`, optional `Row` and `useRemove`, the view kind
  that opens an item). The artifacts plugin's top-bar button counts them and its side panel lists them; a row opens the
  item as a view (docs/artifacts.md).
- **Layout** (`layout.ts`, `Workbench.tsx`): areas of tabs inside splits.
  - On wide screens, a tab can be dragged into another area's tab strip or to one of its sides, and splitters resize
    areas.
  - On phones (narrow screens, below 700px) one pane shows at a time, picked from a strip of tabs.
  - Panes render as siblings in a fixed order (transcript first, then the session's views) and are only positioned.
    Rearranging never remounts them: a moved frame would reload, and the chat would lose its place.
- **Selections**: a text selection in a pane (`usePaneSelection` in `pane-kit.tsx`), or an html artifact's own
  `p2view.select(summary, data)`, becomes the view's selection. In an item shown in the transcript (an artifact a
  script showed) no view holds it: `selectInline` keeps it in the document's `inline` list, one per item (kind and
  ID), carried and listed as the views' are (`view_list` gives it with `view: "transcript"`).
- **Annotations** (`annotate.tsx`): the top bar's pencil turns on the annotation layer.
  - *Comment* and *Remove* mark the selected text in any pane, the transcript included.
  - *Draw* takes strokes over any pane. Each drawing is saved with the text found under it. An html page's frame
    describes its own region (`frameHandles`, the page's `onDescribeRegion`).
  - Quotes are highlighted with CSS custom highlights, inside frames too, through the bridge.
  - Drawings are drawn over their pane, stretched with it.
- **What the next message carries**: the send router `views` adds a `<views>` block after the person's text. The block
  holds the selections and annotations no message carried yet. Other plugins add their own blocks through
  `MessageContexts` (`contract.ts`, keyed by plugin, given the message being sent; e.g. the artifacts plugin's new
  page errors, the scope prompt's scope staged for that message), each carried once
  and noted on the message. The model sees the blocks, but the transcript shows only the person's text, with a note
  (entry kind `p2.view-input`, `TranscriptEntries`). The composer's chip shows what will go along; its × drops it. In
  chat mode, the chat-mode router takes the message first, so no context goes along.

## Who owns what

| Fact | Owner | Where |
| --- | --- | --- |
| The session's views, selections, annotations | the session's worker | Durable session document `p2.views` |
| The layout, the views hidden on a device | each device | `localStorage` `p2.views.layout:<session>` |
| The agent's last arrangement | the session's worker | `p2.views` (`arrangement`: its layout and stamp) |
| What a view shows | the item's owner | a workspace file, the artifacts plugin's store, a plugin's store |

People who may send in the session (the owner, full guests) open and close views, select and annotate. Viewers read
everything; a read-only guest opens artifacts in the artifacts side panel on their own device instead (docs/artifacts.md).

`Views` is at version 4 (3: `View.item` in place of `path`, no view state, no library, no `report`; 4: `inline` and
`selectInline`); its `accepts` (`VIEWS_ACCEPTS`) serves pages built with versions 1 to 3 (`item` shown to 1 and 2 as
`path`). Stored views of the removed
`custom` kind stay in old sessions' documents and are not listed (`liveViews`).

The layout is per device because a phone and a desktop want different arrangements. A device's `focus` stamps track
`View.focus`, which grows each time the agent opens or shows a view. When it grows, devices show the view again and
bring it to the front. A phone switches to a view only if the agent showed it in the last minute, so opening a session
shows its chat.

The agent can also arrange the panes (`view_arrange`, `layout.ts` `arrangementError`). A node is a view ID
(`transcript` is the chat), `{ tabs: [IDs], active }`, or `{ row | column: [nodes], sizes }`. Each device adopts the
newest arrangement once (`Layout.arranged` keeps its stamp) and hides the views it leaves out. The person may
rearrange afterwards, and a later arrangement replaces their layout again. Phones keep showing one pane at a time.

## Removed (2026-11-12)

Custom views (HTML the `view` tool wrote, with view state), the owner's view library, rooms and view principals, the
view kit and the `/view-frame` route are gone; html artifacts take the custom view's place with the same page API
(`window.p2view`). Max's glyph editor moves over as described in [glyph-editor-port.md](glyph-editor-port.md). The rooms
design docs (`rooms-v2.md`, `rooms-v3/`, `rooms-v3-model.md`) stay as history.

## Core hooks it uses

- `src/web/AppLayout.tsx`: `<Slot name="workbench">` wraps the owner's notices and the `main` slot. Without the
  plugin, the chat shows as before. The panes use `overflow: clip`, not `hidden`. A `hidden` pane would be a scroll
  container: `scrollIntoView` would scroll it, and it would reset the phone layout's `touch-action`, which the
  drawer's swipe needs.
- The top bar's `.topbar` keeps its order above the notices inside the chat's pane (`views.css`), as
  `owner-notices.css` orders it in `.main`.
- `plugins/chat/web.tsx`: the top bar's `view-actions` slot holds Annotate, and Views once the session has views.
- The composer's `composer:views` chip, `ToolActivities` (`view_*`), `TranscriptEntries` (`p2.view-input`, web and
  TUI), `SendRouters` (`views`).

## Tests

- `test/p2/views-layout.test.ts`: the layout functions.
- `test/p2/views.test.ts`: the tools (open, list, close, arrange, resolve; code mode only), selections and annotations
  carried once.
- `test/p2/ui-views.test.ts`: Chromium. Panes and tabs; an html artifact written against `window.p2view` as the glyph
  editor is (`onState`, `setState` with a function, `select`): its state both ways and its selection chip; comments
  with highlights; a drawing over the transcript; dragging a tab beside another area; phones.

## Open

- The TUI shows no views (only the note on messages).
- Drawings stay where they were drawn in their pane's viewport: they do not follow scrolling.
- A Markdown view renders the file and does not edit it: the person comments, and the agent edits.
