# Slice 3: talk to a session

**Goal.** The owner sends a message in a session and gets the agent's answer streamed, from the faux model, headless.

**Builds:** plugin `harness` (Durable's `Harness` in the worker on the session's store, opened paused and resumed
after the load; the extensions, models and environments registries; design §24), plugin `models` with the faux
provider only (pi-ai's `fauxProvider`, scripted per test), plugin `transcript` (a conversation's entries, send, the
queue while a run is busy, stop).

**Depends on:** slices 1 and 2.

**Read first:** design.md §24; `packages/durable/docs/spec.md`; Durable's `Harness`, `StoreStorage`,
`registryReader`; pi-ai's `providers/faux.ts`; p2's `src/runtime/durable.ts` as a reference of what is needed.

**Done when:** a run's answer arrives in order; a message during a run is queued; reloading `transcript` during a run
finishes the run on the old code; a server restart keeps the transcript.
