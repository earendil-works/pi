# Work in progress on branch `skeleton` (2026-11-23)

The open work, in order, with who builds it. Design: `base.md`, section "Things" (decided with Mario on 2026-11-23).
Items 1 to 3 are in progress under one brief, `/tmp/p3-base/follow.md` ("things, round 2": how things come to exist,
"in all my sessions", a session follows one party); the contracts in `plugins/sessions/contract*.ts*` are fixed for
it. Remove this file when the list is done.

## 1. Things with one id, owners, links, creation and following (builder "server"; in progress)

- Sessions plugin: the things (`id, kind, name, owner: person | group | pi | none, everywhere`), the links
  `(session, thing, by)`, the options per session, thing and party. Who manages a thing; `keep`, `remove`, `delete`.
- How things of a kind come to exist (`creation`: `content`, `person`, `plugin`), checked at `SessionThings.create`,
  `SessionFacts.create` and `MyThings.create`; `ensureThing` for a plugin's one thing.
- `everywhere` and `follows`: the followed things wherever a session's things are read (`SessionInfo`,
  `SessionFacts`, `ThingAccess`), `follow` with `keep`, a followed party that stops writing gives nothing.
- Named queries `things.everywhere` and `things.ofKind`, with their plans. Tests for every rule of base.md "Things".

## 2. Kinds on this model (builders "notes", "canvas", "harness"; in progress)

- Notes and canvas: `creation: "content"`, what is in a thing keyed by its id, a `delete` hook, a list tool and
  tools taking the thing's id, write tools only while some thing allows them.
- Tools: the coding tools as a `plugin` kind, one thing, the Pi's, everywhere (`ensureThing` at the plugin's start).
  The test login and the deployment's dev login likewise.
- Harness: one part per kind (now the things plugin's `ThingHarnessParts`); making things is the things plugin's
  `make_thing`; nothing left of making for someone, keeping, or listing whom to make for.
- `plugins/checklist/` (builder "notes"): the small example kind of `base.md`, with tests.

## 3. The page (builder "page"; in progress)

- The session's things: "New" offers the content kinds; "Add" picks one of the caller's things; followed things
  shown as from whom the session follows, without Remove; "Keep" on content; for the owner whom the session follows.
- `MyThingsView`, opened from the person menu: the list with search, "New" (a `person` kind, for whom, the kind's
  `Create` view), "In all my sessions", rename, give away, delete, where each thing is used.
- The coding app no longer passes the coding tools: its sessions follow the owner who made them.

## 4. Then

- base.md: a "Built" section (what exists and is tested), the benchmark numbers.
- The video re-rendered (bring/keep/options walk-through with the real notes and canvas, the layout, costs).
- Final review by Fable and Astra of the whole branch; fixes; the acceptance test (a fresh agent writes an app and a
  kind against `/v1` and base.md).
- Known leftovers: the sessions plugin's size (the apps catalog's per-app plumbing), the page's size (Elanor imported
  whole), the harness's close error after a reload, the pane remount losing the transcript's scroll.

## 5. Open, with Armin

Not built in this round, and not to be made worse by it: the points of the two reviews of the things model that
tonight's decisions did not settle, and the open problems of following. To decide with Armin, then build.

- The reviews, verbatim: `/tmp/p3-base/review-things-fable.md`, `/tmp/p3-base/review-things-astra.md`.
- Merged, each with an example, the choices and a recommendation: `/tmp/p3-base/open-issues.md`. In short: content's
  options limit no writer and "keep" takes it over; "remove" deletes content without saying; add, the last remove
  and keep at the same moment; a thing whose hooks have not finished; what stays when someone leaves; what "where
  it is used" shows; a kind forgetting that a reader only reads; tools made from an old list; and how a session gets
  things without adding them by hand (following, and what else it could be).

