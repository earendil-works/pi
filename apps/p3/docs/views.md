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
