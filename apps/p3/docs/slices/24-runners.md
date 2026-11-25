# Slice 24: Worker runners

**Goal.** Where a session's worker runs is pluggable: the local process (the default), a remote machine (a VM, a
service like exe.dev, over SSH or a socket), later a Cloudflare Durable Object. A runner is easy to write.

**Decided (owner, 2026-11-15):**

- A runner is a plugin contribution to a registry in p3's kit (the kit is copied into p3): start a session's host
  somewhere and hand back its link, stop it, report its state and keep-alive. A session's row names its runner;
  local fork is the default.
- A runner gets everything from the server: the full worker bundle to deploy (the worker base and the current plugin
  scripts), then each changed plugin bundle as a rollout step, and its start data. A runner writes no build logic of
  its own and resolves nothing from disk.
- One runner may host several sessions (several session hosts in one process or machine; Chord's hosts are not
  processes, `apps/p3/test/topology.ts` already runs them in one process). Isolation between them is the runner's
  stated property.
- Chord needs nothing new for it: a route's `resolve` already returns a link per address, and admission, reload and
  rollout sit above it. What is fork-specific today is the kit's workers component, which becomes the local runner.
- Durable Objects come last: no `eval` (plugins composed at build time), hibernation, their own SQLite; Chord's
  "Durable Object profile" (design §24, open) must be decided first. Remote machines come first.

**Not now:** the server stays the hub every client and worker talks through, so it is the bottleneck when scaling up
(many runners, many sessions). A solution (direct links from clients to runners, several servers) is wanted later and
recorded here so the runner interface does not rule it out.

**Depends on:** the kit copied into p3 (slice 1 redo), slice 18 (session lifecycle: stop, keep-alive).

**Read first:** `packages/chord/docs/design.md` §3 (routes), §21 (rollout), §23 (workers, worker bases), §24
(Durable Object profile); `packages/chord/src/node/workers/README.md`; Fable's critique on placement
(`/home/badlogic/chord-notes/research/chord-critique-fable.md` §3.9, private).
