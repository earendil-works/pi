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

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

- **Chord dec.:** "The kit serves the reload control" (2734, the contract), "Reload restarts every affected object"
  (2620), "A reloaded UI part shows its loading state" (2715), "Slice 10's points" D11, D12, Q2 (1895: rollout reports,
  rollouts retry failed workers), "The app kit, point 5" (2303).
- **decisions.md:** "The agent writes plugins" (the plugin tools apply through the same path).
- **archive:** `org-managed/details.md:2192-2209` (one base object for installs/Apply/plugin writing),
  `org-managed/book.md:63-82` and `details.md:386-447` (later `plugins { roots, admit }`), `reload-loop/book.md:182,
  215-216` (the install gap), `step-0/book.md:326-333` (the reload suite; it is a browser test, so decide what is
  headless here).
- **source:** `src/node/plugins/install.ts`, `watcher.ts`, `discover.ts`.
- **p2:** `apps/p2/plugins/dev-tools/` (`reload_plugins`), `apps/p2/docs/agent-plugins.md`.

**Open or to carry (docs audit):**

- Installs, Apply and the plugin-writing tool through one base object (`archive/org-managed/details.md` 2192-2209):
  `AppChanges` as that single path, with room for the loader's `admit` and more roots later (slice 17).
- Content-compared plugin marks (step-0a carry-over); the old reload suite was a browser test: decide what is headless.
- From the t3code comparison (private, `/home/badlogic/chord-notes/research/t3code-customization.md`, if the owner
  agrees): escape hatches outside the page (disable a plugin from the command line, start without user plugins) and
  undo by generation (keep each applied version of a plugin).
