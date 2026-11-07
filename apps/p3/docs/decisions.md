# p3 decisions

The owner's decisions for p3, newest last. Chord decisions are in `packages/chord/docs/decisions.md`; the state of p3
and its working rules are in `handoff.md`.

- **Work on branch `p3` in `/home/badlogic/pi`, no worktrees (owner, 2026-11-06: "no worktree. work in a branch in the
  pi folder"):** the shared checkout is switched to `p3`; p3 work, and Chord changes p3 needs, are committed there and
  pushed to `origin/p3`; Chord changes are brought to main afterwards. Build subagents work in the same checkout.
- **Reloads first (owner, 2026-11-06: "first order is actually the whole reload shit. that needs to be smooth and
  perfect ... keep [server restarts] to its absolute minimum"):** base code is vocabulary (the API re-exports Chord's
  plugin surface once; the principal, `defineFacet`, host kinds; the start script, the worker entry, a web entry
  rendering one slot); every behaviour, the page's shell included, is a plugin. Registry tokens, contracts and helpers
  live in the contract file of the plugin that serves them. An object owning a native sits in a small plugin of its
  own; the logic around it in other plugins, read at use. A step is done only when editing each of its plugins during
  use loses nothing and leaves the kit's restart mark (`plugins.state.base`) false.
- **Baby steps (owner, 2026-11-06: "we want baby steps, not humongous steps, we should start with something
  simple"):** step 0 is the kit server (own port and data directory), the owner's sign-in and one page plugin showing a
  value from a server object, done when editing it on the page and on the server reloads it in place without a
  restart (the reload test every later step keeps green). Then one small step each: a session list, a session worker,
  the harness with a fake model and a minimal chat, real models, and on. The first spec draft (the whole skeleton at once)
  moved to `docs/map/`: a map of where the steps lead, not a spec.
- **Principals are `server`, `worker`, `user`, `guest` (owner, 2026-11-06):** `{ kind: "server" }`, `{ kind: "worker";
  session }`, `{ kind: "user"; id }`, `{ kind: "guest" }` reserved until sharing is designed. The owner is the first
  user: the kit's owner link signs in as the user p3 names (Chord decision "The kit's owner is a principal the app
  chooses").
- **Keep the app kit, change it where it does not fit (owner, 2026-11-06: "ok"):** p3 starts with `startServer` and
  `startWorker`; gaps found (the owner principal; later a plugin's access to its host's store and root scope,
  keep-alive counts from plugins, an "apply changes" object) are fixed in the kit, each a Chord decision.
- **UI is contributed from a plugin's facet (owner, 2026-11-06: "A"):** a page or terminal plugin contributes its
  components from its facet's setup; objects in a page supply data (held with `useHold`), never the UI itself. Reason:
  a facet's contribution is swapped in one update on a reload, always styled; an object's UI stays old until its
  successor is live and can show unstyled meanwhile (Chord decision "A restarting page object's old UI may show
  unstyled").
- **Code is committed only after the owner reviewed it; docs, specs and decisions without (owner, 2026-11-06).**
- **Base entries are named after what they are (owner, 2026-11-06: "i want things to be named after what they are"):**
  `server.ts` (the server: `startServer`), `worker.ts` (a session worker: `startWorker`), `supervisor.ts` (runs the
  server as a child and starts a fresh one on request or after a crash, so "restart needed" can be acted on from the
  page); the `p3` command runs the supervisor. To be specified in step 0b.
- **Startup building is measured with telemetry (owner, 2026-11-06):** spans for a server start (store, each base
  build, plugin discovery, each plugin build, the load), each worker start and each Apply, in the kit's telemetry
  store; to be specified as a small Chord change.
- **Requirement for the skeleton: groupings and views are plugins (owner, 2026-11-07, relayed by session cbe4592b from
  the owner's discussion with Christian, Max and David):** plugins contribute kinds of groupings (sessions per
  env/cwd, projects, Discord servers, recent, ...), each grouping any addressable thing (sessions, envs, MCP servers,
  project files) and rendering its own header and extras, without stepping on other plugins' groupings. Selecting an
  addressable thing shows a view of it that plugins define: the main area is not always a transcript (an env: a file
  browser, terminals, later VNC). Transcripts stay central; layouts must allow less transcript (an agent may compose a
  view). The container (a sidebar or not) is open. Skeleton consequence: the page's route is a `(kind, id)` of an
  addressable thing, the main area renders the view registered for that kind, group kinds and views are registries (web
  and terminal). Access policies are out of scope for now but must fit later (session resources). Sketch: session
  cbe4592b's artifact `p2-sidebar-groups`.
  Addendum (owner, 2026-11-07, relayed by cbe4592b): go radical. The layout itself is plugin-defined (sidebar +
  transcript + panel is one layout among others, shipped as the default "so as not to rattle cages"); the data model of
  addressable things, groupings and views is the point and must allow free composition, also where the terminal cannot
  show all of it; access control (which resources a project or session may use, who may see or do what) must attach to
  the same model later, not be designed separately.
