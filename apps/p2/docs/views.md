# Views

Views are panes next to the transcript that the person and the agent share. The transcript is one pane. Views can show
a Markdown file, the working tree's changes, or a custom HTML view the agent writes, such as a glyph editor. The person
arranges the panes as they like. Their selections and annotations reach the agent with their next message. Plugin:
`plugins/views`.

## What it does

- **The agent** opens and changes views with the `view` tool: `list`, `open`, `read`, `update`, `close`, `resolve`,
  `save`, `saved`, `load`, `help`, `arrange`. Every request carries the tool's description, so it stays short. The custom view
  page API comes from `help`, which the description asks the agent to call before writing a custom view. There is no
  prompt section.
- **View kinds**:
  - `markdown`: a workspace file, rendered and rendered again when the working tree changes.
  - `changes`: the working tree's diffs, optionally only below a path.
  - `custom`: a whole HTML page in a sandboxed frame, with its own JSON state.

  Pane components come from the web registry `ViewKinds` (`kinds.ts`). Another plugin can add a kind there. The
  worker's schema still lists only these three.
- **Layout** (`layout.ts`, `Workbench.tsx`): areas of tabs inside splits.
  - On wide screens, a tab can be dragged into another area's tab strip or to one of its sides, and splitters resize
    areas.
  - On phones (narrow screens, below 700px) one pane shows at a time, picked from a strip of tabs.
  - Panes render as siblings in a fixed order (transcript first, then the session's views) and are only positioned.
    Rearranging never remounts them: a moved frame would reload, and the chat would lose its place.
- **Selections**: a text selection in a Markdown or changes pane, or a custom view's own `p2view.select(summary, data)`,
  becomes the view's selection.
- **Annotations** (`annotate.tsx`): the top bar's pencil turns on the annotation layer.
  - *Comment* and *Remove* mark the selected text in any pane, the transcript included.
  - *Draw* takes strokes over any pane. Each drawing is saved with the text found under it. A custom view's frame
    describes its own region.
  - Quotes are highlighted with CSS custom highlights, inside frames too, through the bridge.
  - Drawings are drawn over their pane, stretched with it.
- **What the next message carries**: the send router `views` adds a `<views>` block after the person's text. The block
  holds the selections and annotations no message carried yet. The model sees the block, but the transcript shows only
  the person's text, with a note (entry kind `p2.view-input`, `TranscriptEntries`). The composer's chip shows what will
  go along; its × drops it. In chat mode, the chat-mode router takes the message first, so no context goes along.
- **Library**: `save` keeps a view (kind, path, HTML, state) in `<data>/views/<name>.json`. `load` or the Views sheet
  opens it in any session. Owner only.

## Who owns what

| Fact | Owner | Where |
| --- | --- | --- |
| The session's views, selections, annotations | the session's worker | Durable session document `p2.views` |
| A view's state | the session's worker | Durable session document family `p2.view-state`, keyed by view ID; retired with the view |
| A custom view's HTML | the session's worker | the session's files, space `views`, path = view ID, versions never reused |
| The layout, the views hidden on a device | each device | `localStorage` `p2.views.layout:<session>` |
| The agent's last arrangement | the session's worker | `p2.views` (`arrangement`: its layout and stamp) |
| Saved views | the server (owner) | `<data>/views/*.json` |

People who may send in the session (the owner, full guests) change views, select and annotate. Viewers read
everything.

The layout is per device because a phone and a desktop want different arrangements. A device's `focus` stamps track
`View.focus`, which grows each time the agent opens or shows a view. When it grows, devices show the view again and
bring it to the front. A phone switches to a view only if the agent showed it in the last minute, so opening a session
shows its chat.

The agent can also arrange the panes (`arrange`, `layout.ts` `arrangementError`). A node is a view ID (`transcript`
is the chat), `{ tabs: [IDs], active }`, or `{ row | column: [nodes], sizes }`. Each device adopts the newest
arrangement once (`Layout.arranged` keeps its stamp) and hides the views it leaves out. The person may rearrange
afterwards, and a later arrangement replaces their layout again. Phones keep showing one pane at a time.

## Custom views

`/view-frame?session&view&version` (server) serves version `version` of a custom view's HTML. The worker's
`ViewSource` reads it for the server only, as for artifacts. The route authorizes the viewer and refuses cross-site
requests. The page gets the artifacts' CSP sandbox: an opaque origin, scripts and https CDN resources, no frames, forms
or app identity. Two scripts are injected into the page: the artifacts' diagnostics, and the bridge (`bridge.ts`),
which defines `window.p2view`:

- `onState(fn)`: calls `fn(state, from)` now (`from` is `init`) and at each change made elsewhere (`update`: the agent
  or another device).
- `state`, `readOnly`.
- `setState(next)`: the page calls it on each edit; the page side saves it after 300 ms of rest.
- `select(summary, data)` and `clearSelection()`.
- `onDescribeRegion(fn)`: says what lies under a drawing. Without it, the bridge collects the labels and texts of the
  elements there.

The bridge also reports the page's text selection, for comments, and applies highlights.

The page's posts are untrusted. The page side (`CustomPane`) accepts them only from its own frame, saves only that
view's state, and checks the state's size (256 KiB of JSON). Script errors the page logs reach the view's `errors`, so
the agent sees them when it reads the view.

## Rooms

A custom view's frames may share a room on the server (presence, ordered messages, log and text rooms) and offer
methods the agent calls from code mode (`view_methods`, `view_call`): `docs/rooms.md`. The frame then opens its own
link with a view principal; the view kit (`kit/`) is the frame's side.

## Core hooks it uses

- `src/web/AppLayout.tsx`: `<Slot name="workbench">` wraps the owner's notices and the `main` slot. Without the
  plugin, the chat shows as before. The panes use `overflow: clip`, not `hidden`. A `hidden` pane would be a scroll
  container: `scrollIntoView` would scroll it, and it would reset the phone layout's `touch-action`, which the
  drawer's swipe needs.
- The top bar's `.topbar` keeps its order above the notices inside the chat's pane (`views.css`), as
  `owner-notices.css` orders it in `.main`.
- `plugins/chat/web.tsx`: the top bar's `view-actions` slot holds Annotate, and Views once the session has views.
- The composer's `composer:views` chip, `ToolActivities` (`view`), `TranscriptEntries` (`p2.view-input`, web and
  TUI), `SendRouters` (`views`).

## Tests

- `test/p2/views-layout.test.ts`: the layout functions.
- `test/p2/views.test.ts`: the tool, selections and annotations carried once, state bounds, the frame route, the
  library.
- `test/p2/ui-views.test.ts`: Chromium. Panes and tabs; a custom view's state both ways and its selection chip;
  comments with highlights; a drawing over the transcript; dragging a tab beside another area; phones.

## Open

- The TUI shows no views (only the note on messages).
- Drawings stay where they were drawn in their pane's viewport: they do not follow scrolling.
- A Markdown view renders the file and does not edit it: the person comments, and the agent edits.
