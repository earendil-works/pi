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

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

- **blocking:** `map/book.md:381-438` (HostRuntime/KeepAlive), `merged.md` §2 #14, design §18; an owner decision.
- **Chord dec.:** "Slice 8 is Registries and `host.root`" (1710), "Slice 6b: owner names and claims" (1730) and
  "claims per table" (1750) (`StoreStorage.open(store, Harness.name, ctx)`), "Slice 8 D2 and D3" (1766: `host.root`,
  `chord(fn, context)`), "Q6" (633), "p3 notes, 2026-11-02" (2413: branches as forks, `context: "inherit"`), "Note for
  p3, moving a session" (573), "App authoring rules confirmed by the p2 audit" (2651).
- **design:** §8 `ctx`, §20 "Input into running work", §14-§15.
- **source:** `packages/durable/src/harness/types.ts`, `registry.ts`; `packages/chord/src/node/app/worker.ts:30`
  (`busy`).
- **archive:** `handoff.md:65-67` (tool access), `map/book.md:239-265` (`chord()`/`ChordRoot`), `:290-295`
  (providers shape), `:853-856` (pi-ai and Durable as worker host packages), `merged.md` §2 #6, #7, §4 Q4-Q6, Q9,
  `rundown/book.md:1524-1608` (the worker acts as itself, `authorOf`, the `<sender>` block).
- **p2:** `apps/p2/plugins/chat/`, `drafts/`, `tree/`, `status/`; `apps/p2/src/runtime/tool-access.ts`.
- **decide:** filters versus locks (2.2 #10), `scope` and new tool fields (2.2 #11).

**Open or to carry (docs audit):**

- Tool access (decision "Tool access"): `scope` stays; no new fields on tool declarations (this conflicts with the
  locks review's "a tool names its lock": an owner call in slice 6).
- Branches as forks in the session's store, `context: "inherit"` for subagents (Chord dec. 2413).
- A session moved between Pis: blocked tasks shown with their reason and an abort (Chord dec. 573).
