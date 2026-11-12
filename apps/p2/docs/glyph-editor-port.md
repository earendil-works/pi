# Bringing Max's glyph editor back

Max's glyph editor (gist `dgtlntv/0162ce4124d9286926b03a72d2cff052`) was a custom view: `glyph-editor.html` in a
sandboxed frame, its data in the view's state, and `glyph-editor-bridge.js` as the agent's code-mode helpers on top of
the `view` tool (`read`, `update` with `state`, `merge` and `html`). p2 removed custom views, view state, the view
library and rooms on 2026-11-12 (docs/views.md, docs/artifacts.md, docs/agent-plugins.md). There is no migration: an
open "glyph" view is gone after the update. This page says what to do before updating, and how to run the editor
again.

## Before updating p2

1. Save the unsaved glyphs: in code mode,
   `const B = eval(await tools.read({ path: '/root/work/glyph-editor/bridge.js' }))`, then `await B.save()`. The
   view's `edits` (glyphs changed in the editor and not yet written to the UFO) live only in the view's state and are
   lost with it.
2. Keep the page: `/root/work/glyph-editor/editor.html` is the source; if it only exists in the view, copy it out first
   (`view read` does not return HTML: take the newest version from the gist or the work directory).

## Now: the editor as an html artifact (same page, new helpers)

The page keeps working unchanged: html artifacts keep the page API `window.p2view` (`onState(fn)` with
`fn(state, from)`, `from` being `init` or `update`; `state`; `readOnly`; `setState(next | fn)`, saved after a short
pause; `select(summary, data)`; `clearSelection()`; `onDescribeRegion(fn)`), with the state stored with the artifact
(every version of the page reads it). Only the agent-side helpers change, from the `view` tool to the `artifact_*`
code-mode tools (namespace `artifact`; `describeNamespace("artifact")` gives the whole page API):

| bridge.js today | with artifacts |
| --- | --- |
| `tools.view({ action: "open", kind: "custom", id: "glyph", html })` | `const { id } = await tools.artifact_write({ kind: "html", title: "Glyphs", content: html })` (or give `id: "glyph"`), then `tools.artifact_open({ id })` (a pane beside the chat) or `tools.artifact_show({ id })` (in the transcript) |
| `tools.view({ action: "read", id })`, parsing `State:` out of text, cut at 40,000 characters (hence `edits` before `glyphs`) | `const { state } = await tools.artifact_html_state({ id })`: the whole state as an object, no text parsing, no cut |
| `tools.view({ action: "update", id, state })` | `await tools.artifact_html_set_state({ id, state })` (the open page gets it at once, `from` = `update`) |
| `tools.view({ action: "update", id, merge })` | read the state, change the keys, `artifact_html_set_state` (a read-modify-write: a glyph edited in the page in between is overwritten, as with `merge` before) |
| `tools.view({ action: "update", id, html })` (`reloadPage`) | `await tools.artifact_write({ id, kind: "html", title, content })`, or `artifact_edit({ id, edits: [{ old, new }] })` for small changes: a new version, the open page reloads |
| "Script errors its page logged" in `view read` | `await tools.artifact_html_errors({ id })` (and `artifact_html_logs` for console lines); new errors also arrive with the person's next message |
| the selection in `view read` | the selection arrives with the next message (`<views>` block), as before; `view_list` shows it too |

`readBig` stays only for reading `export.json` from disk (the `read` tool's 50 KB limit); the state no longer needs
it. `artifact_html_eval({ id, code })` runs code in the open page when a helper needs the page itself. What stays as
it was: `ge.py` (export, save, diff), the UFO sources, the `edits` overlay over the base `glyphs`, and the state's size
limit (256 KiB of JSON: one master must fit, as `ge.py`'s docstring says).

The artifact belongs to the session and travels with its export (and its clones and forks); it is listed in the
session's artifacts sheet, so it can be reopened after closing its pane (nothing is lost on close). People with
read-only links open it there too, on their own device and without saving changes.

## Later: the editor as a plugin

The proper version is a `glyphs` plugin (skill `writing-p2-plugins`): glyph documents in the server store keyed by
the session and the master, typed methods (`setGlyph`, `note`, `open`, `save`) the agent calls as code-mode tools
instead of read-modify-write on one JSON blob, the base master read from the UFO files instead of being copied into
state (no size limit), a conditional save so a glyph changed during a save stays unsaved, and several people editing
at once. Its glyph list can show in the artifacts sheet through `ArtifactKinds`. `apps/p2/docs/rooms-v3/book.md`'s
glyph chapter lists what it needs; most of it is now ordinary plugin code.

## The gist's other pages

- `space-invaders.html`: works as an html artifact as it is (the high score in the artifact's state).
- `pong.html`: used `p2view.live`, which is gone; real-time multiplayer is a plugin now (a server object running the
  ball, paddles as events).
