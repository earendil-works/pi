# Slice 2: apply from anywhere

**Goal.** Applying plugin changes is an object, not a start-script call: the kit serves `AppChanges` (the marks and
`apply()`, for the owner), so a page, a terminal and the agent can see what changed and apply it. The reload tests
begin: editing a plugin of slice 1 while it is used loses nothing.

**Builds:** `AppChanges` in the kit (decision "The kit serves the reload control", 2026-11-11, not built); p3
re-exports it; reload tests for the sessions plugin (server and worker facets) in the topology and end to end.

**Depends on:** slice 1.

**Read first:** design.md §21 (reload and rollout, the plugins component); the kit's `app.ts` (`applyChanges`) and
`src/node/plugins/` in full; `archive/step-0/book.md` (decision 1 there).

**From the archive:** `archive/reload-loop/book.md` (what bundles what, what each edit does), `archive/step-0/book.md` (decision 1 and the reload suite's table), `archive/step-0a/book.md` (stylesheets, conditions, the content-compared restart mark: built).

**Open:** whether startup builds need a cache (measure first: every start builds every plugin).
