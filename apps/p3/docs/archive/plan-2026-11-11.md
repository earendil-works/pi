# Plan, from 2026-11-11

The owner's frame: p2 is the sloppy playground where we experiment; next week we decide from what we saw there what
goes into p3. By then p3's skeleton is in place, so the team can start implementing. Issues are written together at
the onsite, not before.

## 1. Events and rooms (running)

1. Chord: call windows by trust and events (`packages/chord/docs/events/spec.md`, reviewed twice). Building
   (subagent `events-builder`), then a code review by gpt-6-astra and gpt-6.1-sol, then commit (owner: commit and deploy
   allowed for this work).
2. p2 rooms with events (spec section 7): `room.emit`/`onEvent`, the motion outbox, pipelined sends with outcomes,
   monotonic acks, clock re-sampling, quiet reconnects. Deploy to the phone.
3. Pong version 7 (spec section 8), to judge how real-time play feels.

## 2. p2 as views (this week)

Convert p2's UI to the views model (`apps/p3/docs/views.md`, Max's p2 views): every pane a view, layouts as apps the
person switches between, slots for parts (sidebar groupings, transcript entries, composer parts), the workbench's pane
chrome, fixed bar and safe mode. Starts with the five open questions of `/tmp/p2-as-views.md`, one at a time. Max
should know (views are his plugin). An Elanor mockup of p2 (`elanor-research`) shows what it could look like.

## 3. p3 skeleton (in parallel, in place next week)

Step 0 (`docs/step-0/book.md`, first edition 2026-11-06, never built), revised:

- Base entries named after what they are (decision "Base entries are named after what they are"): `server.ts`,
  `supervisor.ts` (the `p3` command; restarts the server on request or crash), `worker.ts` when workers come.
- Minimal web and terminal sides: the `hello` and `reload` plugins with a web facet (Elanor components, depending on
  the research) and a terminal facet, both reloading in place.
- The reload control (step 0's decision 1, the kit's `AppChanges`): open, for the owner.
- Efficiency (decision "Efficiency is a requirement"): compression at the origin on, page-wide holds outside keyed
  subtrees, measured startup and memory.
- Tests isolated and deterministic; long tests (browser, end to end) behind a flag that CI skips unless a nightly or
  an explicit run turns them on.

Then small steps, each its own spec: a session list on the server, a worker per session, the harness with a fake
model and a minimal chat, real models.

## 4. Next week

Decide from p2 what goes into p3 (views, layouts as apps, rooms, events, how much of the app kit to keep); write the
issues at the onsite.

## Parked until then

Sharing decisions (`sharing.md` §3-§4), the shared wire holds design note (`efficiency.md` §3), the base-inventory
explainer's sessions chapter, Cristina's PR and sharing proposal, Radius single sign-in, the startup telemetry spec, the
agent operating the instance through typed contracts.
