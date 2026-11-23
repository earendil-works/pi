# Work in progress on branch `skeleton` (2026-11-23)

The open work, in order, with who builds it. Design: `base.md`, section "Things" (decided with Mario on 2026-11-23).
Remove this file when the list is done.

## 1. Things as owned records with one id (builder "server", then the others)

- Sessions plugin: a things store owned by the base: `things { id, kind, name, owner: person | group | pi | none,
  createdAt }`, links `{ session, thing, by }`, options per link and party (today's options table). One id: drop
  `ref` and the separate link id (`params { session, thing }` is the thing's id). Named queries: a session's things,
  an owner's things (searchable, paged), the sessions a thing is in.
- `defineThing` (renamed, done) kinds: drop `records`, `mayBring`, `ThingKindCatalog`'s split, `BringThings`'
  records logic; a kind gives `create(context) → content made` (or nothing: the base makes the id) and optionally a
  creation view (page). Unowned things are deleted (with their content: a `deleted` hook of the kind) when their last
  link goes.
- Contracts: `Sessions`/`SessionsStore`: `create(kind, name, owner)`, `add(session, thing)`, `remove(session,
  thing)`, `keep(thing, owner)`, `rename(thing, name)`, `delete(thing)`, `setOptions`; a person's own: what they and
  their groups own; the owner: also the Pi's. Access: who may add, keep, rename, delete (base.md "Things").
- Tests: everything in base.md "Things", including the same thing in two sessions with different options.

## 2. Kinds on the new model (builders "notes", "canvas", "harness")

- Notes and canvas: no owner columns; content keyed by thing id; `create`; content deleted with the thing.
- Tools: the coding tools as one Pi-owned thing the plugin creates at install; the dev-login plugin of
  p3-base.mariozechner.at likewise (a Pi or owner login).
- Harness: one gift per kind (in progress: `canvas_list`, `notes_list`, tools taking the thing id, fixed
  descriptions, write tools refusing what options forbid); the agent's create tools (`canvas_create`,
  `notes_create`, with `for`), the base tool listing whom it may create for, keep.
- A base helper for "writer if access is write and the option allows it".
- A third example kind, `plugins/checklist/` (Mario, 2026-11-23): exactly the shape of the artifact "A small kind of
  thing: checklist" (copy at /tmp/small-kind.md): contract.ts (kind, object), server.ts (its store, table and one
  `serveThing`), worker.ts (`checklist_list`, `checklist_tick` only while some checklist allows ticking), web.tsx
  (view, "May tick" form); with tests. Builder "notes", after item 1.

## 3. The page (builder "page")

- One "Add" in the session sheet: new (kind, name, for whom; the kind's creation view when it has one) or existing
  (mine, my groups', the Pi's; by session or search). "Keep" on unowned things. Rename on the thing.
- A person's "My things" view: what they own, where each is used, rename, delete.

## 4. Then

- base.md: a "Built" section (what exists and is tested), the benchmark numbers.
- The video re-rendered (bring/keep/options walk-through with the real notes and canvas, the layout, costs).
- Final review by Fable and Astra of the whole branch; fixes; the acceptance test (a fresh agent writes an app and a
  kind against `/v1` and base.md).
- Known leftovers: the sessions plugin's size (the apps catalog's per-app plumbing), the page's size (Elanor imported
  whole), the harness's close error after a reload, the pane remount losing the transcript's scroll.
