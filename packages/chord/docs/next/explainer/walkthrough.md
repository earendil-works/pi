---
title: Chord v2
kind: walkthrough
kicker: Walkthrough · Chord v2
subtitle: Build an app like p2 on Chord v2 and pi-durable, one concept at a time, with a tutor that draws the figures and asks the questions
model: anthropic/claude-sonnet-5-5
sources:
  - packages/chord/docs/next/explainer/book.md
  - packages/chord/docs/next/design.md
  - packages/chord/docs/next/decisions.md
  - packages/chord/docs/next/layer-1.md
  - packages/chord/src/next/contracts/README.md
  - packages/chord/src/next/contracts/*.ts
  - packages/durable/README.md
truth: treat Chord v2 as fully built as designed; ignore what the sources say about build status. redesign-decisions.md wins over design.md; design.md wins over the guide (book.md)
---

:::tutor
The learner knows pi-durable (harness, conversations, tasks, tools) and nothing about Chord.

Teach Chord v2 as a finished, working runtime: never say a part is "not built", "planned" or "the target design", even
though the sources say so in places. Open decisions may be mentioned as "still being decided" when a concept depends on
one.

The running example is Studio, introduced on the page before the first concept (see the introduction). Use it in every
concept and grow it step by step, as the guide book.md does chapter by chapter: read the matching guide chapter before
each concept, and check details in design.md and the decision log. Name the guide chapter in "Read more" lines.

Keep code short and complete enough to read on its own. Prefer one figure per concept: a sequence for message orders,
a flow for structure, a stepper for lifecycles.
:::

:::intro
#### What this is about

Picture **p2** (Pi Mobile): a web app for working with pi agents from any device. It runs on your laptop as one
**server** process. Every chat session gets its own **worker** process, and in each worker a pi-durable agent works
through its turns. You use it from **browser tabs** on your desktop or phone, and you can invite a colleague to watch.
Most features (a notes panel, file browsing, terminals, provider logins) are **plugins**.

Now you change one line in a plugin and press Reload, while an agent is twenty minutes into a task. The panel should
show the new code on every screen. The agent's turn, the running tool, the open connections and every bit of saved
data should simply continue. No restart, no lost work.

**Chord v2** is the runtime that makes this normal. An app on Chord is a set of **objects** spread over the server, the
workers and the tabs. Each object owns its data and its OS handles, declares what it needs, and Chord creates,
connects, reloads and ends it. Because Chord knows every piece of state an object has, it can swap the object's code
while its data stays.

#### The example: Studio

This walkthrough builds **Studio**, a small p2, on Chord v2 and pi-durable. It has the same three kinds of processes:

:::flow wide | Studio: one server, a worker per session with its agent, browser tabs as clients. The notes plugin is the first feature we build.
row "Clients" muted
box owner "owner's tab" "phone or desktop"
box guest "guest's tab" "read-only"
row "Server" accent
box server "server" "session list, access" accent
row "Workers" blue
box worker "worker S1" "agent + notes" blue
box worker2 "worker S2" "agent + notes" blue
arrow owner -> server "WebSocket"
arrow guest -> server "WebSocket"
arrow server -> worker "IPC"
arrow server -> worker2 "IPC"
:::

The first feature is a **notes plugin**: a panel where the owner adds notes to a session, a guest reads them, and the
agent can add notes through a tool. Each concept adds one piece to Studio, until it has everything a p2 needs: who may
do what, saved data, live updates, background jobs, logins, extension points, the agent, and reload.

#### How it progresses

1. **The pieces:** processes, objects, callers, shared data, saved data.
2. **Living objects:** references that survive restarts, revocation, computed values, OS handles, standing behaviour,
   background jobs, input from people.
3. **The app:** extension points between plugins, and the pi-durable agent inside Chord.
4. **Change:** reloading code while everything runs, evolving contracts, and what goes over the wire.
:::

# What we're building {#goal part="The pieces"}
Guide preface ("Before we begin", "Ten things to know"). Must cover, briefly and concretely: the reload scenario (phone,
agent mid-turn, guest watching, one-line fix, Reload) and why restarting processes or hot-swapping modules fails; the
one rule behind Chord (every piece of state, OS handle and running work has one owner, an object, and objects only
declare what they need); Studio's pieces from the introduction. Do not go into APIs yet.

:::check
1. Why is restarting the worker processes not a good way to load new plugin code?
+++ answers
1. It loses the agent's turn in flight, open terminals and connections (pi-durable would resume the turn, but the running tool and the connections are gone).
:::

# The shape of an app {#shape part="The pieces"}
Guide chapter I. Must cover: hosts (server, workers, clients), links, host kinds and placement, createHost/load/connect/accept/route,
clients reach workers only through the server, incarnations, keep-alive is app code (host.activity).

:::check
1. A tab wants an object that lives on worker S1, which is not running. What happens, in order?
2. Why does Chord have no listen() call?
+++ answers
1. The tab's call goes to the server; the address is not the server's, so it uses route(Session): authorize, then resolve starts the worker and returns a link plus principal; the server relays the hold, the worker builds the object and answers with a snapshot.
2. Entry points differ too much (loopback WebSocket, Radius channels, a Durable Object edge, memory links); each authenticates and calls accept.
:::

# A first object {#first-object}
Guide chapter II. Must cover: contract (name, input, placement, variants, version): the input is the object's key
among objects of its type, `placement` computes the host from it; schema helpers, facet and factory (a facet imports
Studio's own defineFacet from @studio/core), serve and get, methods return data, placement checked on both sides.

:::check
1. Two tabs of the owner ask for Notes of S1. How often does the factory run?
2. A caller with an outdated placement rule asks worker S2 for Notes of S1. What happens?
+++ answers
1. Once per principal key; the owner's two tabs on the same access path share the object, so once.
2. The provider runs the placement function itself and refuses with invalid/placement.
:::

# Who is calling {#principals}
Guide chapter III. Must cover: the app's principal type, links stamp principals, principal key in the object identity,
variants per principal, narrowing with inVariant/RefIn, and how a facet knows P: base code exports defineFacet bound to
P (bindFacet<P>()), every facet imports it, and host.load accepts only facets typed for its P.

:::check
1. Can a client send a principal field to claim it is the owner?
2. Why do guests not get an add method that throws "forbidden"?
3. The notes plugin's worker facet narrows principal.kind === "guest". Where does the type checker get Studio's principal union from?
+++ answers
1. No: a client's principal field is always overwritten by the link's stamp; only a trusted parent link may carry one.
2. Variants: the reader variant simply has no add member, and Chord refuses calls to members outside the caller's variant.
3. From Studio's base code: @studio/core exports defineFacet = bindFacet<P>(), the facet imports that one, and the worker's host.load accepts only facets typed for the same P.
:::

# One store, many views {#shared-store}
Guide chapter IV. Must cover: local types, the shared store pattern, attribution as data, argument validation for every caller (R7, Q15 open).

:::check
1. Where does "who wrote this note" come from if the store is local and has no principal?
+++ answers
1. The remote view knows the caller and passes the author into the store's method as data.
:::

# Writing it down {#documents}
Guide chapter V. Must cover: defineState, self.tx, drafts and ops, persistence only for stable identities, versions with migrate, tags, storage.

:::check
1. Why may a remote per-principal object not persist documents?
2. A schema changes but the version is not bumped. What happens?
+++ answers
1. Its identity includes the principal key, which changes (devices, grant revisions); persisted data needs a stable identity, so it lives in a local store or a host-lifetime object.
2. The stored fingerprint differs from the definition's at access, and the object fails broken ("schema changed without a version bump").
:::

# Holding on {#references part="Living objects"}
Guide chapter VI. Must cover: reference lifecycle, ref.state, parking, transient vs broken failures, backoff, ctx.

:::check
1. The link to a worker drops while a tab calls a method. What does the call do?
+++ answers
1. A call already in flight fails like on a disconnect; calls made while the link is down park until the reference is live again (up to the park deadline, 60 s), then fail unavailable.
:::

# Taking access away {#revocation}
Guide chapter VII. Must cover: revokedBy, host.revoke, propagation to children, no re-stamping, lasting denial in app data.

:::check
1. After revoke({ grant: "g1" }), Ann reloads her tab. Why does she not get access back?
+++ answers
1. revoke cuts only live access; the app's guest record is blocked and authenticate refuses it on the new connection.
:::

# Computed values {#derives}
Guide chapter VIII. Must cover: derives, the footgun (new objects for unchanged data), mapShared, container width, presence with host.references.

:::check
1. Why is items.map(stripAuthor) in a derive expensive on every commit?
+++ answers
1. It builds new objects for every unchanged note, so the diff walks and sends O(value) instead of O(change); mapShared keeps unchanged items identical.
:::

# Things the OS gives you {#natives}
Guide chapter IX. Must cover: natives with self.open, pure vs native objects, start data with constant, lifetime host, call-scoped natives.

:::check
1. What happens to a native object on reload, and why?
+++ answers
1. It restarts: its natives close and reopen with the new code, because old and new code sharing an OS handle would interleave unchecked.
:::

# Standing behaviour {#routines}
Guide chapter X. Must cover: routines (on, every, loop), serialized handlers, reconciling instead of notifying, pub/sub reports with ctx.incarnation.

:::check
1. Why does archiving a session not call notes.archive(session) directly?
+++ answers
1. A notification can be lost (worker not running, link drops, crash); a routine on the catalog's sessions reconciles from the current value, also after a crash.
:::

# Work that outlives the call {#jobs}
Guide chapter XI. Must cover: defineJob, the intent / effect / outcome sandwich, dedupe of unsettled runs (Q9), finish in current code, abort as a request.

:::check
1. A shell job's run crashes after writing the result entry. How is a duplicate entry avoided?
+++ answers
1. The external write carries a key derived from ctx.jobId (requestId shell:jobId), so Durable dedupes it.
:::

# Asking a person {#flows}
Guide chapter XII. Must cover: a flow is state, not a call; steps helper; the Questions service; decisions #9 and #11 open.

:::check
1. Why not a long-held step() call that returns the next login step?
+++ answers
1. A link drop fails it and the consumer cannot tell if it missed a step; state re-holds by itself and shows the current step.
:::

# Extension points {#registries part="The app"}
Guide chapter XIII. Must cover: registries, compose, who may contribute (R21), contributions that change, optional dependencies, HTTP component, channels, chunked transfers.

:::check
1. Radius needs forwards from the ports plugin, which may be missing. How is that expressed?
+++ answers
1. Radius owns a registry (radius.forwards) and ports contributes to it; without ports the table is empty.
:::

# The agent {#agent}
Guide chapter XIV. Must cover: the Harness as a core host-lifetime object, HarnessModels / HarnessEnvironments / HarnessExtensions registries, chord(fn, context) for tools, approval via Questions.

:::check
1. How does a Durable tool get a Chord ctx?
+++ answers
1. Through chord(fn, context): the host is in Durable's context under a context key, and host.root gives fn a ctx.
:::

# Reload and rollout {#reload part="Change"}
Guide chapter XV. Must cover: load, staging, commit, per-object swap or restart, rollback all-or-nothing per host, revisions, rollout order, updating vs contract_mismatch.

:::check
1. A staging error happens in one of three plugins being reloaded on a host. What runs afterwards?
+++ answers
1. The whole host stays on its previous code; rollback is all-or-nothing per host.
:::

# Changing contracts {#contracts}
Guide chapter XVI; the code is in src/next/contracts. Must cover: evolve, checkAccepts and mapping directions, binding by version and fingerprint, new history bases, the fingerprint normal form.

:::check
1. Which way does a state mapping go, and which way an args mapping?
2. Why can an input change not be adapted?
+++ answers
1. State: current to old (the old consumer reads). Args: old to current (the old caller sends).
2. The input is the object's address; changing it changes what the object is, so it needs a new history base and old consumers get contract_mismatch.
:::

# On the wire {#wire}
Guide chapter XVII. Must cover: messages and parts, relays rewrite only headers, one state message per commit per link, flow control (R19, Q3), size limits per part, the cost model, telemetry.

:::check
1. What does the server do with a state part it relays from a worker to a tab?
+++ answers
1. It reads and rewrites only the header (maps ids, groups parts per destination link) and forwards the part without decoding it.
:::

# Other ways to do it {#compared part="In context"}
Guide chapter "Other Ways to Do It" (after chapter XX). Must cover: Cordis (Koishi's plugin framework since 2019) and
DeepSeek Harness (dsh, everything is a plugin, built on Cordis): reversible effects on a plugin fiber, inject-based
services, reload by unload-and-load; dsh's durable session log and its "interrupted" crash repair. Then what the
guarantees are in practice (the chapter's section of that name): disposers run concurrently and are only as good as
their authors, listener order follows registration order and changes on reload, services are untyped strings and a
provider reload restarts all dependents, and reloading a core service stops live agents. Then the two differences that
matter: what survives a reload (Cordis: nothing of the plugin's or its dependents' in-memory state; Chord: a pure
object's data and running work) and reach (one process vs. a tree of hosts with principals). Say what Chord costs:
more concepts and machinery. A flow or table comparing a reload in both helps.

:::check
1. A Cordis plugin keeps a list of notes in a field of its instance. What happens to the list when the plugin hot-reloads, and what would the same plugin do on Chord v2?
2. Two Cordis plugins register waterfall listeners on the same tool-policy event; the first one short-circuits. What changes after the first plugin is hot-reloaded?
3. Why does an app like p2 need Chord's multi-host model, when dsh runs its plugin tree in one Host process?
+++ answers
1. The old fiber unloads and the new one starts empty, so the list is gone unless it was kept in a service or on disk. On Chord the notes are a document of a pure object; a reload swaps the object's code and keeps the document.
2. Its listener is registered again at the end of the list, so the other plugin's listener now runs first and the decision can change, unless the listener was registered with prepend.
3. p2 has a worker process per session and clients (including guests) in other browsers; objects must live on the right host, callers must be stamped principals, and reload has to roll out across server, workers and tabs. A single-process tree does not cover that.
:::

