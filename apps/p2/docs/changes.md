# Chord and p2: decided changes

Changes decided while walking through Chord's concepts. Each entry says what changes, why, and what it touches. The
loader and reload work is in `plugin-loading.md` (12.1, 14); the open redesign of resources, listeners and lifecycles is
still being discussed and is not listed here until decided.

## 1. Terminology: facet > object type > object, reference

- **facet:** a plugin's code for one surface (`server.ts`, `worker.ts`, `web.tsx`, `tui.ts`); it serves object types.
- **object type:** declared by a contract: name, input (the address), members.
- **object:** one instance of an object type (Chord's code calls it a record).
- **reference:** what `get` returns (Chord's code: handle; the bookkeeping behind it: hold).

Code and docs (packages/chord, apps/p2) are renamed to these words: `record` → object, `Handle`/`Hold` → reference,
behavior → the object's code, resource spec → resource declaration, epoch → code version.

**An object's variant is named `variant`, not `kind`.** Factories return `{ variant: "editor", … }`, callers check
`ref.variant === "editor"`. Other `kind`s stay: member descriptions (`kind: "method" | "state" | "opaque"`,
`contract.ts:58-60`, part of the fingerprint), the link peer kind (`"host" | "client"`, hello frame), principals,
`Author.kind`, app types.

Sites: `RESERVED_MEMBERS` (`contract.ts:98`: `kind` → `variant`), `kindOf` (`record.ts`) and `VariantBehavior`
(`contract.ts:253`), the shape frame's `kind` (`wire.ts:79`, read at `connection.ts:864,990-994`),
`hosts/plugins.ts:295`, and every `ref.kind` / `{ kind: "<variant>" }` in plugin factories and UI code.

**Wire.** Renaming a frame field breaks old peers: a stale browser tab or TUI client would read no variant and fall back
to `LOCAL_VARIANT` (`connection.ts:990-994`), so every call fails with `not_in_variant`. The link hello
(`connection.ts:332`) gets a protocol version; on a mismatch the client is told to reload instead of continuing.

## 2. The object type says where it lives; callers stop passing `at`

**Today.** A caller names the host with every `get`: `get(Workspace, { session, conversation }, { at: \`session:${session}\` })`.
p2 has 59 literal `at: "server"` and 26 `` at: `session:${id}` `` (built by hand from strings), plus `at` passed along
as a value: the `at` option of `useObject` and `holdLingering` (`src/runtime/web.tsx:174,178`,
`src/runtime/linger.ts:63`), the positional `at` of the TUI `watch` (`src/runtime/tui.ts:84-109`),
`src/web/file-completion.tsx:59`, and several hundred in tests.

**Problems.**

- Stringly typed: a typo (`"sever"`, `"sesion:"`) shows only at runtime.
- Where an object lives is knowledge every caller must carry. Moving a type from the server to the worker breaks every
  caller, at runtime (`unknown type`).
- Redundant: the session is usually already in the input; callers write it twice.

**Change.** The contract declares its host declaratively, through typed helpers. A helper carries a static pattern
(`server`, `session:*`) and a resolver from the input to the host name:

```ts
export const Workspace = remote("workspace", {
	input: Type.Object({ session: Type.String(), conversation: Type.Number() }),
	host: sessionHost((input) => input.session), // pattern "session:*"
	…
});
export const Sessions = remote("sessions", { input: Type.Object({}), host: serverHost, … }); // pattern "server"

useObject(Workspace, { session, conversation }); // no `at`
ctx.get(Sessions, {});
```

- One place knows where a type lives: its definition. Host names come from the helpers, never from free strings.
- Local types (same host only) have no `host`.
- The resolver runs on the normalized input (Chord normalizes before resolving), so defaults count.
- `serve` checks the pattern against `host.name` ("Workspace is declared for `session:*`, but `server` serves it"). This
  covers types served outside facets too (`WorkerBoundary`, `PluginRemoval`, `Harness`), so a misplaced type fails at
  startup, not at the first call.
- The serving host checks, at acquisition, that the normalized input resolves to itself. A destination chosen by a
  client is never trusted.
- Placement is part of the contract fingerprint. Moving a type is a breaking contract change: existing references get
  `upgrade_required` and clients reload. References are not relocated live.

Types served on session workers with an empty input get a `session` input (version bump) and check
`host.name === \`session:${session}\`` in the factory: `WorkerBoundary` (`src/runtime/worker.ts:174`, caller
`plugins/sessions/server.ts:173`), `SessionTransfer` (`plugins/sessions/contract.ts:207`, callers
`plugins/sessions/server.ts:291,300`), `PluginRemoval` (`src/hosts/plugins.ts:107`, callers
`src/hosts/server.ts:301,333`).

**Touches.** Chord (via pi first): `host` helpers with pattern and resolver in `remote(...)` contracts, address
resolution without `at`, the check at `serve` and at acquisition, placement in the fingerprint; `at` stays only for the
transition. p2: `host` on every remote contract, the three input changes above, removing the 85 literal options and the
plumbed `at` (`useObject`, `holdLingering`, `linger.ts`, TUI `watch`, `file-completion.tsx`), tests.

## 3. Typed principals, all with a `kind`

**Today.** Chord types a principal as `unknown` (`packages/chord/src/old/types.ts:5`); factories receive `unknown` and p2
narrows it with helpers (`isOwner`, `isGuest`, `isWorker` in `src/runtime/principals.ts`). Chord also invents principals
of another shape, without `kind`, outside the app's type: `{ host: true }` for a host's own code (`host.ts:37`),
`{ host: parentName }` for the parent's own requests as a child sees them (`connection.ts:651`; in a worker:
`{ host: "server" }`), `{ host: hostName }` as the default for a routed host calling back (`host.ts:870`). Chord
recognizes the host principal by object identity (`principal === this.principal`, `host.ts:367,375,411`). Six places in
p2 cast by hand: five check `(principal as { host?: unknown }).host !== "server"`
(`plugins/search/worker.ts:167`, `plugins/conversations/worker.ts:124`, `plugins/sessions/worker.ts:67`,
`src/runtime/worker.ts:192`, `src/hosts/plugins.ts:222`), one checks `.host === true` (`mayReach`,
`src/runtime/server.ts:159`). p2's owner principal is confusing: `via: "device"` means the local machine,
`via: "relay"` covers both Radius and remote cookie devices, `device` is optional, and the owner has no name (`authorOf`
returns "Owner", the web prints the literal "Owner": `src/web/Chat.tsx:742,772`).

**Change, Chord (via pi first).** The principal type is a type parameter of the host (`createHost<P>(...)`); factories,
`ctx`, `principalKey` and `invalidatePrincipal` receive `P` and TypeScript narrows on `kind`. Chord invents no
principals: the app supplies the principal of the host's own code (`createHost({ self: … })`) and the one the parent's
own requests carry (`host.connect(link, { principal: … })`); relayed requests keep the caller's principal;
`route.principal` is mandatory (no `{ host }` default). Chord compares the host principal by `principalKey`, not by
object identity, so an equal principal never creates a second object.

**Change, p2.**

```ts
/** The person running this p2 (one today). */
export type OwnerPrincipal =
	| { readonly kind: "owner"; readonly access: "local" } // a browser on this machine (loopback), no owner cookie
	| { readonly kind: "owner"; readonly access: "relay" } // via Radius, authenticated by the relay
	| { readonly kind: "owner"; readonly access: "device"; readonly device: string }; // owner cookie, also on loopback
/** Someone who joined one session through a share link. */
export type GuestPrincipal = {
	readonly kind: "guest";
	readonly id: string;
	readonly name: string; // self-chosen, unverified
	readonly session: string;
	readonly mode: "view" | "full";
	readonly revision: number; // grant revision: removal, link reset or archive invalidates older ones
};
/** A session's worker calling the server. */
export type WorkerPrincipal = { readonly kind: "worker"; readonly session: string; readonly generation: number };
/** The server's own code calling into a session worker (fork, transfers, the conversation broker). */
export type ServerPrincipal = { readonly kind: "server" };
/** A host's own code calling objects on the same host. */
export type HostPrincipal = { readonly kind: "host" };
export type P2Principal = OwnerPrincipal | GuestPrincipal | WorkerPrincipal | ServerPrincipal | HostPrincipal;
```

- The five `host !== "server"` casts become `principal.kind !== "server"`, keeping their extra checks (`host.name`,
  session); `mayReach`'s `.host === true` becomes `principal.kind === "host"`.
- `principalKey`: `owner:local`, `owner:relay`, `owner:device:<id>`, `guest:<id>:r<revision>`,
  `worker:<session>:<generation>`, `server`, `host`.
- **Owner name.** Not in the principal: a link's principal is stamped once at accept, and the key decides which tabs
  share an object, so a name in it would go stale. A setting `ownerName` (default "Owner", validated) is read when
  writing: `authorOf` gets it from the worker's init values or a server value. The web renders `author.name` instead of
  the literal "Owner" (`src/web/Chat.tsx:742,772`). Names in Durable entries already written stay as written.
- "Revoke all remote owners" (today one pattern `{ kind: "owner", via: "relay" }`, `src/runtime/server.ts:72`) becomes
  two propagating pattern calls, `access: "relay"` and `access: "device"` (patterns match equal fields; predicates do not
  propagate to child hosts, `host.ts:125`).
- Call sites of `via`: stamping in `src/hosts/server.ts:418,426,427` (a device-cookie owner stays `access: "device"` on
  loopback), the loopback owner cookie (`src/hosts/server.ts:537`), Radius (`plugins/radius/server.ts:54`), owner
  cookies (`plugins/devices/server.ts:56`), revocation (`src/runtime/server.ts:72`). Checks of `via === "device"`
  become `access === "local"`: sharing join (`plugins/sharing/server.ts:260`), login `remote`
  (`plugins/login/server.ts:169`), owner-link minting and `canMint` (`plugins/devices/server.ts:115,170,175`).

**Later, not planned.** Several people (individuals, teams, orgs): users with IDs and roles instead of one owner,
sessions owned by a user or team, `canView`/`canSend` by membership. That touches every `isOwner` check (some mean
"admin", some "may use this session") and the single-tenant data directory (`models.json`, `auth.json`).

## 4. A `files` tool: send and open (low priority)

**Today.** `send_file` (`plugins/send-file/tool.ts`) copies a snapshot and shows a download card
(`src/web/Chat.tsx:504`). The `read`, `write` and `edit` cards already link into the workspace ("Open in workspace",
`src/web/Chat.tsx:335-342,388,399,543`). What is missing is a tool that only points the user at a file or directory,
without reading or writing it. The workspace route can show one:
`{ workspace: { tab: "files", directory, file: { path, view: "file", line } } }` (`src/web/navigation.ts`).

**Change.** One tool, `files`, with an `action`:

- `send` (path, optional name): today's `send_file`.
- `open` (path, optional line): resolves the path with `env.canonicalPath` through the session's environment, then
  checks that it is a file or directory inside the conversation's canonical cwd (the workspace shows nothing else; p2's
  private data directory stays excluded). It copies nothing and returns
  `details: { action: "open", path (canonical, cwd-relative), kind, line? }`; the web derives `directory` from `path`.

Replay: Durable's replay policy is per registration, so the whole `files` tool stays `replay: "unsafe"` like
`send_file` (`plugins/send-file/tool.ts:20`), unless `send` becomes idempotent.

Web: the card shows the file with "Open in workspace →", navigating to the workspace route above; the link is hidden for
view-only guests, whom the workspace refuses (`plugins/workspace/worker.ts:177`, `canSend`). Undecided: also open it
automatically when the call finishes while the conversation is open in that tab (client-side only, never when loading
history; only for owner and full guests). TUI: no docked workspace; open it in the file view or show the path.
`/downloads` lists `files` send calls as well as old `send_file` calls.

**Open question: old names.** Durable stores tool names in the `pi.agent` selections (`tools`,
`packages/durable/src/harness/agent.ts`), and pending calls resolve by exact name (`packages/durable/src/harness/tool.ts:210`).
Subagents store `"send_file"` in their tool list (`CODING_TOOLS`, `plugins/subagents/tools.ts:31`), and models copy
calls from their history. An alias in the subagent registry is therefore not enough. Either keep `send_file` registered
as a hidden compatibility tool (old arguments, unsafe replay, not offered to new configurations), or migrate the
`pi.agent` selections.

**Touches.** Old Durable entries are named `send_file`: the web card, the TUI renderers and `/downloads`
(`toolViews("send_file")`, `plugins/send-file/tui.ts:99`) keep rendering that name. Rename in `CODING_TOOLS` and the
tool descriptions (`plugins/subagents/tools.ts:31,279`, `plugins/agent/tool.ts:49`), the fake provider
(`plugins/models/fake.ts:22`) and tests.

## 5. `lifetime` instead of `eager`

**Today.** `host.serve(Type, factory, { eager: true })`: the host creates the object when the facet loads, `load` waits
until it is live unless `awaitEager: false`, and the host holds it until it closes. Only such objects may register into
registries (`record.ts:1505`). `eager: { input }` allows another input (`record.ts:50`), and any host-principal `get` of
an eager type with another input also gets the eager flag (`host.ts:410-411`). The name says when the object is created,
not what matters: how long it lives.

**Change.** An explicit lifetime:

| `lifetime` | Created | Ends | `linger` |
| --- | --- | --- | --- |
| `"referenced"` (default, when omitted) | at the first `get` of its address | after the last reference is released, plus `linger` | allowed (default 0) |
| `"host"` | when its facet loads; loading waits until it is live (see below) | when the host closes, or a reload removes its facet | not allowed |

- `"host"` is allowed only for local types, and the object has exactly one address: an empty input (or only defaults),
  the host principal. Other inputs are rejected; `eager: { input }` is dropped. Others reach it with `get`; their
  references do not change its lifetime.
- Loading waits for `"host"` objects by default. An explicit option (today's `awaitEager: false`, renamed) defers this:
  a worker uses it to avoid the startup deadlock with the server, whose link is admitted only after the worker reports
  ready (`src/hosts/worker.ts:49-62,86-93`).
- A `"host"` object whose activation fails is retried at the next reload, as today (`reload.ts:586`).
- Registrations stay limited to `"host"` objects.
- Most of today's `eager: true` objects are `contribute` dummies for registrations (`src/runtime/contribute.ts`); 15 of
  the 34 also own references, resources, listeners or tasks, so they stay objects.
- `lifetime: "host"` replaces `eager: true` one to one. Catalog is not eager today, and the server's models object
  lingers 60 s (`plugins/models/server.ts:67`): making them `"host"` would be a deliberate behavior change, not part of
  the rename.

## 6. References re-acquire by themselves after their object goes away

**Today.** A reference whose object is forcibly ended (its worker exited, a reload removed its type, access was
revoked) goes `gone` and stays dead; the caller must `get` again. p2 does that by hand: `useObject`
(`src/runtime/web.tsx:183`) re-acquires 500 ms after any `gone`, the TUI `watch` (`src/runtime/tui.ts:84`) retries with
backoff. For a lost **link** Chord already re-attaches remote references by itself (`connection.ts:939-941`, `connect`),
so the two cases behave differently. Revocation ends objects with code `gone` (`host.ts:704`, `connection.ts:441`) and
then closes the link (`connection.ts:445`; p2 passes no `restamp`): the browser's references go `loading` and wait for a
reconnect. p2 detects an ended share only through HTTP (`src/hosts/web/main.tsx:31-52`).

**Change.** A reference re-acquires its object after a retryable loss, as it does after a lost link, with backoff.

- **Decided by error code and reason, defined across the wire.** Final: `forbidden`, `revoked`, `invalid`,
  `contract_mismatch`, `not_in_variant`, `upgrade_required`, `unavailable` with reason `unknown_type`. Retryable: link
  loss, worker exit.
- **Revocation is final.** `invalidatePrincipal` ends references with the distinct reason `revoked`, including
  provider-side and relayed holds; they are never re-acquired with the old principal. A link whose reconnect is refused
  by authentication ends its references instead of leaving them `loading`.
- **Failing workers.** p2's server throws a `ChordError` with a reason (`worker_failed`) for a kept start failure
  (`src/runtime/server.ts:271,297`), so it is final. A crash after start does not block today
  (`src/runtime/server.ts:391-393`); with re-acquire, N crashes within T become sticky like a failed start. The owner's
  Retry (`src/runtime/server.ts:475`) clears the failure and revives the ended references of that worker.
- **Only the origin re-acquires.** Relays (`connection.ts:183-190`) forward the loss and do not re-acquire on their own.
- **Bindings.** A remote reference tracks the channel plus the hold's incarnation: decoders are reset, subscribers kept,
  late frames from the old incarnation ignored (`remote.ts:84-95`). `ready` belongs to one binding generation; UI hooks
  subscribe to `onStatus`. Calls while re-acquiring wait up to a deadline (the worker's `readyTimeout`, 60 s,
  `src/runtime/server.ts:430`), then fail.
- **References held by factories.** A re-acquired reference points to a new object: the holder's resources declared
  on it (`deps`) and its listeners on it reopen. A changed variant or fingerprint after re-acquire is emitted as a shape
  change.
- Calls in flight at the loss fail (as on a lost link) and may be retried.

Statuses: `loading` (initially and while re-acquiring), `live`, `ended` with a reason (released by the holder, or a
final error). `released` and `gone` merge into `ended`. The reference object stays the same; state subscribers get a
fresh snapshot.

**Idle stop vs re-acquire (decided: a).** A worker stops when idle; today only `Chat` and `WorkspaceBackend` count as
viewers (`plugins/chat/worker.ts:520`, `plugins/workspace/worker.ts:72`). Any other held worker object (TUI watches,
lingering holds) would re-acquire after an idle stop and restart the worker at once. Decision: any worker object held
by a client keeps the worker alive (holding is viewing); the per-plugin viewer counters go away.

**Touches.** Chord: `remote.ts` (bindings, incarnations), `record.ts` (reopening dependents), `connection.ts` (reasons
across the wire, relays), `host.ts` (`invalidatePrincipal`). p2: `linger.ts`, `useObject`/`useStatus` in `web.tsx`, the
backoff in the TUI `watch` (`tui.ts`, lifted into Chord), the start failure reason and crash cap in
`src/runtime/server.ts`.

## 7. API cleanup pass: declarations by name, void methods (batch with 1, 2, 3, 5)

**Today.** Declarations are maps of name to a wrapped declaration: `self.state({ notes: cell(schema, initial) })`,
`self.derive({ count: derivation([sources], fn) })`, `self.resources({ db: resource({ rev, … }) })`,
`self.tasks({ load: fn })`, `self.listen({ view: listener(source, select, fn) })`. The spec chose property names in
object literals on purpose (`packages/chord/docs/old/spec.md:76`), with no recorded reason beyond that (presumably duplicate
names caught by TypeScript, several declarations per call). Methods without a result declare `Type.Null()` and return
`null`; methods without arguments declare `Type.Null()` and are called with `null`. The state version is per object
(`serve(…, { state: { version, migrate } })`). In p2: 28 `self.state` with 41 cells, 16 `self.derive` with 19
derivations, 44 resources, 10 task blocks, 15 listeners; 62 `Type.Null()` results, 16 `Type.Null()` arguments, 90
`return null;`, 10 `(null, ctx)` calls; state versions on two objects (status v2, subagents v3).

**Rule.** A declaration has a name only if something of it survives a reload and must be found again: state (its
value) and resources (the open value). Derivations, tasks and listeners hold nothing across a reload.

**Change.**

```ts
const notes = self.state("notes", Type.Array(NoteSchema), []);                       // version 1 by default
const prefs = self.state("prefs", PrefsSchema, {}, { version: 2, migrate: (old, from) => … });
const count = self.derive([notes], (n) => n.length);                                  // no name
const db = self.resource("db", { version: 1, deps: [server], open: () => …, close: (db) => db.close() });
self.task(async (ctx) => { … });                                                       // no name
self.on("view", watch, watchSource, (event, ctx) => { … });                           // name kept for now, see below
return { notes, count, add: … };                                                       // exposed state = what is returned

members: { add: method(Type.Object({ text: Type.String() })), reload: method() }      // no result = void
add: async ({ text }, ctx) => { … },                                                  // returns nothing
await store.reload(ctx);                                                               // no-argument call
```

- **State.** `self.state(name, schema, initial, { version?, migrate? })` returns the cell. On reload, the same name
  returns the existing cell and its value (`initial` ignored); a raised version runs `migrate(old, from)` and validates
  the result; a schema change without a version bump refuses the reload, so the version is optional (default 1). The
  version moves from the object to the cell. Private state is state that is not returned; exposed state is returned
  as members. A nested value stays one cell (`change` sends only the changed paths).
- **Derivations.** `self.derive(sources, fn)`: no name; recomputed at commit (today kept with the function replaced).
- **Resources.** `self.resource(name, { version, deps?, exclusive?, open, close? })`: `rev` becomes `version`
  (required: a native value has no schema to detect a change); `deps` and `exclusive` keep today's semantics. The open
  resource redesign (leases, lifetimes, Durable sources) is not part of this pass.
- **Tasks.** `self.task(fn)`: no name; restarted at every reload as today.
- **Listeners.** `self.on(name, source, [select,] handler)`: today's semantics (a kept subscription with the new
  handler, matched by name), so the name stays for now. It goes away when listeners resubscribe at commit, which needs
  the shared Durable sources from the base (the open listener redesign).
- **Methods.** `method(args?, result?)`: an omitted result is `void` (handlers return nothing), omitted arguments mean
  a no-argument method called as `ref.name(ctx)`. Chord knows both from the contract on both sides; on the wire it
  sends `null` internally.
- `cell()`, `derivation()`, `resource()`, `listener()` and the declaration maps go away.

**Batch.** One pass after the in-place relocation lands (it touches the same plugin files), together with entries 1
(terminology, `variant` with a link protocol version), 2 (object types declare their host), 3 (typed principals),
5 (`lifetime`), 8 (an awaited reference has its state) and 9 (state `init`). Chord first, via pi (Chord source, tests, docs `spec.md`/`guide.md`/`tutorial.md`; CI), then p2. Not
in the batch: 4 (`files` tool), 6 (references re-acquire), the resource and listener redesign.

## 8. An awaited reference has its state, local or remote (batch)

**Today.** For a local reference, `await ref.ready` means the object is live and its state exists. For a remote one it
only means the object is live (`shape`). Remote state is transferred only while someone listens: snapshot, then deltas.
A remote readable unsubscribes upstream and forgets its value when its last listener leaves (`remote.ts:81-86`). So
`ref.notes.value` after `await ref.ready` can be `undefined`, and state members are typed `T | undefined`
(`contract.ts:258,274`). Code asserts the value where it is guaranteed (in `open` with `deps`, in methods, listeners and
tasks): p2 has 27 `.value!` in plugin and runtime code (33 with tests) and 98 `!` on opaque members. A resource's
`.value` throws `not_ready` instead (`record.ts:121-125`, in a factory `:191`).

- Every remote `get` makes its own remote reference and its own hold over the link (`#acquireRemote`, `host.ts:811`),
  each subscribed member its own feed. Every hold frame carries the full contract description (`connection.ts:466`,
  `wire.ts:68`). p2 shares holds by hand: `linger.ts` (keyed by type, input and `at`; 2 min, at most 4, `keep`
  subscriptions) for some hooks and TUI watches.
- An object already goes live only after its declared references are live (`record.ts:923`; reload prepare
  `reload.ts:372-376`).
- The provider computes the diff of a change once and fans it out (`cell.ts:34-49`). Each feed then encodes it with its
  own stateful encoder (`connection.ts:812`), and each link serializes it and deflates it above 64 KiB
  (`link.ts:186`).
- A provider skips a snapshot whose value is `undefined` (`connection.ts:820`). State waits behind the ack window, one
  slot per subscription in creation order, up to 4 windows each (`connection.ts:26,363,402`).

**Change.** After `await` on a reference, every state member of its variant has a value, local or remote.

- **Ready.** A reference is ready when its object is live and every state member of its variant has its first snapshot.
  This includes state a local object forwards from, or adapts from, a remote reference it holds.
- **Gets.** `ctx.get` and `host.get` are async: they resolve once the reference is ready, and reject with the activation
  error (`forbidden`, unreachable, …). `self.get` stays synchronous: the object goes live only after its declared
  references are ready and hydrated. `ready` disappears from plugin code.
- **Awaiting.** An awaited get races `ctx.signal` and ctx close; `host.get` takes an `AbortSignal`. The deadline is the
  worker's `readyTimeout` (60 s, as in entry 6). Rejection or abort releases that view only. A pending await counts as a
  reference, so one waiter giving up does not tear down a binding others wait for.
- **One binding per host and key.** The key is (`at`, type, normalized input, principal key, contract fingerprint).
  Today's remote address uses the raw input and no fingerprint (`host.ts:993`). During a reload, old-epoch and
  candidate code hold two fingerprints, so two bindings exist until retire.
  - All references with the same key are counted views onto one binding: one hold, one feed per state member, calls over
    the same binding.
  - Views are distinct proxies with their own owner lease (factory, ctx, host, client), their own `release` and their
    own observers. Gone, re-acquire (entry 6) and ending by a final error belong to the binding.
  - Relays stay 1:1 per origin hold. The browser's binding already collapses its components into one relayed hold.
    Different principals and different hosts (two tabs) stay separate.
- **Wire.** A hold implies a subscription to the state members of its variant. The provider sends the shape and the
  first snapshots as one unit: a new link protocol version (entry 1). No `sub` frames in the normal case; `sub` and
  `unsub` remain only for the opt-out.
  - `undefined` is sent as an explicit snapshot, so it hydrates.
  - The first snapshots of a binding that is not yet ready go past the ack window: a get does not wait behind other
    bindings' slots. Call results keep their priority.
  - A per-connection cap bounds pending state. Beyond it, the oldest slots are replaced by resets.
  - The diff is computed once per change (as today); encoding and serialization stay once per feed (stateful
    per-subscription encoders).
- **Opt-out.** `get(…, { state: false })` for method-only views: the workspace panel's `Chat`, TUI commands. Such a view
  is ready once live. The binding subscribes if any of its views wants state.
- **Variants.** A shape change is applied only once every new state member has its snapshot. A member that is not in
  the current variant throws `not_in_variant`. References are typed as a union discriminated by `variant` (entry 1):
  another variant's members are not accessible without narrowing.
- **Status.** State members are typed `T`. `not_ready` is thrown only before a binding's first hydration. While the
  binding re-acquires (entry 6) the last values stay readable with status `loading`. Reading an ended view throws.
  Opaque members of a live local object are typed without `undefined` the same way.
- **Linger.** A consumer-side linger on the binding replaces `linger.ts` and its `keep`: a per-type option and a
  per-host cap (p2: 2 min, at most 4). The provider-side `linger` (`record.ts:1234`) stays.
- **UI.** `useObject` (`web.tsx:140`) and the TUI `watch` (`tui.ts:84`) keep a synchronous internal hold (`host.hold()`)
  and render loading from status. `useReadable` (`web.tsx:201`) gates on status, so nothing throws during render.
- **Startup and cycles.** Worker code must not await state-bearing remote references before `control.ready()`
  (`src/hosts/worker.ts:61-88`). Today's worker-to-server references are caller-only (`SessionStatus` and `Subagents`
  `reporter`). Activation and reload prepare get a ready deadline that fails with a cycle hint instead of hanging
  (cross-host cycles are not detected, `host.ts:1000`).
- **Cost.** A reference held only for calls receives no state when it uses the opt-out. Objects held by several
  components (`Access` 7×, `Sessions` 6×, `Subagents` 3×, `Chat` 2×) cost one copy per client.

**Touches.** Chord: `remote.ts` (binding, views), `host.ts` (key, async `get`, `hold`), `connection.ts` and `wire.ts`
(hold with state, shape plus snapshots, explicit `undefined`, first-snapshot priority, per-connection cap, protocol
version), `record.ts` (hydrated readiness, forwarded state, deadline, `get` in `SelfImpl` and `CtxImpl`), `contract.ts`
(typing). p2: `linger.ts` (removed), `useObject`/`useReadable`/`useStatus` in `web.tsx`, `watch` in `tui.ts`, every
`.value!` and `await ref.ready` in plugins.

**Tests** (a counting link, frames and bytes per direction: the `AckGate` fixture in
`packages/chord/test/old/flow.test.ts`; faux timers):

- **Traffic.** N views (factory, `ctx.get`, `host.get`, hook) on one key give one hold, one first snapshot per member
  and one delta frame per change. Releasing N−1 views sends nothing. Releasing the last sends `release` after the
  linger, not before. A new view within the linger sends nothing. Hooks mounting and unmounting send no frames.
- **Identity.** One binding for normalized-equal inputs and equal principal keys. Separate bindings for different
  principals, grant revisions and fingerprints. Two fingerprints during a reload, one after retire.
- **Readiness matrix.** Local state, forwarded remote state, derivations over remote state, `null`, empty and
  `undefined` values, state-free variants. A failed snapshot (validation error) rejects the get instead of hanging.
- **Variants.** On a variant or contract change at reload, no moment exists where the view is live and a member read
  throws. A removed member throws `not_in_variant`. New members arrive with the shape.
- **Awaiting.** Abort, ctx close and the deadline (link down) release that view only. The binding survives for other
  waiters. The root ends, so a reload gate drains.
- **Re-acquire and reconnect.** Exactly one snapshot per (binding, member). Frames from the old incarnation are
  ignored and no subscriptions are duplicated. A view that joins during a re-acquire waits for the fresh snapshot. The
  last values stay readable meanwhile.
- **Opt-out.** A `state: false` view alone transfers no state. When a full view joins, the subscription starts once.
  The final release unsubscribes.
- **Relay topology.** One origin hold gives one downstream hold and one feed per member, with nothing left after
  release, link close or revoke. Two tabs, different principals. A stalled tab overflows and resets while another tab
  keeps getting deltas.
- **Flow and load.**
  - Delayed acks with three 500 KiB snapshots queued: a new get of a small object resolves after about one round trip,
    and call results are not delayed.
  - A chat snapshot larger than the window.
  - IPC (no sizes) between a worker and the server.
  - A stalled peer with K subscriptions stays under the per-connection cap, then gets one reset per feed.
  - Many clients on one object: server memory per client is bounded.
- **Provider cost.** One diff per change and K encodes for K feeds (spy on `encoder()`), and the deflates per snapshot.
- **Startup and cycles.** A worker with `awaitEager: false` and eager objects holding server objects goes live after
  `control.ready()`, with one snapshot each. A cross-host hold cycle fails at the deadline with a cycle hint.
- **Types.** Another variant's member is not accessible without narrowing. A local `self.get` member is typed `T`,
  reads without `!` once live, and throws `not_ready` inside the factory.

## 9. State initialized from its source before the object goes live (batch)

**Today.** Stores load their state in a task: `self.tasks({ load: async (ctx) => state.replace(ctx, db.all()) })`
(catalog, subagents, ports, sharing). Tasks start once the object is live, so calls and watchers can see the initial
value (`[]`) first: watchers converge, but a method reading the state in that window answers wrong (a note that exists
reads as unknown), and an asynchronous load (Durable) can overwrite a write made during its `await` with a stale
snapshot. The chat-mode mirror works around this with a reread loop.

**Change.** `self.state(name, schema, initial | { init })`: `init` (may be async) runs after the object's resources
are open and before it goes live, so no call or watcher sees a value that is not from the source. On reload `init` does
not run (the state survives). The `load` tasks go away. Superseded by target-design §7: every cell has `init` (no fixed initial
value); on a bump, a pure `migrate` converts the old value to the new schema and `init({ previous })` gets the result.

## 10. `lifetime: "host"` checked by the type system

`serve(Type, factory, { lifetime: "host" })` compiles only if `Type` is local and its input has no required fields (no
new method). Today Chord checks this at runtime (`invalid`).

## 11. The facet is an implicit host-lifetime object

**Today.** A facet's setup (`defineFacet((host) => …)`) serves types and reads registries, but cannot register, hold
references, state or resources. Contributions need a dummy host-lifetime object (`contribute(host, name, self => …)`,
47 in p2), and sharing a native thing within a plugin needs an object type with an `opaque` member and `expose`
(`TerminalServiceObject`, `DeviceAccess`, radius, codemode).

**Change.** `defineFacet((host, self) => { … })`: the facet's setup is the factory of an anonymous object with lifetime
`"host"` that nobody else can reach.

- It declares state, resources, effects and registrations directly, and serves the plugin's types.
- Objects of the plugin's types share the facet's declarations through the closure: no extra type, no `expose`, no
  `opaque` within a plugin. Between plugins: contracts and registries only.
- Registering is allowed from the facet object and from explicit host-lifetime objects; never from referenced objects
  (their entries would come and go with references).
- The setup follows the factory rules: it only declares, runs again on every reload (first as a trial), its local
  variables reset; whatever must survive is `self.state`.
- Behaviour built on a shared native thing is an effect (restarted with the new code). A kept resource built on a facet
  resource names it in `deps` (allowed across the facet object and its plugin's objects); replacing the facet resource
  replaces it in every object of the facet.
- `contribute` and the dummy types go away.

## 12. The effect model

| Survives a reload? | Declaration |
| --- | --- |
| yes, data | `self.state(name, schema, initial \| { init }, { version?, migrate? })` |
| yes, a native value (DB handle, SSH connection, sandbox, terminal host) | `self.resource(name, { version, deps? }, open, close)`: always named and versioned, holds only the native value, no behaviour |
| no | `self.effect(setup)`: `setup({ signal, run })` starts behaviour and returns its cleanup; restarted with the new code on every reload (the old one stops first) |
| no, computed | `self.derive(sources, fn)` |

- `run(fn)` starts a call tree with a `ctx` per event, so a handler can write state and call other objects.
- Listeners, tasks and timers are effects; `onEvents(source, handler)`, `every(ms, fn)`, `loop(fn)` are plain helper
  functions returning an effect setup, not Chord concepts.
- Gone: `self.on` (names, `select`, source-text matching, kept subscriptions), `self.task`, unnamed resources.
- Rule: resources hold only native values; behaviour goes into effects. Stale code is only possible in kept resources.
- Needs shared Durable sources in the base (one watch per conversation, fanned out), since Durable watches allow one
  subscriber and effects resubscribe.

## 13. Versioned registries

Registries get versions and adapters like contracts, without a structural check (entries are code and native objects,
not data).

```ts
export const Routes = defineRegistry<RouteHandlerV2>("p2.routes", {
  version: 2,
  adapters: { 1: (old: RouteHandlerV1): RouteHandlerV2 => (req, res, access, ctx) => old(req, res, toV1(access), ctx) },
});
```

- The definition lives in the owner's versioned contract package (p2's or a plugin's: `SendRouters`,
  `TranscriptEntries`, `SessionArchived`); a plugin's registration carries the version it was written against.
- At registration: same version → accepted; older with an adapter → wrapped; otherwise refused at load with a clear
  error (also for a registry name the host doesn't have). No silent dead entries.
- No automatic coverage check: the owner bumps the version for breaking changes and writes the adapter.

## Open (not decided)

Discussed in the walkthrough, not decided; each needs a decision before it is built.

- **Native values from the host for facets:** host values (plain, ready before any facet) instead of runtime objects
  with `opaque` members (`Harness`, `WorkerProcess`, `Server`, `HostLifecycle`); no `expose`/`opaque` for plugins
  across plugins; the harness opens without plugin waits. Natives can't be adapted, so the native surface stays minimal.
- **Viewer counting and presence:** today enter/leave resources (sharing presence, status viewers, login abandon, worker
  liveness viewers). Proposed: stores count per-lease tokens (`enter` returns a token, `leave(token)`), so reload order
  does not matter. Dynamic registries were rejected (a hack).
- **Removing the gate:** a changed state version or kept resource restarts the object instead of migrating under a gate.

## Tracked, not scheduled

Work found along the way, parked until the object-state redesign (`target-design.md`) is decided. Do not lose.

- **Leaks** (`plugin-loading.md` 14.4): C3 still open in Chord (`object.ts` `stageListeners`: a kept listener
  subscription keeps the previous run's `select`; fix: adopt `decl.select` on the kept path). C5 (p2
  `PluginRuntime.guard` adds a listener per reload) and C7 (Harness `execution` keeps the envs facet's `close`) open.
  C6 belongs to loader D. C1, C2, C4 fixed in `00d8d0495`; C10 gone with entry 8. Rerun the generation-GC tests after
  the redesign.
- **p2 behaviour on interrupted calls** (fence-impact assessment): Chat shell sampling timer writes a cell from a bare
  `setTimeout` (an error there exits the worker); `admitted` shell dedupe lives in a factory closure (lost on reload);
  `stop`/`dequeue`/`claim` return withdrawn text only in the reply (lost if the reply is lost); web Send does nothing
  while disconnected (TUI queues); new session plus send and review comments have no request id (duplicates on retry);
  terminal keystrokes are dropped while disconnected; sharing revocation loop and `relocate`/`clone` are multi-step.
- **Durable:** nested commits hang by convention only (documented, not detected); `AsyncLocalStorage` would be needed
  to detect it. No change planned.
- **#10959** (remote references accept a foreign ctx): the owner fixes it with a subagent.

