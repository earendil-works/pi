# Slice 2: apply from anywhere

**Goal.** Applying plugin changes is an object, not a start-script call: the kit serves `AppChanges` (the marks and
`apply()`, for the owner), so a page, a terminal and later the agent can see what changed and apply it. The reload
tests begin: editing a plugin of slice 1 while it is used loses nothing. The `p3` command restarts the server when
base code changed.

**Builds:** `AppChanges` in the kit (Chord decision "The kit serves the reload control", 2026-11-11, not built:
`chord.app.changes`, owner only, state `marks` (`dirty`, `install`, `set`, `base`), `apply()` answering
`{ steps: { name, failed }[] }`); p3 re-exports it; `supervisor.ts` and the `p3` command (decision "Base entries are
named after what they are"); reload tests for the sessions plugin (server and worker facets) in the topology and end
to end.

**Depends on:** slice 1.

**Read first, in full:** design.md §21 (reload and rollout, loading plugins and the reload loop, the plugin model) and
§23 (the app kit: plugins, restart needed); `packages/chord/docs/decisions.md` (search "reload control", read that
entry); the kit's `app.ts` (`applyChanges`) and `src/node/plugins/` in full. From the archive: `reload-loop/book.md`
(what bundles what, what each edit does; Apply installs no npm dependency: the `install` mark), `step-0/book.md`
(decision 1, the reload suite's table), `step-0a/book.md` (built: stylesheets, conditions, the content-compared
restart mark).

**Open:**

- The agent applying: `AppChanges` serves only the owner, and a session's agent reaches the server as its `worker`.
  A worker variant gated by a lock (`locks.manage`-like), or the agent applies only through the owner.
- A cache for startup builds reverses the owner's decision "A" (design §23: nothing built is kept between starts);
  measure first.
