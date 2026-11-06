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
