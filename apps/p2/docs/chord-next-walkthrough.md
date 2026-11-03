# Chord v2 and its plugins: a guided walkthrough

A step-by-step introduction to how plugins work on Chord v2 (`packages/chord/src`, used by the playground and
p3), for someone who knows nothing about either. It teaches the **design**: the target design
`packages/chord/docs/design.md` together with the decision log `packages/chord/docs/decisions.md` (the log is
newer and wins where they differ). It does not describe the state of the code. API names are the design's working
names; where the kernel already has a name (`packages/chord/src`), the examples use it.

Points the design has not settled are marked **Open** and list their options. Nothing in an Open block is decided.

---

## For the agent guiding the user

You walk a user through this document. Follow these rules:

1. **One concept at a time.** Explain it in your own words, in the user's language, with the document's example.
   Keep it concrete; don't paste whole sections. Explain in full sentences in this document's tone, not as terse
   notes; define every word the user may not know when it first appears (e.g. IPC, relay).
2. **Then ask the check questions** of that concept and **wait** for the answers.
3. **Judge the answers** against the model answers (they are for you). If an answer is wrong or half right, say
   precisely what is missing, explain that part differently, and ask again. Don't move on while a concept is unclear.
4. **Counter-questions come first.** Answer a user's question completely before anything else. If the answer lies in
   a later concept, give a short answer and say where it continues.
5. **Move on only when the user says so.**
6. **No terms before they are introduced.** If you need one, introduce it first.
7. **Teach the design, not the implementation status.** For questions beyond this document, answer from, in this
   order: `redesign-decisions.md` (newest decisions, wins on conflicts), `packages/chord/docs/design.md` (the
   target design), `packages/chord/docs/kernel.md` and `step-*.md` (names the kernel already uses),
   `plugin-loading.md` (loading, project plugins), `questions.md` (the Questions service),
   `research/chord-on-durable-objects.md`. `target-design.md` and `p3-walkthrough.md` are superseded.
8. **Open is open.** Present every Open point with its options; never present one option, or your own idea, as
   decided. If a question has no answer in the sources, say so plainly.
9. If you find a gap or a contradiction in the sources while teaching, tell the user and note it for whoever
   maintains the design.
10. Keep a short list of what the user found hard; come back to it at the end.

Start by telling the user the note below, then begin with "The setting". The setting has no check questions: ask
whether the user has questions, then move on when they say so.

## For the user

**Keep asking until you really understand a thing.** There are no silly questions. The concepts build on each other; a
gap early on makes everything after it harder. If an example doesn't click, ask for another one. If a word is unclear,
ask what it means.

---

## The setting and the running example

**Chord** is the runtime under an app: it lets plugins define **objects** that live in one place and lets every part
of the app use them, also across process boundaries.

An app on Chord runs as several participants. Chord calls each participant a **host**. In a Node app (the playground,
p3) there are three roles:

```
browser   browser   TUI          clients: any number, not addressable
   └─────────┼───────┘
           server                exactly one
   ┌─────────┼─────────┐
worker S1  worker S2  worker S3  one per session, started on demand
```

- **The server** (exactly one) serves the UI, holds data shared by all sessions and starts the workers.
- **A worker** (one per session) runs the agent and works on that session's files. The server starts it as a child
  process when the session is first needed.
- **Clients** are browser tabs and TUIs (terminal UIs). They connect by themselves; nobody can send a request *to* a
  client, so clients are not addressable. A client's own objects are therefore only ones nobody outside it needs
  (concept 6 names them: `local` types).

**How they connect.** Each connection between two hosts is a **link**:

- Clients connect only to the server, over a WebSocket.
- The server talks to each worker over **IPC** (inter-process communication: the pipe between a parent process and the
  child it started).
- Clients never talk to a worker directly; the server **relays** (passes requests on). A browser call to something in
  session S1 travels browser → server → worker S1, and the answer comes back the same way. Workers reach each other
  through the server too.
- When a client connects, the server checks who it is (for example its cookie) and attaches that to the whole link.
  Concept 3 builds on this.

**The goal that shapes everything: reload.** You change a plugin's code and the new code takes over inside the
running app. Two words matter:

- a **reload** swaps a plugin's code while the hosts keep running: data, open connections and running work survive
  where they can;
- a **restart** ends a process and starts it again: everything it held in memory is gone.

Reloads are always explicit (a button or a command), never on save. Changes to Chord itself or to the app's runtime
are **base code**: they restart the hosts. Much of the design exists to make reloads safe; concept 23 shows the reload
step by step.

**Base code and plugins.** Whether something is "core" or a plugin is decided by where its code lives:

- **base code** (the app's `src/`): imported directly by the start code under a fixed name such as `@app/core`; always
  there, not switchable; a change restarts the hosts. Core is what the app always needs and everything builds on (the
  agent harness, the session list, access, the session location).
- **a plugin** (its own directory): found by listing, loaded by the plugin loader, switchable; a change reloads it.
  Optional features are plugins.

Both use exactly the same building blocks; base code is not special to Chord.

**A plugin** is a folder with a `package.json`. Its `name` (globally unique and stable, like an npm package name, e.g.
`@playground/notes`) is the plugin's identity: Chord identifies the plugin's facets by it (their stored documents,
reloads, error messages), never by a directory name or load order. Base code's core facet gets a fixed name the same
way (`@app/core`). Each other file is meant for certain hosts; the part of a plugin for one kind of host is a
**facet**:

| File | Runs on | Holds |
| --- | --- | --- |
| `package.json` | (read by the loader) | the plugin's `name` |
| `contract.ts` | every host that imports it | descriptions only: names, shapes, method signatures |
| `server.ts` | the server | the server facet |
| `worker.ts` | every session worker | the worker facet |
| `web.tsx` | the browser | the web facet (UI) |
| `tui.ts` | the TUI | the TUI facet |

**The running example: a notes plugin.** The whole walkthrough builds this one plugin, piece by piece:

- notes per session, kept across restarts;
- a web panel shows the notes; the owner and guests with write access can add and remove notes; read-only guests can
  only read, and don't see who wrote a note;
- a text file dropped into the session's `inbox/` folder becomes a note;
- notes older than 30 days are deleted every hour;
- importing a large file runs in the background and can be cancelled;
- `GET /s/:session/notes.txt` downloads all notes;
- the panel shows how many people are looking at the notes.

---

## Concept 1: Object types and objects

**The problem.** Several places need "the notes of session S1": the owner's tab, a guest's tab, the download route. If
each built its own copy, the copies would drift apart, and nobody would know when to clean them up.

**The idea.** There is **one object** for "the notes of S1". Everyone asks Chord for it by its **address** and gets
that same object.

- An **object type** describes what such an object is: its name, what its address looks like (the **input**), where
  it lives, what you can do with it (its **members**: data you can read and methods you can call) and a version. It
  contains no code that runs; every host can share it. Another word for it is **contract**.
- A **factory** is the code that builds an object of that type, on the host where it lives.
- An **object** is one concrete instance: "Notes for `{ session: "S1" }`".

The three pieces live in three files of the notes plugin:

```ts
// contract.ts: the object type
export const Notes = remote("notes", {
  version: 1,
  host: /* where it lives: concept 2 */,
  input: Type.Object({ session: Type.String() }),   // the address: { session: "S1" } (a TypeBox schema)
  variants: { /* the members: concept 3 */ },
});
```

```ts
// worker.ts: the factory, on every session worker
export default defineFacet((host, self) => {
  host.serve(Notes, (input, principal, self) => ({ /* members */ }));
});
```

```ts
// web.tsx: a caller in the browser
const notes = await host.get(Notes, { session: "S1" });   // browser → server → worker S1
```

Read `host.serve` as "this host builds `Notes` objects like this". `principal` comes in concept 3, `self` in concept 7.

- **Who builds it:** the host where the object lives runs the factory. That is why the `Notes` factory is in
  `worker.ts`.
- **One object per address:** the first `get` for `{ session: "S1" }` runs the factory; every later `get` for the same
  address gets the same object. `{ session: "S2" }` is another object, on another worker. (Concept 3 refines this.)
- **Methods return data, never objects.** If a method wants to point you to an object, it returns its address (`{
  session: "S1" }`) and you `get` it yourself.

**Check questions**

1. Two tabs ask for the notes of S1. How often does the factory run?
2. What is the difference between `Notes` and "Notes for S1"?
3. Why does the factory live in `worker.ts`, not in `server.ts`?

*Model answers:* (1) Once: same address, same object (concept 3 refines this when the callers are different people).
(2) `Notes` is the description (the type); "Notes for S1" is one instance (an object). (3) Notes of a session live on
that session's worker, and the host where an object lives runs its factory.

---

## Concept 2: Where objects live: host kinds and placement

**The problem.** A caller asks for "Notes for S1". Chord must find the host that holds it, without the caller knowing
host names, and the worker must be sure the object really belongs to it.

**The idea.** The app describes its addressable hosts as typed **host kinds**; one concrete host of a kind is an
**address**. A type's `host` field is a **placement function**: input in, address out.

```ts
// the app's runtime (base code, not a plugin)
export const Server = hostKind("server");                                      // one host
export const Session = hostKind("session", Type.Object({ id: Type.String() })); // one host per id

Session({ id: "S1" })   // an address: the worker of session S1
Server()                // the address of the server
```

```ts
// notes/contract.ts
export const Notes = remote("notes", {
  version: 1,
  host: ({ session }) => Session({ id: session }),   // typed: `session` must exist in the input
  input: Type.Object({ session: Type.String() }),
  variants: { … },
});
```

**A call, step by step:**

```
browser    get(Notes, { session: "S1" })
           runs the placement function → Session({ id: "S1" })
           has only a link to the server → sends the request there, with the address
server     the address is not mine; the app told me how to reach Session hosts (concept 4)
           → link to worker S1 (started if needed), forward
worker S1  runs the placement function too → Session({ id: "S1" }) = me → runs the factory
```

- **The caller computes, the provider checks.** The caller runs the function on the normalized input and sends the
  result. The provider runs it too and refuses an object that is not its own with the error `invalid/placement`; a
  worker for S2 never builds "Notes for S1". (During a rollout, concept 24, such a refusal is handled like a mismatch:
  a provider on another revision makes the call park; on the same revision it fails.)
- **No host-name strings** in app code. Addresses are typed values; Chord serializes them internally.
- **Placement is not part of the type's fingerprint** (the hash Chord uses to compare two versions of a type, concept
  26). If the rule changes between versions, the provider's refusal surfaces it.
- A function is type-checked: a `Session` placement on a type without a `session` field does not compile.

**Check questions**

1. A tab asks for `Notes { session: "S2" }`. Which host builds it, and who computed that?
2. Why does the worker run the placement function again, if the caller already did?
3. What does app code never write when it names a host?

*Model answers:* (1) The worker `Session({ id: "S2" })`; the caller computed the address with the type's placement
function, the server routed by it. (2) To refuse objects that are not its own (a wrong or outdated rule at the caller
must not create an object in the wrong place). (3) A host-name string; it calls the host kind (`Session({ id })`).

---

## Concept 3: Who is calling: principals and variants

**The problem.** The owner may add and remove notes; a read-only guest may only read and should not even see who wrote
what. The object must know who calls, and the caller must not be able to lie about it.

**The idea.** Every request carries a **principal**: who calls. The app defines its principal type; every variant has
a `kind`. p3's principals:

| `kind` | Who |
| --- | --- |
| `owner` | the person running the app (`access: "local" \| "relay" \| "device"`; a paired device has its `device` id) |
| `guest` | someone invited into one session (`session`, `mode`, its `grant` and the grant's revision) |
| `server` | the server calling a worker |
| `worker` | a session worker calling the server (`session`) |

- **Links stamp principals.** A principal is never taken from a request's data: the server authenticates a client
  when it connects and stamps that principal on the whole link; the server tells Chord who each worker is when it
  connects it (concept 4). A caller cannot claim to be someone else.

**Where principals come from.** Chord never sees cookies, share links or grants; that is app code (in p3 the sharing
feature, `p3-functions/sessions-access.md`). Chord only receives the finished principal and stamps it on the link:

```
owner: "copy share link" for S1, read/write
  sharing (app code on the server) creates a link token for (S1, write)
guest opens the link → join page → enters a name
  sharing stores a guest record (grant g1) and sets a guest cookie
guest's tab connects (WebSocket)
  entry point (app code): authenticate(req): cookie → guest record g1
    → { kind: "guest", session: "S1", mode: "write", grant: "g1", revision: 1 }
  server.accept(link, { principal })          ← Chord: stamped on the whole link
```

A **grant** is the app's stored record "this person may enter S1 with this mode"; `authenticate` checks it on every new
connection.

**What principals do in Chord** (all of them pick something):

- **identity:** they decide which object a caller gets (next point);
- **variant:** the factory receives the principal and picks what the caller may see (below);
- **admission:** `route.authorize(principal, address)` decides whether a caller may reach a worker at all (concept 4);
- inside methods `ctx.principal` says who calls (concept 12).

**The caller is part of the object's identity.** One object exists per **(type, input, principal key)**. The
**principal key** is a string Chord computes from a principal: same key, same object; different key, different
object. By default it is the principal as canonical JSON (fixed field order). The app can supply its own function
(the `principalKey` option when it creates its hosts, concept 4) and so decide which fields split objects. An
illustration (the design does not fix p3's function):

```ts
principalKey: (p) =>
  p.kind === "owner" ? `owner:${p.access}` :
  p.kind === "guest" ? `guest:${p.grant}:r${p.revision}` :
  p.kind
```

| Caller | Principal key | `Notes {S1}` object |
| --- | --- | --- |
| owner, tab A, local | `owner:local` | 1 |
| owner, tab B, local | `owner:local` | 1 (shared) |
| owner via relay | `owner:relay` | 2 |
| guest g1, revision 1 | `guest:g1:r1` | 3 |
| guest g1 after a grant change, revision 2 | `guest:g1:r2` | 4 (new) |

The design wants the key to include how the client is connected (access paths never share objects) and the grant's
revision (after a change from write to read the guest gets a new object, never the old `editor` one).

**Variants:** the type lists named sets of members; the factory gets the principal and returns the variant that
principal may see.

```ts
// contract.ts
variants: {
  editor: { state: { notes: NotesSchema },
            methods: { add: method(AddArgs, NoteId), remove: method(RemoveArgs) } },
  reader: { state: { notes: PublicNotesSchema } },          // no authors, no methods
},
```

```ts
// worker.ts
host.serve(Notes, ({ session }, principal, self) => {
  if (canWrite(principal, session)) return { variant: "editor", notes: …, add: …, remove: … };
  return { variant: "reader", notes: … };                   // filled in, concept 10
});
```

- **A reader has no `add` at all.** Chord refuses calls to members that are not in the caller's variant, so `add`
  needs no check of its own.
- **The caller sees which variant it got** and narrows before using variant members; the type checker enforces it:

```ts
const notes = await host.get(Notes, { session: "S1" });
notes.add({ text: "hi" });                   // type error: `add` exists only in "editor"
if (inVariant(notes, "editor")) await notes.add({ text: "hi" });
```

`expectVariant(ref, "editor")` asserts instead (throws `not_in_variant`).

**The types know nothing about who calls.** Owner and guest run the same `web.tsx`; the type checker only forces every
caller to narrow before using variant members. Which variant a caller has is known only at runtime (`inVariant` is
`false` for the guest). The protection is Chord refusing the call on the provider; a malicious client that ignores the
types gets the same error.

**Check questions**

1. Why can't a guest become the owner by sending `{ kind: "owner" }` in a request?
2. The owner has two tabs open; two guests are in S1. How many `Notes` objects exist?
3. A read-only guest calls `add` anyway. What happens, and where was that decided?

*Model answers:* (1) The link stamps the principal from the server's authentication; request data never sets it. (2)
Three: one for the owner (both tabs share it), one per guest. (3) Chord refuses it at runtime and the caller gets
`not_in_variant`: the guest got the `reader` variant, which has no `add`; the factory decided when it picked the
variant. (Not "it doesn't compile": the guest's code is the same as the owner's; types only force narrowing.)

---

## Concept 4: Starting hosts: the low-level host API

**The problem.** Someone must create the hosts, connect them, authenticate clients and start workers on demand. These
things differ between deployments (a loopback WebSocket, a relay, a test in one process), so Chord must not hard-code
them.

**The idea.** Hosts are created by the app's own startup code (base code). Chord offers a small API; starting
processes, authentication, init data and keep-alive are app code.

```ts
// app/server.ts
const server = createHost<P>({
  address: Server(), principal: { kind: "server" },
  storage: serverStorage,                          // a DocumentStorage (concept 13); in memory if omitted
});
await server.load([                                // facets with their plugin names
  { name: "@app/core", facet: coreServerFacet(config) },   // base code's core facet
  { name: "@playground/notes", facet: notesServer },       // a plugin
]);

wss.on("connection", (ws, req) => {                // an entry point: app code
  const principal = authenticate(req);             // cookie → owner or guest
  if (!principal) return ws.close(4401);
  server.accept(webSocketLink(ws), { principal }); // requests on this link act as `principal`
});

server.route(Session, {                            // how to reach hosts of kind Session
  authorize: (p, { id }) => p.kind === "owner" || p.kind === "server" || (p.kind === "guest" && p.session === id),
  resolve: async ({ id }, { signal }) => {
    const principal: P = { kind: "worker", session: id };
    const child = fork("worker.ts", [], { serialization: "advanced", signal });
    child.send({ id, principal, init: await initFor(id, signal) });   // the app's own start message
    return { link: ipcLink(child), principal };     // Chord stamps `principal` on that link
  },
});
```

```ts
// app/worker.ts
const { id, principal, init } = await startMessage(process);
const worker = createHost<P>({ address: Session({ id }), principal, storage: storageFor(id) });
await worker.load([
  { name: "@app/core", facet: coreWorkerFacet(init) },     // serves the start data (concept 5)
  { name: "@playground/notes", facet: notesWorker },
]);
worker.connect(ipcLink(process), { principal: { kind: "server" } });   // the parent, and who it is
```

```ts
// a browser tab
const client = createHost<P>();                    // no address: a client
await client.load([{ name: "@playground/notes", facet: notesWeb }]);
client.connect(webSocketLink(new WebSocket("/chord")), { principal: { kind: "server" } });
const notes = await client.get(Notes, { session: "S1" });
```

| Call | Meaning |
| --- | --- |
| `createHost<P>({ address?, principal?, storage?, ... })` | with an address: addressable, its own code acts as `principal`; without: a client. `P` is the app's principal type; `storage` holds the host's persisted documents (concept 13; in memory by default) |
| `load([{ name, facet }])` | the facets for this host, already imported, each with its plugin's `package.json` name (a loader reads it; a test or static setup passes it; base code passes its core facet the same way); duplicate or invalid names are refused |
| `connect(link, { principal })` | the link to the parent (at most one; replaced after a reconnect); `principal` says who the parent is |
| `accept(link, { principal })` | a link from a client; every request on it acts as `principal` |
| `route(Kind, { authorize, resolve })` | how to reach hosts of a kind: `authorize(principal, address)` runs before anything starts; `resolve(address, { signal })` returns `{ link, principal }` |

**The first `get` for S1, step by step:**

```
browser   Notes {S1} → Session({ id: "S1" }) → over its link to the server
server    not me; route(Session): authorize(owner, { id: "S1" }) ok
          no link to S1 yet → resolve({ id: "S1" }): fork, start message, IPC link
          stamp { kind: "worker", session: "S1" } on that link → forward
worker    reads its start message, createHost(Session({ id: "S1" })), load, connect
          → serves the request: runs the Notes factory as the owner asked
```

- **`resolve` runs once per address while its link lives,** and again after the link drops (the worker crashed or
  exited). While references to that worker still exist, Chord re-resolves by itself (with the per-address backoff of
  concept 7), so a tab that only watches recovers without anyone clicking. A worker start that already produced a link
  finishes even if the request that triggered it went away.
- **Incarnations:** a host is a logical identity (its address) plus an **incarnation**, a fresh id Chord mints on
  every start and sends in the link handshake. The other side sees a restart as a new incarnation of the same identity,
  and references to it re-hold (concept 8).
- **Entry points vary:** a loopback or tunnel WebSocket server, the Radius relay delivering channels, a Durable Object
  edge, a memory link in a test. So Chord has no `listen`: each entry point authenticates and calls `accept`.
- **Tests** run everything in one process: `resolve` creates the worker host in memory and returns one end of
  `memoryLinkPair()`.
- **Links** only deliver frames, in order, both ways. Heartbeats and recovery are the adapter's policy: IPC needs
  none; a WebSocket through a relay needs a heartbeat (TCP does not notice a sleeping laptop).
- `host.root(fn)` gives code outside objects (a CLI command, a Durable hook) a call scope (concept 12).
- **Worker keep-alive: the worker counts, the app decides** (as in p2). Core code on the worker reports viewers
  (concept 21), active calls and running jobs (Chord's counters), Durable tasks and objects kept warm by `linger`
  (concept 7); the server's supervisor (app code) stops the worker when all are zero for the idle time (p2: 5
  minutes). Chord provides the counts, no idle logic.
- **Other options** of `createHost`: `principalKey` (concept 3; the same function on every host), `revokedBy`
  (concept 11), `telemetry` (concept 29), `dev` (development checks), `onError` (background errors, including a
  storage failure: Chord never ends the process, the app's start code decides; concept 13), and **timeouts**: host
  defaults with per-thing overrides (closing a native value 30 s, activation and awaited `get` 60 s, parked calls 60 s,
  routine handover 10 s, a rollout install 60 s).

**Check questions**

1. Who decides that the worker for S1 is a separate process, and where is that written?
2. The worker for S1 crashes. A tab calls `Notes {S1}` again. What happens?
3. Why does Chord have no `listen(port)`?

*Model answers:* (1) The app: its `route(Session, { resolve })` forks the process; Chord only calls `resolve` when it
needs a link. (2) The link dropped, so the next request calls `resolve` again: a new worker starts, a new incarnation;
the tab's reference re-holds against it. (3) Entry points differ (loopback, tunnel, Radius, DO edge, memory); each
authenticates and calls `accept`.

---

## Concept 5: Start data and core objects

**The problem.** A worker's code needs things that exist before any plugin: the session's id, its init data, the data
directory. The start code got them in the server's start message (concept 4). How do plugins get them?

**The idea.** There is no special mechanism. Start data is an ordinary object: a `local` type (usable only on its own
host, concept 6) with `lifetime: "host"` (it lives as long as the host, concept 7) and constant state, served by base
code's core facet from the start message:

```ts
// base code (the app's src/): a local type and the core facet
export const SessionInfo = local("app.session-info", {
  version: 1, input: Type.Object({}), members: { init: InitSchema },
});
export const coreWorkerFacet = (init: Init) => defineFacet((host) => {
  host.serve(SessionInfo, () => ({ init: constant(init) }), { lifetime: "host" });
});

// app/worker.ts (concept 4)
await worker.load([{ name: "@app/core", facet: coreWorkerFacet(init) }, …plugins]);

// any plugin
const info = self.get(SessionInfo, {});           // a reference, declared in the factory
// later (in an opener, derive, routine or method): info.init.value.id, info.init.value.dataDir
```

- **Read after activation, never in the factory.** A factory only declares (concept 7); it gets a reference to
  `SessionInfo` and reads `info.init.value` later: in the opener of a native value, a derive, a routine or a method.
  Example: the inbox watcher (concept 14) builds its path from `dataDir` and the session id in its opener.
- **Paths are derived by the plugin** from generic start data (the data directory), never provided per plugin.
- **Platform bindings** the host owns (on a Durable Object its `state` and `env`) are core objects too: their
  `self.open` (concept 14) returns the binding, their `close` does nothing.
- **A long-lived native value from the host** (the Durable harness, concept 28) is a `lifetime: "host"` object in the
  core facet.
- Why no special "host value" mechanism: core objects already have everything (a type, a version, references), and
  base code and plugins use the same primitives.

**Check questions**

1. How does a plugin on the worker learn its session id?
2. Why may a factory not read `info.init.value` directly?

*Model answers:* (1) It declares `self.get(SessionInfo, {})` and reads `info.init.value.id` after activation (in an
opener, derive, routine or method); base code's core facet serves `SessionInfo` from the start message. (2) A factory
only declares; reading a reference's value happens after activation, when the reference is live and hydrated.

---

## Concept 6: `remote` and `local` types

**The problem.** A browser must reach `Notes` across links, with checked arguments and per-caller views. But two
objects on the same worker (the notes view and the store behind it) shouldn't pay for checks and principals.

**The idea.** Two kinds of types:

```ts
export const Notes = remote("notes", { version, host, input, variants });
const NoteStore = local("notes.store", { version, input, members });
```

| | `remote` | `local` |
| --- | --- | --- |
| reachable from | any host, across links | its own host only |
| identity | (type, input, principal key) | (type, input) |
| principals, variants | yes | no |
| factory | `(input, principal, self)` | `(input, self)` |
| arguments | validated once at the provider when the caller is not a host principal; passed by reference on the same host | neither validated nor copied |
| results | not validated in production; passed by reference on the same host | not validated, not copied |
| members | state and methods: data (JSON plus bytes) | plain-data state and methods |
| `ctx.principal` in methods | the caller | none |

- **Validation by trust.** Arguments (and the input of a new reference) are checked against the **provider's**
  TypeBox schema whenever the call originates from someone who is not a host principal: a guest, the owner, any
  client, also when the server relays it over IPC. Calls from server and worker code itself are not validated in
  production. Never with a schema a peer sent. The handler receives exactly its declared shape (undeclared fields are
  stripped). Schemas are compiled once, at first use.
- **Values are immutable by convention, never copied.** On the same host a value is passed by reference, for both
  kinds; nobody mutates a value it got. Development mode freezes values to catch mistakes. (Copies would cost time and
  memory on every call; the convention is the same as in Durable.)
- **`local` is the trusted path:** no principals, no checks. Attribution ("who wrote this note") is passed as data,
  because a local object has no principal.
- **Variants stay compatible:** a member name has the same kind (state or method) in every variant that has it, and a
  method the same signature; only state schemas may differ per variant (the reader's redacted notes).
- **Clients serve only `local` types:** nobody can address a client, so nothing remote can live there. A client's
  local calls have no principal; what a client calls on the server is stamped with the client's authenticated
  principal (concept 3).
- **Members are data only,** on both kinds: no callbacks as arguments, no native values. Concept 19 explains why and
  what to use instead.

**Check questions**

1. Why does `NoteStore`'s `add` take `{ text, by }` while `Notes`' `add` takes only `{ text }`?
2. Owner and guest both use `NoteStore {S1}`. How many `NoteStore` objects exist?

*Model answers:* (1) A local object has no principal; the per-principal `Notes` view knows who calls and passes the
author as data. (2) One: a local identity is (type, input), with no principal.

---

## Concept 7: Objects and their lifecycle

**The problem.** An object needs references, data, maybe an open file watcher, before it can serve calls. If the
factory did all that itself (awaiting, opening), a reload would rerun it and open everything twice, and a failure
halfway would leave half-open things behind.

**The idea: factories declare, Chord activates.** The factory is synchronous and only **declares** what the object
needs, through `self`; Chord performs it:

```ts
host.serve(NoteStore, ({ session }, self) => {
  const list = self.state(NoteList);                             // a document: concept 13
  const count = self.derive("count", [list], ([l]) => l.items.length);   // concept 9
  const catalog = self.get(Catalog, {});                         // a reference: concept 8
  self.routines.every("cleanup", HOUR, (ctx) => dropOld(ctx));   // concept 15
  const imports = self.job(ImportJob, { run, finish });          // concept 17
  return { notes: list, count, add: …, remove: … };
});
```

The lifecycle:

```
(first get) → activating → live → ending → ended
                   └→ failed (backoff) → activating …
```

- **Activating:** Chord binds the declared references (and waits until they are live), loads documents, opens native
  values (concept 14), computes derives, starts routines. Calls wait behind the object's **gate** until it is **live**.
- **Waiting for dependencies:** an object whose references are not live yet stays `loading` and goes live as soon as
  they are (at most 60 s, then it fails). So when a dependency recovers, its dependents recover at once.
- **Ending:** routines stop, the object's calls and jobs are aborted as their rules say, native values close in reverse
  order, references are released.
- **Lifetime:** `"referenced"` (default) lives while someone holds a reference, plus an optional `linger` after the
  last one (set by the type's provider: keeps a just-closed object warm); `"host"` lives as long as the host (only for
  types without a required input, checked by the type system). A running job counts as a reference (concept 17).
- **Failed:** any broken part fails the **whole** object (a half-working object could break rules that rely on its
  documents changing together). Chord tags the cause by where it failed:

  ```ts
  cause: { kind: "transient"; error }   // an open threw, a dependency was unreachable: automatic backoff
       | { kind: "broken"; error }      // factory, derive, document loading or migrate threw: no automatic retry
  ```

  **Transient** causes get a **backoff per address**: 1 s, doubling up to 60 s; concurrent gets share one attempt;
  success resets it. **Broken** ones (a code bug, invalid data) would fail the same way again, so they are retried
  only by a trigger. Triggers, for both: a plugin reload, `ref.retry()` (a Retry button), and wake signals the factory
  declares with `self.retryOn(...readables)` (sources that live independently of the attempt, such as the facet's
  documents). Only an opener may declare its own failure `broken` (`throw broken(error)`, e.g. invalid configuration).
- **Handles stay valid** for the object's whole life: nothing is re-fetched or "read at use".

**Check questions**

1. Why may a factory not `await` anything?
2. `NoteStore {S1}` fails to activate at 10:00:00. A tab asks again at 10:00:00.5. What happens?

*Model answers:* (1) It only declares; async work happens in activation, calls, routines and jobs. A reload reruns the
factory, so side effects there would repeat, and a half-finished factory would leave things behind. (2) It depends on
the cause. Transient (an open threw): the get is inside the 1 s backoff, it gets the stored failure (`failed` with
`retryAt`), and the next attempt runs at 10:00:01 unless a trigger comes first. Broken (the factory threw): no
automatic retry at all; only a reload, `retry()` or a `retryOn` signal starts a new attempt.

---

## Concept 8: References

**The problem.** A consumer uses an object that may be on another host, may not exist yet, and may go away (link drop,
restart, failure). It needs one handle that keeps the object alive and tells it what is going on.

**The idea.** `get` returns a **reference**. While held, it keeps its object alive. Awaited, it is **live and
hydrated**: every state member of its variant has a value. Three ways to get one, differing in when it is released:

| Where | API | Released |
| --- | --- | --- |
| in a factory | `self.get(Type, input)` | when the object ends |
| in a call | `await ctx.get(Type, input)` | when the call ends |
| outside (UI, tests) | `await host.get(Type, input)` | `ref.release()` |

`{ state: false }` binds for methods only (no values are sent).

**State members are readables.** A **readable** is a value plus its ordered changes: `.value` is the current value,
`.subscribe(fn)` is called on every change. A reference's state members (`notes.notes`) are readables, on any host.

**`ref.state` says what is going on,** as a tagged value; `ref.onState(fn)` gets each new one:

```ts
| { kind: "loading" }                                     // first hold, reconnecting, restarting
| { kind: "live" }
| { kind: "failed"; cause: FailureCause; retryAt: number | undefined }   // undefined: broken, no automatic retry
| { kind: "released" }
```

**What calls and values do:**

| Situation | Calls | Values |
| --- | --- | --- |
| link drop | park until reconnect | readable, `loading` |
| object loading or restarting | park until live | readable, `loading` |
| rollout: provider ahead or installing (concept 24) | park until installed | readable |
| object `failed` | reject at once with the cause | readable, `failed` with `retryAt` |

- **Parked calls** share one default deadline (60 s, overridable per reference: `get(…, { parkTimeout })`): after it
  they fail `unavailable`. Otherwise a call ends only through its caller's signal; there is no per-call deadline.
- **A failed reference stays held:** for a transient cause Chord retries per the backoff; `ref.retry()` tries at once;
  success goes `loading`, then `live`.
- **Calls that were running** on an instance that ends fail with an error and are not resent.
- **Errors look like disconnects.** No request ids, no special protocol: a consumer handles a failed call as it would
  a dropped link (show the error, the user retries).
- **Authority checks** live in the per-principal view's methods (and in `route.authorize` before a host starts). There
  is no async check before an object goes live.

- **No optional references.** If the other side's plugin may be missing (radius uses ports' forwards, but ports is
  optional), the dependency is turned around: the dependent owns a registry and the other plugin contributes to it
  (ports contributes its forwards to `radius.forwards`; without ports the table is empty and radius works). Registries
  come in concept 19. `get` has no `optional` flag.

**Check questions**

1. The worker restarts while a tab shows the notes. What does the tab see, and what happens to an `add` clicked
   meanwhile?
2. When do you use `self.get` and when `ctx.get`?

*Model answers:* (1) The values stay readable with `ref.state` `loading`; the `add` parks; when the new incarnation is
up, the reference re-holds, gets fresh values, goes `live`, and the parked call runs. (A call that was already running
on the old worker fails.) (2) `self.get` in a factory for something the object needs its whole life; `ctx.get` in a
method for something one call needs.

---

## Concept 9: Derived values

**The problem.** The reader variant needs the notes without authors; the panel shows a count. Storing copies would go
stale.

**The idea.** `self.derive(name, sources, (values, previous) => value)` computes a value from readables (documents,
reference members, other derives), recomputes when a source changes, and sends viewers only the difference.

```ts
const count = self.derive("count", [list], ([l]) => l.items.length);
```

- `previous` is the derive's last value, for incremental work. It is kept across reloads by the derive's **name**. It
  is only a cache (empty after a restart), so a derive must be correct without it.
- A derive that throws fails its whole object (concept 7).
- **How the difference is found:** Chord compares the new value with the old one (Delta's `diffRevisions`). Parts that
  are the **same objects** as last time cost one `===` each; parts that are new objects must be compared by content.

**The footgun.** A derive that builds new objects for unchanged data makes every change cost the size of the whole
value, per view. Example: 2,000 notes, the reader's view strips authors:

```ts
self.derive("public", [list], ([l]) => ({ items: l.items.map((n) => ({ text: n.text, at: n.at })) }));
// one note added: 2,001 new objects, all compared by content
```

**`mapShared(f)`** (from `@earendil-works/chord/delta`) keeps one result per source element: `f` runs only for new or
changed elements; unchanged ones return their previous result object.

```ts
const strip = mapShared((n: Note) => ({ text: n.text, at: n.at }));
self.derive("public", [list], ([l]) => ({ items: l.items.map(strip) }));
// one note added: one new object, 2,000 identical references, the diff emits one insert
```

**Cookbook** (patterns with examples): select a field, look up by key, small aggregates (just compute; the value is
small); filter or map a list (`mapShared`); redaction (preferably separate documents per visibility, otherwise
`mapShared`, computed once in the shared store, concept 10); joins across two sources; a window over a large list
(keep its start stable so changes arrive as appends).

**Check questions**

1. Why does a derive have a name?
2. The reader view maps every note to a new object on every change. What does one added note cost, and how do you fix
   it?

*Model answers:* (1) So Chord recognizes it across reloads and can hand the new code its `previous` value. (2) The
whole list: every object is new, so the diff compares all of them by content, per view. Use `mapShared`: unchanged
notes keep their result objects, and the diff finds the one insert by identity.

---

## Concept 10: Pattern: shared store, per-principal views

**The problem.** Each principal has its own `Notes` object (concept 3). If each one loaded the notes, or computed the
reader's redaction itself, there would be one copy per caller again: exactly what concept 1 wanted to avoid.

**The idea.** Heavy or shared parts live once in a `local` **shared store**; the per-principal `remote` views get it
and expose what their principal may see. Views of the same variant read **one** value from the store: the redaction is
computed once, not per guest.

```ts
host.serve(NoteStore, ({ session }, self) => {
  const list = self.state(NoteList);                                   // concept 13
  const strip = mapShared((n: Note) => ({ text: n.text, at: n.at }));
  const pub = self.derive("public", [list], ([l]) => ({ items: l.items.map(strip) }));   // once, for all readers
  return { notes: list, public: pub, add: …, remove: … };
});

host.serve(Notes, ({ session }, principal, self) => {
  const store = self.get(NoteStore, { session });           // one per session
  const by = authorOf(principal);
  if (canWrite(principal, session)) return {
    variant: "editor",
    notes: store.notes,
    add: ({ text }, ctx) => store.add({ text, by }, ctx),
    remove: (args, ctx) => store.remove(args, ctx),
  };
  return { variant: "reader", notes: store.public };       // the store's one redacted value
});
```

```
NoteStore {S1}           local shared store: the notes and their redaction, once
   ▲ self.get                  ▲
Notes {S1} as owner       Notes {S1} as read-only guest (and every other reader)
 variant "editor"          variant "reader": store.public
```

- **Authority is the view's;** the store is trusted and acts for the host.
- The same pattern holds a Durable watch, a file watcher, a sandbox: once in the store, never per principal. Any plugin
  uses it with the same primitives; base code is not special.

**Check questions**

1. Owner and two read-only guests view S1. How many `Notes`, how many `NoteStore`, how many redacted lists?
2. Where is it checked that the guest may not add notes?

*Model answers:* (1) Three `Notes` (one per principal key), one `NoteStore`, one redacted list (`public` in the store,
shared by both readers). (2) In the `Notes` factory, which gives the guest the `reader` variant without `add`; the store
does not check.

---

## Concept 11: Revocation

**The problem.** The owner removes guest g1 from S1, archives S1, or signs out a paired phone. The open tabs concerned
must lose access at once, also on the worker where their `Notes {S1}` objects live, and reconnecting must not bring the
old access back.

**What we build on.** The app turns a cookie into a principal (`authenticate`, concept 3); Chord stamps it on the link;
every object on a host exists per principal key, and Chord keeps the principal next to each object (it went into the
factory); every link has its stamped principal.

**The idea: labels.** The app defines, once in its runtime, which **labels** a principal carries. Revoking means
revoking one label; everyone carrying it is hit.

```ts
type Revocation = { grant: string } | { device: string } | { session: string };   // the labels

const revokedBy = (p: P): Revocation[] =>          // the labels principal p carries
  p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }]
  : p.kind === "owner" && p.access === "device" ? [{ device: p.device }]
  : [];

const server = createHost<P, Revocation>({ address: Server(), principal: { kind: "server" }, revokedBy });
// every worker is created with the same revokedBy
```

`revokedBy(p)` is not a yes/no question: it returns the list of labels `p` carries.

| Principal | Labels |
| --- | --- |
| guest g1 of S1 | `{ grant: "g1" }`, `{ session: "S1" }` |
| guest g2 of S1 | `{ grant: "g2" }`, `{ session: "S1" }` |
| owner on the paired phone | `{ device: "phone" }` |
| owner, local | none |

| Call | Hits |
| --- | --- |
| `revoke({ grant: "g1" })` (remove one guest) | g1 |
| `revoke({ session: "S1" })` (archive S1) | g1 and g2 |
| `revoke({ device: "phone" })` (sign out the phone) | the phone |

**What `host.revoke(r)` does** with one label `r`:

```
for each live object and each link on this host:
  r in revokedBy(its principal)?  (compared as canonical JSON; never the host's own principal)
    → end the object / close the link
then send r to every child host, which does the same with its own revokedBy
```

On worker S1, for `revoke({ grant: "g1" })`:

| Object | Principal | `revokedBy(p)` | Hit? |
| --- | --- | --- | --- |
| `Notes {S1}` | owner, local | none | no |
| `Notes {S1}` | guest g1 | `grant g1`, `session S1` | **yes** |
| `Notes {S1}` | guest g2 | `grant g2`, `session S1` | no |
| `NoteStore {S1}` | none (local) | none | no |

Only guest g1's `Notes` ends; ending it releases its reference to `NoteStore`, which keeps serving the others. Why a
label and not a yes/no function: revocation is an event that must travel from the server to the workers, and a label
is plain data that can be sent; a function could not.

**Removing guest g1, step by step:**

```
owner removes guest g1
  sharing (app): marks grant g1 blocked in its stored guest records
  server.revoke({ grant: "g1" })
server     the guest's WebSocket link carries grant g1 → close it; g1's objects on the server end
           send { grant: "g1" } to the workers
worker S1  g1's Notes {S1} ends
guest tab  link gone; reconnects → authenticate: grant g1 is blocked → refused
```

- **Chord persists nothing here.** `revoke` only cuts live access. Lasting denial lives in the app's data, which
  `authenticate` checks on every new connection. After a server restart there is nothing live to revoke; every client
  must authenticate again, and blocked grants are refused there.
- **No re-stamping.** A changed grant (mode write → read) is a revocation of the old grant: the link closes, the tab
  reconnects and authenticates with the new grant (new revision, so a new principal key), and its references
  reconnect by themselves (concept 8), now as a reader.
- **Work running in a shared store** on behalf of a principal (a queued question, a job a guest started) is not ended
  by `revoke`: the store has no principal (concept 10). Such a store keeps the grant as data with the work and
  reconciles from the grant owner's live grants: a routine (concept 15) aborts jobs and drops queued input whose grant
  no longer exists. No revocation hook; it also holds after a crash.

| Chord | The app |
| --- | --- |
| stamps principals on links | what a grant is, share links, cookies, `authenticate` |
| keeps one object per principal key | defines `Revocation` and `revokedBy` |
| on `revoke(r)`: ends matching objects and links, passes `r` to children | decides when to revoke; stores who is blocked |

**Check questions**

1. Why must the label be passed on to the worker?
2. The owner archives S1. Which call does the app make, and whom does it hit?
3. The server restarts the day after guest g1 was removed. What keeps g1 out?

*Model answers:* (1) Guest g1's `Notes {S1}` lives on the worker; ending objects only on the server would leave the
view alive there. (2) `revoke({ session: "S1" })`: every guest of S1 (each carries the label `{ session: "S1" }`); the
owner carries no such label. (3) Not Chord: after the restart nothing live exists; the guest's tab must authenticate
again, and the app's stored record of grant g1 is blocked, so `authenticate` refuses it.

---

## Concept 12: `ctx`

**The idea.** Every call gets a `ctx` as its last argument:

- `signal`: fires when the caller cancelled or the object ended (there is no per-call deadline);
- `principal`: the caller (remote types only);
- `get`: references that are released when the call ends;
- `telemetry`: the current trace span; `ctx.trace(name, attributes, fn)` runs `fn` with a child `ctx` under a child
  span (concept 29);
- in a job (concept 17) also `jobId` and `progress`.

Pass `ctx` or `ctx.signal` to everything you wait on (`fetch(url, { signal: ctx.signal })`). Code outside objects gets
a `ctx` from `host.root(fn)`. There are no code versions and no request ids in it. Durable's `Context` is the same
module, so passing between them needs no conversion.

**Check question:** a caller closes its tab while `exportText` runs. How does the method learn it? *Model answer:*
`ctx.signal` fires; everything it awaits with the signal is cancelled.

---

## Concept 13: Documents and transactions

**The problem.** Notes must be stored, changed safely while others read them, sent to viewers as small changes, and
survive restarts.

**The idea.** An object's data lives in **documents**: named JSON values the object owns, changed only in
**transactions**.

```ts
const NoteList = defineState("notes.list", {
  schema: NoteListSchema,                 // { items: Note[] }: a document's root is an object
  version: 1,
  initial: () => ({ items: [] }),
  persist: true,                          // stored; default: memory only
});

host.serve(NoteStore, ({ session }, self) => {
  const list = self.state(NoteList);      // a handle to THE list document of this object
  return {
    notes: list,                          // a singleton handle is a readable: expose it as a member
    add: ({ text, by }, ctx) => self.tx(async (tx) => {
      const d = await tx.draft(list, undefined, { tags: [SessionTag(session)] });   // the current list, as a draft
      const id = uuidv7();
      d.items.push({ id, text, by, at: Date.now() });
      return id;
    }, ctx),
    remove: ({ id }, ctx) => list.change((d) => { d.items = d.items.filter((n) => n.id !== id); }, ctx),
  };
});
```

- **Singleton or keyed:** a singleton (no `keyed`) is loaded at activation and kept in memory; `list.value` is
  synchronous. A `keyed: true` document exists many times per object, addressed by a short key, loaded on demand
  (`await handle.get(key)`; `handle.keys()` pages keys from storage). There is no live key list: a collection you show
  live is a singleton; large collections are methods returning pages.
- **Shape:** a document's root is always a JSON object (as in Durable); a list lives in a field (`items`). Documents
  hold JSON only.
- **Only `tx.draft`** (as Durable's `tx.doc`): `await tx.draft(handle, key?, { tags? })` returns a draft of the current
  document, or a draft over `initial()` if it is absent. Reading is drafting: the draft is an overlay, nothing is
  copied. A draft you don't change commits nothing, so reading never stores an absent document. `tx.retire(handle,
  key?)` removes one; a retired singleton reads as `initial()` again. There is no `tx.get`. Shorthands:
  `handle.change(fn, ctx)` (keyed: `handle.change(key, fn, ctx)`) and `handle.retire(ctx)` (keyed: `handle.retire(key, ctx)`).
- **Values are immutable by convention:** `list.value`, values read in a transaction and published values are shared;
  nobody mutates them, and nothing is copied or frozen outside development mode.
- **Handles belong to their object:** they may be used only in transactions of their own object (or of the facet that
  serves it, concept 18).
- **Commit** (Durable's sequence): wait for the object's line (one transaction at a time per object), run the
  callback, write all persisted documents in one storage batch (the change as a delta, or a full base now and then),
  adopt the new values by pointer swap, notify local subscribers **once** with the commit's operations, send **one**
  batch per link. An error or abort before the write changes nothing. Nothing is revalidated or copied.
- **Durable's rule:** inside the callback only `await tx.*`. No other objects, network, models or processes, no second
  `self.tx` (otherwise the object's line hangs). Fetch first; decide and write inside.
- **Versions:** a changed shape or meaning raises `version` with a pure `migrate(old, from)`; documents migrate on
  access. Old code meeting a newer document throws; without `migrate` access is refused and the data kept. A failing
  load or `migrate` fails the whole owning object (`broken`, concept 7).
- **Schema fingerprints instead of value checks:** each definition computes a fingerprint (a hash) of its schema once;
  every stored document records the fingerprint it was written with. On access Chord compares the two: same version
  but a different fingerprint fails the object `broken` ("schema changed without a version bump"). That costs nothing
  per change; values are not walked against the schema in production. So every schema change needs a version bump
  (an additive one gets a trivial `migrate`). A changed meaning without a schema change still cannot be detected.
- **Tags** (`defineTag<T>(name)`, e.g. `SessionTag`) are set on create; deleting a session retires every document with
  its tag.
- **`persist` only in `local` objects and `lifetime: "host"` objects** (identities without a principal). A `remote`
  object's identity contains the principal key (how the client connected, the grant revision), so its stored documents
  would scatter across access paths and be orphaned after a reconnect. The type checker enforces it (`self.state` in a
  remote factory accepts only non-persisted definitions), and at runtime the declaration fails with "persist needs a
  stable identity: put the documents into a local shared store".
- **Lifetime:** an in-memory document ends with its object (last reference released, linger expired); it survives
  reloads and native restarts of a live object. What must outlive the object is persisted, or lives in a
  `lifetime: "host"` object.
- **What survives a restart** is exactly what is persisted. Everything else (in-memory documents, native values,
  derives, routines, references) is rebuilt on activation.
- **The store** is a port of Durable's store design: lines, commits, migrations, tags and eviction (a keyed persisted
  document unused for 10 minutes leaves memory). Behind it is a `DocumentStorage`, passed to `createHost({ storage })`
  (in memory by default). Chord ships two: in-memory and SQLite (on Chord's SQLite drivers, which moved there from
  Durable; a Node driver, a Durable Object driver). Storages check only metadata and write the delta; they never
  rebuild or validate content on a commit. The server has one shared storage; each worker one for its session.
- **A storage error** ends the store and closes the host; `onError` gets `{ kind: "storage_failed" }` and the app's
  start code decides (exit with its own code for its supervisor, or reopen). Chord never ends the process.

| Kind of state | For | API |
| --- | --- | --- |
| document | data the object owns | `self.state`, `self.tx` |
| derive | computed values | `self.derive` |
| source readable | external data (Durable views, files, logs) | value plus ordered changes |
| paged method | large collections | a method returning pages |
| plugin database | full-text search, large blobs | a native value (concept 14) |

**Check questions**

1. Why must a network call that fetches a link title happen before `self.tx`, not inside it?
2. A viewer watches the list while `add` runs. How many updates does it get?
3. Why may the per-principal `Notes` not persist documents, while `NoteStore` may?

*Model answers:* (1) Inside a transaction only `tx` operations are allowed; anything else can hang the object's line.
(2) One, after the commit. (3) `Notes` is `remote`: its identity includes a principal key that changes (connection,
grant revision), so stored data would be orphaned; `NoteStore` is a local shared store, its identity is (type, input).
The type checker refuses a persisted document in a remote factory.

---

## Concept 14: Native values (`self.open`)

**The problem.** The inbox needs a file watcher: a **native value** (an OS-level thing: a file handle, a socket, a
process, a database connection). It must be opened, closed exactly once, never leak, and cannot be JSON or copied.

**The idea.** Native values live only in objects. An object declares one with `self.open(async ({ signal }) => value,
(value, reason) => close)`; it gets back a handle whose `.value` is the native value (reading it before activation
throws). Chord opens natives one after another in declaration order during activation (the object goes live after all
opens; a later opener may use an earlier handle's `.value`) and closes them in reverse order when the object ends.
**The value never changes during the object's life.**

```ts
// worker.ts: one inbox per worker
host.serve(NoteInbox, (_input, self) => {
  const info = self.get(SessionInfo, {});                        // start data (concept 5)
  const watcher = self.open(async ({ signal }) => {
    const { id, dataDir } = info.init.value;                     // read in the opener, after activation
    return watchDir(join(dataDir, id, "inbox"), { signal });
  }, (w) => w.close());
  self.routines.loop("import", async (ctx) => {                  // concept 15
    const store = await ctx.get(NoteStore, { session: info.init.value.id });
    for await (const file of watcher.value.files(ctx.signal))
      await store.add({ text: await read(file), by: "inbox" }, ctx);
  });
  return {};
}, { lifetime: "host" });
```

- **Why `lifetime: "host"` and no input:** the inbox must run as long as the worker, whether anyone looks or not, and
  the facet cannot `self.get` a type it serves (concept 18). So a worker-wide owner of a native value is a
  `lifetime: "host"` object without input that reads its session from the core's start data (`SessionInfo`).
- An **object with `self.open` is a native object;** one without is a **pure object**. The difference decides what a
  reload does (concept 23).
- Behaviour around a native value goes into routines; listeners on native values outside routines are forbidden.
- **An open that fails** makes the object `failed`: `transient` with backoff, or `broken` if the opener says so
  (`throw broken(error)`). A partly failed activation closes the natives already open; the next attempt opens all of
  them anew.
- **`close` gets a reason:** `{ kind: "reload" }` (the plugin is reloaded and the object restarts, concept 23),
  `{ kind: "stop" }` (the host shuts down) or `{ kind: "end" }` (the last reference ended, or the type was removed).
  Chord aborts only the object's own calls and jobs; other work using the native value is the owner's business, so
  `close` may drain instead of tearing down (code mode seals its sandbox and ends it when running scripts finish).
  Each `close` is bounded (30 s by default, then reported as a possible leak); a throwing `close` does not stop the
  others.
- **Natives that follow a relocation** (the session moves to another directory): the native is a stable manager
  opened once; a routine on the session location switches its internal resource (the watched directory) and bumps a
  generation, so late events from the old location are dropped.
- **No native values across plugins,** except through registry entries (concept 19). The facet may not open any.
- What an old native value does after its owner restarts is its owner's `close` (a model runtime keeps working until
  collected; a closed SSH connection fails its in-flight `exec`).
- **A native value for one call** (a temporary SSH session for a directory listing) is opened and closed inside the
  method with `try/finally`; there is no `ctx.open`.

**Check questions**

1. Why is the watcher not opened at the top of `worker.ts`?
2. What does "the value never changes" spare the author?

*Model answers:* (1) Native values live only in objects, which open and close them with their life; a module-level one
would leak across reloads and have no owner. (2) No stale handles, no re-reading at use, no replacement logic: if it
must change, the object restarts.

---

## Concept 15: Routines

**The problem.** Delete old notes every hour; import inbox files as they arrive. Bare timers and callbacks would keep
running old code after a reload and touch state from nowhere.

**The idea.** Standing behaviour is declared as a **routine**:

```ts
self.routines.every("cleanup", HOUR, (ctx) => dropOlderThan(30 * DAY, ctx));   // due time survives reloads
self.routines.on(settings, (value, ctx) => applyLimit(value, ctx));             // react to a readable or event
self.routines.loop("import", async (ctx) => { /* runs until the object ends */ });
self.routines.custom("ticker", ({ signal, run }) => {
  const t = setInterval(() => run(tick), 1000);
  return () => clearInterval(t);                                                 // cleanup undoes the setup
});
```

- Started when the object goes live, stopped when it ends, restarted with the new code on every reload of its plugin.
  Routines are named, so Chord recognizes them across reloads. Each run gets its own `ctx`; errors are caught and
  reported.
- **Serialized per routine:** the new instance starts only after the old handler in flight has settled (with a
  deadline, 10 s by default; a stuck handler is reported). Without this, an old handler midway through a restart and
  the new routine could both act on the same item.
- A routine **reconciles** from the current value ("make the world match this"), writes no "in progress" flags, and
  starts a job for long work. A handler that only cares about the latest value compares with the current value itself.
- No bare timers or callbacks that touch state outside routines, jobs or calls.

**Check question:** a reload happens while `cleanup` is halfway through. What happens? *Model answer:* the new routine
waits until the old handler finishes (or the deadline passes), then starts with the new code; the due time is kept.

---

## Concept 16: Rules across owners

**The problem.** Every thing has exactly one **owner**: the smallest object it belongs to, which holds its data,
enforces its rules in its methods and offers the operations others need. But some rules span two owners: "notes of an
archived session are read-only" involves the catalog (which knows archiving) and `NoteStore` (which holds notes).

**The idea.**

- **No plugin reads or writes another plugin's documents** (Chord or Durable). Data crosses plugins only through state
  and methods. Within a plugin, the facet's documents are readable and writable by the objects that facet serves.
- **The owner of the dependent data enforces the rule** by reconciling from the other owner's state with an idempotent
  routine. No cross-owner transactions, no "notify the other owner" calls that can be lost:

```ts
// NoteStore: "an archived session's notes are read-only"
const flags = self.state(NoteFlags);                       // { archived: boolean }, NoteStore's own document
const catalog = self.get(Catalog, {});                     // the server's session list (another owner)
self.routines.on(catalog.sessions, async (sessions, ctx) => {
  const archived = sessions[session]?.archived ?? false;
  if (flags.value.archived !== archived) await flags.change((d) => { d.archived = archived; }, ctx);   // idempotent
});
// add/remove refuse while flags.value.archived
```

After a crash the routine runs again with the current value. The catalog does not know the notes plugin exists.

- **Reading without starting a worker** is plain publishing between two objects of one plugin, no Chord mechanism:
  the plugin's worker facet keeps a summary (say, the note count) and a routine reports it to the plugin's server
  object by a method call; clients read the server object, which never starts a worker. The server object keeps the
  latest value per session (a document if it must survive a server restart) and ignores reports from an older worker
  incarnation. The session list, status, unread marks and artifact lists work this way.

- **Data core enforces belongs to core:** it is handed to core through core's API when the data is created (Durable
  `createConversation` with `init`), never written into core's documents directly.

**Check questions**

1. Why doesn't the catalog call `notes.archive(session)` when a session is archived?
2. The worker crashes right after the session was archived. Is the rule still enforced afterwards?

*Model answers:* (1) The catalog would have to know every plugin, and a call can be lost (crash, link drop); the
dependent owner reconciles instead. (2) Yes: on activation the routine sees the current catalog state and sets
`archived`.

---

## Concept 17: Jobs

**The problem.** Importing a 50 MB file takes a minute. The call that started it may end (tab closed); the work must go
on, be cancellable, not run twice on a retry, and its result must be recorded.

**The idea.** A **job** is owned work started by a method, in three steps (Durable's "sandwich"):

```ts
const ImportJob = defineJob("notes.import", {
  version: 1, args: ImportArgs, progress: ImportProgress, result: ImportResult, concurrency: 1,
});

const imports = self.job(ImportJob, {
  run: async ({ path }, ctx) => {                          // 2. effect: may do anything; keeps its code on reload
    let n = 0;
    for await (const line of readLines(path, ctx.signal)) {
      await add({ text: line, by: "import" }, ctx);
      ctx.progress({ n: ++n });
    }
    return { n };
  },
  finish: async (outcome, tx) => { /* 3. outcome, in the current code, Durable's rule */ },
});
return {
  imports: imports.running,                                // live: [{ id, version, args, progress, phase }]
  startImport: ({ path, requestId }, ctx) => imports.start({ path }, ctx, { key: requestId }),   // 1. intent
  abortImport: ({ id }) => imports.abort(id),
};
```

- **1. Intent** is a transaction: the busy check (`concurrency`) and deduplication (`key`: the same key returns the
  existing run) are atomic; `run` starts only after the commit. Run ids are uuidv7.
- **2. Effect:** `run` may do anything; external writes carry a dedupe key derived from `ctx.jobId`. On reload it
  keeps its old code.
- **3. Outcome:** `{ ok: true, result } | { ok: false, error: "threw" | "aborted" | "lost" }`. Chord records it, then
  calls the **current** code's `finish(outcome, tx)` and acknowledges in the same commit. A throwing `finish` is
  retried.
- **Abort is a request:** it fires `ctx.signal`; the run decides what it returns.
- **Waiting:** `start` returns a run with `outcome(ctx)`; the caller's abort ends only its wait, never the run.
- **`phase`** in `running`: `running`, `finishing` (outcome recorded, `finish` not yet committed), `blocked` (no
  adapter for an old version, concept 26).
- **Jobs keep their owner alive:** a running, finishing or blocked job counts as a reference to its object; the object
  ends only once all its jobs are settled. Starting an import and then closing the tab does not abort it.
- **Persistence:** in memory by default. `persist: true` keeps the record: a run live at a crash ends `lost` at the
  next activation. Nothing is rerun automatically.
- **Not jobs:** request/response work (a method), input into running work (concept 22), work that must resume after a
  crash (a Durable task).

> **Open: jobs as objects.** A login or a long relocation is a job whose state consumers want to address and watch
> (`LoginFlow { id }`). Options: (a) jobs stay records inside their owner, watched through `running`; (b) a job is an
> object of its own, addressed by its id, living until done.

**Check questions**

1. The tab sends `startImport` twice with the same `requestId` (retry after a link blip). How many imports run?
2. A reload of the notes plugin happens during an import. Which code runs the rest of `run`, which runs `finish`?

*Model answers:* (1) One: the key dedupes atomically. (2) `run` keeps its old code; `finish` runs in the new code.
(`NoteStore` is a pure object; in a native object the run would end `aborted`, concept 23.)

---

## Concept 18: The facet

**The problem.** A plugin needs per-host setup: serve its types, contribute to extension points, maybe keep some
plugin-wide data.

**The idea.** The **facet** is the plugin's setup for one host, and itself a **pure object** that lives as long as the
host:

```ts
// notes/server.ts
export default defineFacet((host, self) => {
  const prefs = self.state(NotesPrefs);                    // plugin-wide documents
  self.contribute(Http, { routes: { "GET /s/:session/notes.txt": exportNotes } });   // concept 19
  host.serve(SomeServerType, (input, principal, self) => …);
});
```

- It may hold documents, references, routines and contributions; **no native values**.
- **Its identity is the plugin's `package.json` name** (setting): its persisted documents are found by that name, so
  they survive restarts and reloads, and never depend on a directory or the load order.
- Served objects go live after the facet and may read and write the facet's documents; one transaction may span an
  object's own documents and its facet's (lock order: own line, then the facet's). The facet never reaches into a
  served object's documents, and never `self.get`s a type it serves itself.
- `host.serve` and contributions are valid only while the setup runs.
- **Between plugins** only two things pass: object types and registries.

**Check question:** why does the facet not open the inbox watcher? *Model answer:* the facet is a pure object; native
values live only in objects with a lifetime of their own, which open and close them.

---

## Concept 19: Registries

**The problem.** The notes plugin adds a download route; a logs plugin wants to time every request; several plugins
add model providers. Someone must combine these contributions, decide conflicts, and replace a plugin's part as a
whole on reload.

**The idea.** A **registry** is an extension point owned by someone (a Chord component, the app, a plugin). Each
contributor (a facet or an object) contributes **at most one value** per registry; the table is an immutable, ordered
list of `(contributor, value)`; the registry's **`compose`** turns it into what consumers use:

```ts
export const Http = defineRegistry<HttpContribution, Router>("chord.http", {
  version: 2,
  accepts: { 1: (old) => upgrade(old) },
  compose: (table, { report }) => buildRouter(table, report),   // pure; always delivers a value, reports conflicts
});

self.contribute(Http, { routes: { … }, wraps: [ … ] });   // a contributor
const router = host.registry(Http).value;                  // a consumer: live
```

- **`compose` runs at runtime, whenever the table changes:** after a reload's commit, when a contributor goes live or
  ends, when a contribution changes (contributions may themselves be readables, known only once a native value is
  open). Because contributions can change at any time, no check before a reload could be complete, so conflicts are not
  a reason to roll back.
- **It always delivers a value,** with its fallback built in (e.g. the first by plugin name wins), and reports
  conflicts through `report` (they become notices to the owner and telemetry events). Readers get a plain value and
  never handle conflicts. Only if `compose` throws is the registry in an error state; readers then get an error when
  they use it. Work that started earlier keeps the value it read.
- **A contribution is in the table exactly while its contributor is live:** a facet's while its plugin is loaded; an
  object's from `live` until it ends, fails or restarts.
- **The owner decides** conflicts, order and which contributions apply where. Helpers: `keyed(...)`, `ordered(...)`.
- **Optional dependencies** are registries owned by the dependent (concept 8): ports contributes its forwards to
  `radius.forwards`; without ports the table is simply empty.
- **Contributor order** is sorted by plugin name (the `package.json` name): the same on every host and across
  reloads, and deliberately meaningless. Meaningful order comes only from the owner's composition (for HTTP: phases,
  concept 20).
- **Versions:** a contribution carries the registry version its plugin was built against; older ones are adapted with
  `accepts`, newer ones are refused at load.
- **Registries may carry native values.** An entry lives exactly as long as its contributor. Consumers look up at each
  use (or follow the composed value) and keep nothing from an entry beyond a use. This is the only way native values
  reach other plugins. Example: the models plugin's object contributes `() => runtime`; the agent harness looks it up
  at every request; after a reload the next request gets the new runtime, while a running stream finishes on the old
  one.
- Registries add behaviour (tools, routes, renderers, commands); they never replace an owner's checks. Entries have no
  lifecycle: anything needing cleanup is a native value of the contributing object.

**No callbacks between objects.** Members carry data only, on both kinds of types. A callback would carry code and
whatever it closes over from one object into another. Example: `NoteInbox` passes `onFile` to another object, which
keeps it. After a reload of the inbox's plugin, that object still calls the **old** `onFile`; after `NoteInbox` ends,
it calls into an object whose native values are already closed. The replacements: behaviour from outside goes through a
registry (the entry lives exactly as long as its contributor and is looked up at each use), multi-step work through a
job, input from a person through a flow (concept 22).

**Check questions**

1. Notes and files both contribute `GET /download`. When is that noticed and what happens?
2. A route handler stores `const r = entry()` in a module variable and uses it for days. What's wrong?
3. Object A passes a callback to object B, which keeps it. What does B call after A's plugin is reloaded, and after A
   ends? What do you use instead?

*Model answers:* (1) When `compose` runs after the second contribution enters the table (at runtime, not in a reload
check): the router still works, the first by plugin name wins, and the conflict is reported to the owner and as a
telemetry event. Nothing is rolled back. (2) It keeps a value from an entry beyond a use; after the contributor
restarts it holds a stale or closed native value. Look up at each use. (3) After the reload, A's old code; after A ends, code of an object
that no longer exists, with its native values closed. Instead: a registry entry, a job, or a flow.

---

## Concept 20: HTTP routes and wraps

**The problem.** Every plugin that serves a download would repeat ranges, HEAD requests, download headers, streaming
and abort on disconnect, and get some of it wrong.

**The idea.** HTTP is an optional Chord component (`@earendil-works/chord/http`) with a registry. It is built
after the kernel and a first real proof (harness, one tool with an approval pause, a code mode reload); until then the
playground serves its pages with plain app code. The design below is the target. A route gets a
plain request summary (method, path params, query, principal, provenance such as local or relayed, selected headers,
parsed and capped JSON bodies, uploads in chunks) and a `ctx` whose `principal` is the request's principal (from the
request resolvers, which decide who sent a request: cookie, loopback, relay). So `ctx.get(Notes, …)` gives exactly the
view that person may see. The route returns a **description**; the component does the HTTP work once:

```ts
| { kind: "json"; value } | { kind: "page"; title; body }
| { kind: "bytes"; name; mime; size; read(offset, length) }
| { kind: "redirect"; to } | { kind: "error"; status }
```

```ts
// notes/server.ts: a route is (req, ctx) => Promise<HttpResponse>; ctx.principal is the request's principal
self.contribute(Http, {
  routes: {
    "GET /s/:session/notes.txt": async (req, ctx) => {
      const notes = await ctx.get(Notes, { session: req.params.session });   // the requester's view
      const text = encode(render(notes.notes.value));
      return { kind: "bytes", name: "notes.txt", mime: "text/plain", size: text.byteLength,
               read: (offset, length) => text.subarray(offset, offset + length) };
    },
  },
});

// logs/server.ts: a wrap (middleware) around every route
self.contribute(Http, {
  wraps: [{
    name: "access-log", phase: "observe", scope: "all",
    wrap: async (req, next, ctx) => {
      const t = Date.now();
      const res = await next(req);
      log(req, res, Date.now() - t);
      return res;
    },
  }],
});
```

- **Routes** are composed with `keyed`: two contributors with one pattern is a reported conflict; the first by plugin
  name wins.
- **Wraps** run in **phases the owner defines** (`observe`, `headers`, `transform`; outermost first), within a phase in
  contributor order. That order is deterministic but meaningless, so wraps in one phase must not depend on each other.
  No numeric priorities (Fastify's lifecycle phases are the model).
- **Scope:** a wrap applies by default only to its own contributor's routes (`scope: "own"`); `scope: "all"` is
  explicit; `route` narrows it to one route, and a `route` that does not exist is a reported conflict.
- Wraps may add a security boundary on top of an owner's checks, never instead of them.
- A request uses the router as it was when the request started.
- A **channel component** provides WebSocket byte channels (`send`, `onData`, `close`) for terminals, with their own
  flow control, separate from object links.

**Check questions**

1. Who handles a `Range: bytes=1000-` request for `notes.txt`?
2. The logs plugin adds a wrap without `scope`. Does it see requests to `notes.txt`?

*Model answers:* (1) The HTTP component: it calls `read(offset, length)` and sends 206; the route only describes the
bytes. (2) No: the default scope is `own`, only the logs plugin's own routes; it needs `scope: "all"`.

---

## Concept 21: Who is here: presence

**The problem.** Show "2 people viewing"; keep the worker alive while someone looks; know when a login flow's owner
left.

**The idea.** `host.references(Type)` is a readable of who holds references to objects of a type on this host (input,
principal, client). Each tab is its own client (an origin id the client cannot set).

```ts
const viewers = self.derive("viewers", [host.references(Notes)], ([refs]) => refs.length);
```

- **A link drop is a departure:** accurate and simple. Smoothing (a phone switching networks flickers the count) is
  the UI's job, e.g. a debounced viewer count.
- **Counts per person** are derived by the app from the principals and origins in the list; two tabs of one person
  are two clients.
- **No lingering on the consumer side:** a closed tab closes its link, so it cannot keep anything. What keeps a
  just-closed object warm is the provider's `linger` (concept 7), and that also keeps the worker alive (concept 4).
- "Leaving" is never derived from a component unmounting (concept 23), only from navigation or presence.

**Check question:** the owner closes the notes tab and reopens it ten seconds later. Is the viewer count briefly
lower, and does `Notes {S1}` have to be rebuilt? *Model answer:* yes, the count drops while the link is gone (the UI
may smooth it); no rebuild if the type has a provider-side `linger` longer than ten seconds: the object stayed warm.

---

## Concept 22: Input into running work: flows

**The problem.** A login asks for a pasted code, then an account choice; a tool asks for approval. The running work
waits for a person who may be on any tab, may reconnect, may answer twice.

**The idea: the owner keeps the flow as state.**

```ts
start({ provider }, ctx)          → { id }                  // uuidv7
LoginFlow {id}: state { status: "running" | "done" | "failed" | "cancelled", step?: { id, kind, … }, notices }
answer({ id, step, value }, ctx)  → ok | "step no longer active"
cancel({ id }, ctx)
```

- The UI watches the state; a late or second answer to a step that is gone is refused.
- A promise-based callback (pi-ai's `prompt`) stays **inside** the owner (its job keeps the resolver); nothing crosses
  an object boundary.
- **Imperative consumers** (tests, scripts, a CLI, an agent tool) use a generic client helper over the same state, not
  a second protocol:

```ts
for await (const step of steps(await ctx.get(LoginFlow, { id }), ctx))
  await login.answer({ id, step: step.id, value: answerFor(step) }, ctx);
```

- Another pattern is the shared **Questions service** (`questions.md`): typed questions, policies over a live
  audience (`first`, `quorum`, `all`), reattach by `key`, deadlines. Its store must live in an object.

> **Open: where a flow lives.** Options: (a) a keyed document of its owner (`Login`); (b) an object `LoginFlow {id}`
> living until done (tied to "jobs as objects", concept 17).

**Check question:** why not a server method `step()` that blocks until the next step? *Model answer:* a link drop fails
a long call and the consumer can't tell whether it missed a step; the helper reads state that re-holds by itself and
remembers the last step id.

---

## Concept 23: Reload

**The problem.** New code must take over without losing data, open watchers, running imports or connected tabs, and a
broken change must not leave a host half-updated.

**The idea, per host:**

```
1. load      the plugin's new bundles; an import or syntax error rejects
2. staging   facet setups and every live object's new factory run with a recording `self`
             (declarations only, nothing activated); a throw rejects
3. commit    the host switches to the new code atomically
4. after     per object, below
```

- **Rollback is all-or-nothing per host:** any code error in load or staging (an import error, a throwing factory)
  leaves the whole host on its previous code. A host is always completely at one revision, so its status is one value.
  Runtime states (a registry conflict, a failed open, a migration) are not reasons to roll back.
- **Pure objects** are swapped in place: new methods and derives; documents, references and jobs stay; routines
  restart (serialized); new references become live; then the gate opens. Running calls finish on the old code and keep
  their old handles valid until they settle (their transactions keep working); only new calls get the new handles.
- **Native objects of the reloaded plugin restart:** their running work ends `aborted`, native values close (reason
  `reload`), the new factory runs, native values reopen. Documents stay (they belong to the identity). In practice this
  costs little: the Durable harness is base code, terminal processes live in a separate host process, and model
  runtimes, sandboxes and the search index rebuild in milliseconds; only reloading the plugin that owns SSH
  connections (running remote commands are killed) or the relay socket (relayed connections drop) hurts.
- **Why natives are not kept across a reload by name:** a native value has no line, no transactions and no schema, so
  old and new code would use it interleaved without any check.
- **After the commit,** errors stay with one object: a failed open makes it `failed` (backoff); a migration that throws
  refuses that access; a method bug fails that call.
- **Removing a type** ends its objects; in-memory documents go; persisted ones stay until retired.
- **Consumers on other hosts** see a restarting object like any object that briefly goes away.
- No factory trial, no migrate dry run, no consumer check in staging: an incompatible consumer fails at bind with
  `contract_mismatch` and a notice naming plugin and type.
- **Start barrier** (host start, first load): load the facets (the core facet with its start data among them), wait
  until every facet and every `lifetime: "host"` object is live or failed, then resume dependent work (the Durable
  harness, concept 28). An object that must contribute at start (the model runtime) is therefore `lifetime: "host"`.

**In the notes plugin:** you change the cleanup interval and the reader's filter, and reload. `Notes` and `NoteStore`
are pure: swapped in place, the notes stay, open tabs keep their references, a running import keeps its old `run`.
`NoteInbox` has a native value: it restarts, the watcher closes and reopens.

**Loading and the dev loop.** Plugins come from built-in, global, package and project roots, found by directory
listing; the server selects; dependencies resolve by contract name at runtime; names are prefixed (`<plugin>.<name>`).
The loader is an adapter: one base bundle per surface plus one script per facet (loader D, which reads each plugin's
`package.json` name), or static imports (tests, Durable Objects), where the app passes the same name to `load`. A
source watcher only marks plugins dirty; a reload control (web shell, CLI, agent tool) reloads them or restarts all
hosts for base code.

**UI reload vs. leaving:** a reload of a UI facet unmounts and remounts components. "Leaving" (abort a login, close a
TUI overlay) is therefore never derived from an unmount, only from explicit navigation or presence (a dropped
reference).

> **Open: project plugins.** Per-directory plugins with trust and snapshots (`plugin-loading.md`) need their own pass
> over this design.

**Check questions**

1. A typo in the new `NoteStore` factory throws in staging. What runs afterwards?
2. Which notes objects restart on a reload, and why only those?
3. Why is rollback per host enough, instead of per plugin?

*Model answers:* (1) The whole host keeps its previous code; nothing changed. (2) Objects with a native value
(`NoteInbox`): a native value can't be swapped safely in place; pure objects are swapped. (3) A host is then always
completely at one revision, so its status is one value per host.

---

## Concept 24: Rollout across hosts

**The problem.** A reload touches the server, every worker and every client. Calls between hosts keep flowing while
they update one by one.

**The idea.** A **revision** is (server incarnation, sequence) and names the complete desired code set (every facet
with its digest). The rollout goes server first, then workers, then clients. Each host reports `installed`,
`installed_failed` (named failed objects) or `rejected` (with the reason; it stays on its previous code). A server that
rejects stops the rollout. A host that starts or reconnects installs the current revision before anything is routed
to it.

A call that reaches a provider on another revision gets the provider's revision and status:

| Provider | The call |
| --- | --- |
| ahead, or behind and installing | `updating`: values readable, calls park (60 s deadline, concept 8) |
| rejected | fails at once (retried on the next revision) |
| same revision | `contract_mismatch`: a real mismatch, final |

- **A host checks its own install status first:** if its own install was rejected, a call fails at once with the
  reason instead of waiting on a provider.
- **Installs are serialized per host.**
- **A revision carries a digest of the code set** (the hash over the facet bundles' content hashes, which the loader
  computes anyway). Hosts compare it on reconnect, so a server restart with unchanged code triggers no reinstall.

**Check question:** the server installed revision 8; worker S1 is still installing. A tab calls `Notes {S1}` with the
new contract. What happens? *Model answer:* the call parks until S1 reports revision 8, then runs.

---

## Concept 25: The wire

**The idea.** Exposed documents, derives and readables are state members on the wire: `snap` when a reference is held,
`ops` per commit (the draft's recorded operations, no diff), `ops` from diffs for derives, throttled `ops` for job
progress, `reset` after a migration, `error` for a failed member.

- **Commits are atomic for consumers:** one `state` frame per hold carries all member updates of a commit, applied
  before listeners run; a commit that touches several holds on one link travels as **one** frame. No consumer ever sees
  half a commit.
- **Compression:** large JSON envelopes are deflated on WebSocket links; byte segments stay raw; IPC never compresses.
- **Frame size limit** per link adapter (e.g. 16 MiB on client WebSockets, none on IPC): an oversized frame fails that
  call or member with `too_large`; the link stays up.
- **One encoding per frame:** a frame is encoded once per link and its size taken from the encoded bytes. **Relays**
  read only the frame header (hold id, kind, route) and forward the body without decoding it. **Receivers** check a
  frame once by its header; only untrusted callers' arguments are validated (concept 6). **Consumers** apply changes
  with structural sharing; nothing is validated or cloned.
- **Contract descriptions travel once per link:** a new reference sends only its type's fingerprint; the provider asks
  for the full description once per (link, fingerprint) and caches it for that link.
- **Flow control** per link: a byte window on WebSockets, a window of frame counts on IPC, applying to every frame.
  Calls are throttled by credits the provider grants; beyond them they wait locally; nothing is refused for being "too
  many". A relay that falls too far behind releases the hold and holds again; the provider sends a fresh snapshot.
- **Adapted bindings get diffs:** a consumer bound through an `accepts` adapter (concept 26) is served like a derive:
  Chord keeps the last adapted value per binding, applies the adapter to the new value and sends the difference.
- The link protocol has a version; hosts of different versions refuse each other (a web page reloads).

**Check question:** a guest adds a note; the owner's tab holds both `Notes {S1}` and a counter on the same worker. How
many frames reach the owner's tab for that one commit? *Model answer:* one `state` frame with both holds' batches.

---

## Concept 26: Versions

**The problem.** Parts change independently: a plugin built last month talks to today's provider; a document stored a
year ago meets new code.

**The idea.** Two kinds of versions:

- **Interface versions** (between parties that change independently) have adapters: object types (`version`;
  same version binds if the provider covers the caller; otherwise `accepts` keeps older consumers working, or they get
  `contract_mismatch`; the **fingerprint**, a hash of the type's description, covers input, variants and members, not
  placement), registries (`accepts` on contributions), jobs (`accepts` on outcomes; without an adapter the run is
  `blocked`, not refused).
- **`accepts` maps values per member,** pure functions:

  ```ts
  accepts: { 1: { state: { notes: (v2) => v1 }, methods: { add: (argsV1) => argsV2 } } }
  ```

  Chord wraps a state mapping like a derive and sends diffs per binding (concept 25); members an old consumer doesn't
  know don't appear.
- **Internal versions** (old and new code of the same owner) migrate: documents with a pure `migrate`, guarded by the
  schema fingerprint (concept 13).

| Surface | On change |
| --- | --- |
| object type | `accepts` adapter; coverage check |
| registry | `accepts` adapter on contributions |
| document | pure `migrate`, on access; a schema change without a bump fails the object `broken` |
| job | `accepts`; `blocked` without an adapter |
| native value | none: the object restarts |
| Durable tasks and documents | Durable's `migrate` |
| link protocol | refused; hosts update together |

**Check question:** why do documents get `migrate` but object types get adapters? *Model answer:* a document is shared
only between its owner's old and new code, so it is converted once; an object type is used by consumers that update on
their own schedule, so the provider keeps serving old shapes.

---

## Concept 27: Bytes and big transfers

**The problem.** A user uploads a 50 MB file to import. Base64 inside JSON grows it by a third; one giant message
blocks the link and fails as a whole on a drop.

**The idea.**

- **Bytes are a schema type** (`bytes()`, a `Uint8Array`), carried natively: references on memory links, structured
  clone on IPC, binary frames on WebSockets. Never base64.
- **Big transfers are chunked by the owner,** not by Chord:

```ts
beginUpload({ name, size }, ctx)                 → { upload }
append({ upload, offset, bytes }, ctx)           // about 1 MiB; awaited = backpressure
finishUpload({ upload }, ctx)                    → { id }
read({ id, offset, length }, ctx)                → bytes
```

- The awaited `append` is the backpressure; after a link drop the writer asks for the stored offset and resumes; an
  unfinished upload expires (the owner's routine). A small helper wraps the loop.
- Chord has no stream type: it would need its own rules for link drops, cancellation, relays and restarts, which the
  owner's offset protocol already survives with plain calls.

**Check question:** the link drops after 30 of 50 chunks. What happens? *Model answer:* the `append` in flight fails
like any call on a drop; after reconnecting the writer asks the owner for the stored offset and continues from chunk
31.

---

## Concept 28: The Durable harness

**The problem.** The agent runs on Durable (the transcript and task engine). It needs model access and execution
environments that come from plugins, and those plugins reload.

**The idea.** The harness is an **object in the core facet** (base code, so it restarts only with the host): a
`Harness` object with `lifetime: "host"` (it runs for the worker's whole life, whether or not anyone holds it; its
activation is the start barrier) opens Durable with `self.open` and gets models and environments from registry
entries, looked up at each use:

```ts
const harness = self.open(async () => Durable.open(storage, {
  models: () => host.registry(HarnessModels).value,                   // current entry at each use
  env: (target) => host.registry(HarnessEnvironments).value(target.cwd),
  settings: () => currentSettings(),
  registry,
}), (h) => h.close());
```

- Durable's `models` and `settings` accept functions, so each generation gets the current value.
- Its activation is the **start barrier:** open Durable without scheduling, wait for the required contributions, check
  cwd and model, then resume.
- After a models reload the next request uses the new runtime; a running stream finishes on the old one.
- Durable and Chord v2 share `Context`, `Draft` and `JsonValue` (same modules); only plain data crosses between them.
- Hooks such as tool approval open a Chord call scope with `host.root` inside Durable's hook.
- **Code mode** (a plugin) owns its sandbox as a native value. Its tool entry looks up the **current** sandbox when a
  call starts, so a call that was waiting (e.g. in an approval hook) during a reload starts on the new sandbox; the old
  one is sealed and drained in `close` (reason `reload` or `stop`).
- **Telemetry:** Durable gets the same `Context.telemetry`; submissions and tasks store a carrier (concept 29).
- App state lives in Chord documents; only transcript-bound data (entries that fork and rewind with a conversation)
  lives in Durable.

> **Open: a Durable Object profile.** Deploying Chord apps to Cloudflare Durable Objects: a DO can lose its memory
> while clients stay connected; routines need wake-ups (one alarm per DO); links between DOs are RPC stubs. Hot reload
> is not needed there, plugin composition is. For later.

**Check questions**

1. Why is `Harness` `lifetime: "host"` and not referenced like `Notes`?
2. Why does the harness look up `HarnessModels` at each use instead of reading it once when it opens?

*Model answers:* (1) It must run for the worker's whole life, also while nobody holds it (Durable tasks continue), and
the start barrier waits for `lifetime: "host"` objects. (2) The models plugin may reload; its entry is replaced, and an
entry's value must not be kept beyond a use. The next generation gets the new runtime.

---

## Concept 29: Telemetry

**The problem.** A guest's `add` is slow. The call crossed the browser, the server and the worker. Where did the time
go?

**The idea.** Chord reports traces, events and metrics through `@earendil-works/pi-telemetry`. Each host gets one
adapter (`createHost({ telemetry })`, nothing by default) that decides sampling, buffering, export and filtering.

- **The trace travels with the call.** `ctx.telemetry` is the current span. `call` and `hold` frames carry the
  caller's **carrier** (an opaque `Record<string, string>` the adapter writes and reads); the provider continues the
  trace under it, and a relay adds its own span. An unknown or missing carrier just starts a new trace, never an
  error.

  ```
  chord.call Notes.add            [tab A]
  └─ chord.relay                  [server]
     └─ chord.method Notes.add    [session:S1] principal=guest
        · event chord.commit docs=1 ops=1
  ```

- **Own spans:** `ctx.trace(name, attributes, fn)` runs `fn` with a child `ctx` under a child span, so calls inside are
  parented correctly.
- **Shared work** (one activation awaited by several callers, a worker start) is its own trace, **linked** to its first
  trigger; each waiting span links to it. Routine runs, job runs, eviction and background closes are their own traces,
  linked to their trigger where one exists.
- **Tiers:** spans for calls, methods, relays, holds, activations, opens, closes, loads, revocations, routine and job
  runs; events for commits inside methods, retries and parking; metrics for high-frequency background work (state
  frames, bytes, commit durations, in-flight calls, open links, park durations).
- **Nothing is measured just for telemetry:** only sizes the code already has (encoded frames, `byteLength`).
- **Durable** gets the same `Context.telemetry`; submissions and tasks store a carrier, so a task run links to its
  submission even after a restart. Persisted Chord jobs store their start carrier.
- **Debugging:** a JSONL trace file adapter, a text renderer and a trace viewer in the playground.

**Check question:** a routine in `NoteStore` runs every hour. Whose trace does its run belong to? *Model answer:* its
own (a root span), not a caller's; it is linked to its trigger where one exists.

---

## Concept 30: The cost model

**The problem.** A session's notes grow to 500 KB; ten tabs watch. If every added note made Chord walk, copy, validate
or re-encode the whole value per viewer, the app would crawl.

**The idea.** As little compute and memory as possible while staying correct. Values are immutable revisions that
share structure (Delta, as in Durable), so each hop does only the work for what changed:

| Hop | Work |
| --- | --- |
| commit | Delta's prepare (copies and checks only the placed values), adopt by pointer swap; storage writes the delta |
| reads in a transaction | the draft overlay, no copy; unchanged = no write |
| subscribers on the same host | the same value and ops by reference |
| derives | compute plus a diff; unchanged parts stay the same objects (`mapShared`, concept 9) |
| send | one encoding per frame and link |
| relay | header only, body forwarded unread |
| receive | header check; untrusted callers' arguments validated once at the provider |
| apply | structural sharing |
| new hold | the value encoded once (unavoidable) |
| memory | one authoritative value per document per host; replicas and derived values share structure |

That is why several earlier concepts look the way they do: values are passed by reference and never copied (concept
6), documents are guarded by a schema fingerprint instead of value checks (concept 13), and derives must keep unchanged
parts identical (concept 9).

**Cost guards:** in test mode Chord counts full-value walks, deep copies, encodes, schema validations and
materializations, and tests assert them per hop (one note appended to a 500 KB document with 10 viewers: no walks, no
copies, one encode per link, no validations). A benchmark suite records the numbers.

**Check question:** a guest adds one note to a 500 KB list watched by ten tabs over one WebSocket link each. What does
Chord encode? *Model answer:* the commit's small ops, once per link; the 500 KB value is neither walked, copied nor
re-encoded.

---

## Open points at a glance

| Topic | Concept |
| --- | --- |
| jobs as objects | 17 |
| where a flow lives | 22 |
| project plugins | 23 |
| a Durable Object profile | 28 |

App-level open points (p3, `design.md` section 26): session files, session delete, connection pools, config files with
a single writer, file formats as versioned interfaces, the terminal host process.

---

## Glossary

| Term | Meaning |
| --- | --- |
| host | one participant (a process, a tab): a logical identity plus an incarnation |
| link | a connection between two hosts; delivery only |
| relay | the server passing requests between clients and workers |
| host kind / address | typed description of addressable hosts / one host of a kind (`Session({ id })`) |
| placement | a type's `host` function: input → address |
| incarnation | a fresh id per host start; a restart is a new incarnation of the same identity |
| facet | a plugin's code for one host kind; a pure object living as long as the host |
| object type / contract | description: name, input, placement, members, version |
| `remote` / `local` | across links, per principal, untrusted arguments validated / own host, no principal, no checks; both pass values by reference |
| object | one instance per (type, input, principal key); `local`: per (type, input) |
| principal | who calls; stamped by links |
| principal key | maps a principal to an object identity |
| revocation | a small typed value the app revokes (`{ grant }`); `revokedBy(p)` says which ones hit a principal |
| variant | what a principal may see and do |
| shared store | a `local` object holding shared or heavy parts once, behind per-principal views |
| base code / core facet | the app's own code (`src/`), loaded under a fixed name such as `@app/core`; a change restarts the hosts |
| `SessionInfo` | the core's `local`, host-lifetime object holding the start data |
| reference | what `get` returns; keeps its object alive; live and hydrated when awaited |
| readable | a value plus its ordered changes |
| `ref.state` | `loading`, `live`, `failed` (cause, `retryAt`), `released` |
| failure cause | `transient` (automatic backoff) or `broken` (retried only by a trigger) |
| `ctx` | per call: signal, principal, call-scoped `get`, telemetry span |
| document | named JSON value an object owns, written in transactions |
| derive | value computed from readables |
| `mapShared` | keeps one result object per unchanged source element, so derives stay cheap |
| schema fingerprint | hash of a document's schema, stored with every record; catches schema changes without a version bump |
| native value | an OS-level value opened with `self.open`; lives only in objects |
| pure / native object | an object without / with `self.open` |
| routine | standing behaviour: `on`, `every`, `loop`, `custom` |
| job | owned work: intent, run, finish |
| registry | extension point; one contribution per contributor; `compose` turns the table into a value |
| wrap | HTTP middleware, in owner-defined phases |
| flow | input into running work, kept as the owner's state, step by step |
| staging | reload step: facet setups and factories run as declarations only, nothing activated |
| revision | (server incarnation, sequence): the complete code set a host runs |
| carrier | opaque trace context carried in `call` and `hold` frames |
