# Slice 3: talk to a session

**Goal.** The owner sends a message in a session and gets the agent's answer streamed, from the faux model, headless.

**Builds:** plugin `harness` (Durable's `Harness` in the worker on the session's store, opened paused and resumed
after the load; the extensions, models and environments registries; design §24; the `chord(fn, context)` helper with
its context key, §24 Q6), plugin `models` with the faux provider only (pi-ai's `fauxProvider`, scripted per test: an
unscripted request fails the test, decision "Tests are isolated and deterministic"), plugin `transcript` (a
conversation's entries, send, the queue while a run is busy, stop); the worker kind's host packages include pi-ai and
pi-durable.

**Depends on:** slices 1 and 2.

**Read first, in full:** design.md §17 (registries), §20, §24; `packages/chord/src/registries/README.md`;
`packages/durable/docs/spec.md`; Durable's `src/harness/harness.ts`, `src/harness/registry-reader.ts`,
`src/storage/store/storage.ts`; pi-ai's `src/providers/faux.ts`; p2's `src/runtime/durable.ts`, `src/hosts/worker.ts`
and `docs/tree.md` as a reference of what is needed. From the archive: `map/book.md` (The Harness and its decision 1,
The Fake Model, Chat, Reloads and Restarts), `base-inventory/explainer/book.md` (The Harness, What Is Offered),
`status-2026-11-09.md` §3 (the harness direction of 2026-11-09), `rundown/book.md` (What a Session's Worker Runs, The
Filters). Chord decision on subagents and `/tree` branches (`packages/chord/docs/decisions.md`, search "context:
\"inherit\"").

**Open (owner):**

- How the `harness` plugin gets its host's store, root scope, load signal and keep-alive: `map/book.md` decision 1
  recommends two kit registries (`HostRuntime { store, root, whenLoaded }`, `KeepAlive`). The harness as a plugin
  (p3 "Reloads first") contradicts design §24, which calls it base code; §24 is corrected with this slice.
- Worker liveness from Durable's wake state (`status-2026-11-09.md`: the worker hands its next wake to the server; a
  due wake starts it), here or in slice 11.
- Whether the 2026-11-09 harness direction stands (hooks and wraps always apply; phases security, transform,
  observe; a filter registry), or locks replace the filters (slice 6).
- pi-ai has no `source` export condition: the worker loads its `dist/` or a resolver like p2's.

**Done when:** a run's answer arrives in order; a message during a run is queued; reloading `transcript` during a run
loses nothing (the run continues, the view catches up); reloading `harness` during a run recovers it from its last
commit; a server restart keeps the transcript; branches as forks in the session's store (or moved to a later slice).
