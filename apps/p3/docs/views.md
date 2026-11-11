# p3 views: the web and terminal UI model (proposal)

Status: proposal for the owner, 2026-11-10, by the p3 session (8b6ab5cc). Input: p2's views (Max, commit da57c1662,
`apps/p2/docs/views.md`), the owner's direction relayed by the phone session, and p3's earlier decisions (`decisions.md`:
"groupings and views are plugins", "UI is contributed from a plugin's facet", "Efficiency is a requirement").

## 1. What p2 taught us (kept)

- **A pane is a view; the transcript is a view too.** The person and the agent share them; the agent opens, reads,
  updates and arranges them with one tool.
- **Rearranging never remounts.** Panes render as siblings in a fixed order and are only positioned; a moved iframe
  would reload and the chat would lose its place.
- **Layout is per device; the agent's arrangement is adopted once** per device, then the person may rearrange.
- **Phones show one pane at a time** from a tab strip.
- **Selections and annotations travel with the next message** (a block the model sees; the transcript shows a note).

## 2. The model: three concepts

1. **View kind:** a typed definition in a plugin's contract file: a name and params (a flat record, like a contract's).
   An instance is a kind plus params, `Transcript({ session, conversation })`, `Changes({ session, path })`,
   `Sidebar({})`. That is the page's route `(kind, params)` from the groupings decision.
   - **Session or global follows from the params,** with no flag: a kind whose params name a session is a session view
     (it belongs to the session's workspace, its state is the session's); a kind without one is global (an alternative
     sidebar, an inbox, a dashboard).
2. **Renderer:** a component per kind and surface, contributed from a plugin's web or terminal facet to the registries
   `WebViews` and `TuiViews` (keyed by kind name; the first plugin by name wins, a conflict is reported). A kind
   without a terminal renderer shows its title and a fallback in the terminal (section 5).
3. **Slot:** a view kind may declare named extension points in its contract file, each a registry its renderer reads:
   the transcript declares `TranscriptEntries` (a renderer per entry kind) and `ComposerParts`; the sidebar declares
   its groupings. Plugins contribute or replace parts there instead of replacing the whole view.

```ts
// plugins/changes/contract.web.ts: a prebuilt view kind, its params, and its web renderer's props
export const Changes = defineViewKind("changes", { session: str(), path: str() });

// plugins/changes/web.tsx: the facet contributes the renderer (UI comes from facets, decision of 2026-11-06)
self.contribute(WebViews, { [Changes.name]: ({ params }) => <ChangesPane session={params.session} path={params.path} /> });
```

`defineViewKind`, `WebViews` and `TuiViews` are the views plugin's (Tier 2, a required-root plugin), built on Chord
registries; nothing is added to Chord.

## 3. The workbench and the escape hatch

The **workbench** (base code of the page, the one root slot) owns what must always work, and plugins own everything
inside a pane:

- **Pane chrome is the workbench's:** a pane's title, its close and menu buttons, and the tab strip are drawn by the
  workbench, never by the view, and every pane renders inside an error boundary. A view that throws, hangs its
  renderer or draws garbage can always be closed.
- **Fixed views:** the workbench keeps a small fixed bar (views menu, layout reset, safe mode) that no layout or
  plugin removes. This is the "always there" part.
- **Safe mode:** a URL flag or the fixed bar's button renders only base views (the transcript, the composer, the
  plugin manager) with every agent-made view and every plugin-contributed layout off, until the person leaves it. The
  plugin manager can then disable what broke the page.
- **The layout is a plugin:** sidebar, transcript and panel is the default layout plugin; another layout (or an agent
  arrangement) only places panes. A broken layout falls back to the default one.
- **Layouts are apps (owner, 2026-11-10):** an app is a layout of views for one purpose (coding, the triage agent, a
  game studio for the kids, a family planner), each a different view on its slice of the instance's sessions. The
  person switches apps (an app switcher in the fixed bar); opening a thing shows its view inside the current app. No
  layout belongs to a kind of thing.

## 4. Prebuilt and agent-made views

- **Prebuilt views** are ordinary plugins of the required root: transcript, composer, changes, markdown file, file
  browser, terminal, session sidebar, inbox. Their contract files declare their kinds and slots.
- **Agent-made views, two tiers** (decision needed, section 7):
  - **Sketch (default):** the agent writes HTML and JSON state, as in p2. It runs in a sandboxed iframe, but p3 injects
    its design system: the CSS tokens and a set of p3's components as custom elements (buttons, lists, tables, form
    fields, the code and diff viewers), so a sketch looks like p3 without reaching p3. The bridge carries state,
    selections and annotations, as `window.p2view` does.
  - **Promoted:** the person asks to keep a sketch as a real view. The agent turns it into a plugin (a web facet and,
    if needed, a terminal facet) in the user's plugin root or in the session's own plugins; it is built and loaded
    by the plugin loader, runs in p3's realm with full access to p3's components and objects, and reloads like any
    plugin. Installing it is the owner's choice, as for any plugin.
- **Where they live:** a session's sketches are the views plugin's session data (the worker's store, HTML as the
  session's files); saved sketches are the owner's library on the server; promoted views are plugins.

## 4a. Views as Chord clients (owner, 2026-11-10)

A sketch's frame is a Chord client host of its own, with its own link (its own WebSocket) to the server and its own
principal: a view principal `{ kind: "view", session, view, for }` (`for`: whom it is shown to, for names and presence
only; a view principal never gets that principal's powers). Objects give view principals a variant of their own, as
for guests; what has no view variant (sending messages, answering questions, approvals) a view cannot reach.

- **Its link:** the page asks the server for a short-lived token scoped to that view and hands it to the frame through
  the postMessage bridge; the frame opens its link with it (its origin is opaque, so the server's links endpoint
  admits view links by that token alone). Not relayed through the page's link: that would stamp the page's principal.
- **The socket is opened on demand** (owner, 2026-11-10): a frame connects only when its code first asks for its
  room or for its plugin's objects; a sketch that only renders and saves its state uses the page's bridge over the
  page's connection and opens no socket.
- **One socket per view, not piggybacked** (owner): a fast view (a game) never queues behind the page's traffic at the
  TCP level, nor the page behind it. A meetup with 70 guests and two views is 210 sockets, which the server handles;
  piggybacking through the page (Chord marking a relay's origin as a weaker principal) is deferred until a case needs
  it.
- **Revocation:** closing the view or revoking its viewer revokes its view principals; their objects end.
- **The room** is an ordinary server object with a view variant, one per open view. Words (owner, 2026-11-10: one
  term per thing): **presence** (who has the view open, and the **leader**, the oldest peer), **peer state** (what each
  peer publishes, written only by that peer, latest wins), **messages** (ordered, lossless, kept until every present
  peer has seen them, or since the last snapshot for a log room), the shared **clock**, and **methods** a sketch offers
  the agent (a name, a description, an argument schema); one use of a method is a **call**, which the leader runs and
  whose result goes back to the caller, nothing stored.
- **Room kinds** come from plugins: a **live** room (presence and peer state: drags, cursors, games), a **log** room
  (ordered messages since the last snapshot: turn-based games, a shared canvas), and rooms with **server rules** (the
  plugin's server code applies and checks each message and writes the snapshot: collaborative text, as in
  badlogic/jot's id-based editing). Every kind has presence, the leader, the clock and methods. A netcode helper and a
  text-editing client ship in the view kit.
- **The view kit:** React, p3's presentational components (props in, events out; none holds a Chord reference) and
  the CSS, built by the server as one content-hashed bundle and loaded by a frame from a public endpoint (cached once;
  the endpoint answers the opaque origin with an open cross-origin header).
- The postMessage bridge to the page keeps only what belongs to the page: the token, state saving, selections and
  annotations.

## 5. Phones and terminals

- **Phones:** one pane at a time from a tab strip (p2's rule); global views (the sidebar) open as a drawer; the fixed
  bar stays. A layout is per device class and per device.
- **Terminal:** the same kinds and the same agent arrangement, rendered by `TuiViews`: one pane at a time with a
  switcher, and splits on wide terminals. A kind without a terminal renderer shows its title, its text summary if its
  plugin provides one, and a link to open it in a browser. Sketches have no terminal rendering (they are HTML); a
  promoted view may bring a terminal facet.

## 6. Efficiency

- A pane holds only what it shows; page-wide objects are held once by the workbench (`efficiency.md`, section 2).
- Hidden panes stay mounted (no remount on rearrange) but stop holding expensive state while hidden, through a
  visibility signal the workbench passes; a sketch's iframe is kept, a terminal or diff pane releases its stream.
- The phone renders only the visible pane's heavy parts.

## 7. Decisions for the owner

1. **Agent-made views: two tiers** (sketch in a sandboxed frame with p3's design system injected; promoted to a plugin
   to run in p3's realm). Reason: an agent-written page in p3's realm runs with the viewer's credentials, also a
   guest's in a shared session, and with whatever a prompt injection put into the agent; the frame keeps that out,
   and promotion is an explicit install. Alternative: always in p3's realm (one tier, full components, no isolation).
2. **Safe mode and workbench-owned pane chrome** as the escape hatch.
3. **Session or global decided by a kind's params**, not by a flag.
