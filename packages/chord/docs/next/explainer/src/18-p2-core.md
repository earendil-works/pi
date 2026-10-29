
# Building p2: the Core {#p2-core lede="From a list of what the app must do to a set of owners: the base code every p3 plugin builds on."}

The notes plugin used every Chord concept. A real app is the same concepts many times over. This chapter and the
next two assemble **p3**, the Chord v2 version of p2, from the parts the guide introduced. p3 is built next to p2 in
`apps/p3`, fully isolated with its own data directory, and **without migrating p2's data** (no import of
`catalog.sqlite`, `shares.sqlite` or the subagents table). Its plugins are derived from what the app must do, not
ported one to one from p2's plugin layout.

:::review | Review: p3 is not designed yet
The design fixes the rules (`design.md` §25) and lists the p3 decisions still open (#17, #18, #20 to #23); the
per-domain design of p3 has not started. What these three chapters show is one construction that follows the rules,
derived from the functionality map in `apps/p2/docs/p3-functions/`. Object names are working names. Where a domain
has an open decision, the text says which.
:::

## Start from functions, not from plugins

The functionality map in `apps/p2/docs/p3-functions/` lists what p2 does, in plain words, with four facts per
function: the data and its size, how durable it is, who may see or do it, and where it must be available. It groups
the functions into 22 domains:

| # | Domain | # | Domain |
| --- | --- | --- | --- |
| 1 | sessions | 12 | access |
| 2 | session workers | 13 | models, credentials, settings |
| 3 | conversations and agent | 14 | prompt resources |
| 4 | shell commands | 15 | status and presence |
| 5 | chat mode | 16 | search |
| 6 | agents (subagents, one-shots, peer messages) | 17 | remote access and forwards |
| 7 | code mode | 18 | logs and notices |
| 8 | session files | 19 | dev and reload |
| 9 | environments and execution | 20 | web shell |
| 10 | workspace | 21 | TUI shell |
| 11 | terminals | 22 | transport |

The four facts answer the four questions every Chord object needs, in order:

:::flow wide animate | From a function in the map to code. Each fact in the map answers one question Chord needs answered.
row "The map says"
box data "data" "what, how big"
box dur "durability" "ephemeral · until restart · persisted · transcript-bound"
box who "who" "owner · guest read · guest write · worker"
box where "where" "server · worker · web · TUI · environment"
row "Chord needs" accent
box owner "the owner" "smallest object it belongs to" accent
box store "where it is kept" "Durable, persisted or in-memory document, tab"
box variant "variants" "and revocation" blue
box host "host and code" "placement; core or plugin"
arrow data -> owner
arrow dur -> store
arrow who -> variant
arrow where -> host
note "Durability decides storage: transcript-bound data is Durable's; persisted app data is a persisted document with a stable identity; until-restart data is an in-memory document or a native; tab-scoped UI state stays in the client."
:::

**One owner per thing, the smallest object it belongs to.** A guest's grant belongs to the access owner, not to the
session; a draft belongs to one (conversation, author) pair, not to the chat plugin as a whole. Ownership nests, and
rules set at creation are written in the creating commit (Durable's `createConversation({ init })`).

**Core or plugin.** Core owners are what the app always needs and everything builds on; they are always present, so
other code may depend on them directly. Plugin owners may be missing; anything that depends on an optional feature
does so through a registry it owns itself (chapter XIII). The risk to avoid is a **core god object**: each core owner
owns only what belongs to it.

## The ownership map

The result of that procedure for p3, as a starting point:

| Domain | Owner object(s) | Host | Code |
| --- | --- | --- | --- |
| access | `Access` (grants, devices, share links), `authenticate` | server | core |
| sessions | `Catalog` (session records), lifecycle jobs | server | core |
| session workers | the supervisor (`route(Session)` + idle stop) | server | core (app code) |
| session location | `SessionLocation { session }` | worker | core |
| conversations and agent | `Harness`, `ConversationStore`, `Conversation` views | worker | core |
| status and presence | `SessionStatus` (server copy), reporters on workers | both | core |
| shell commands | `ShellJob` in the chat plugin | worker | plugin |
| chat mode | chat plugin | worker | plugin |
| agents | subagents plugin (Durable child conversations) | worker | plugin |
| code mode | code mode plugin (sandbox native) | worker | plugin |
| session files | `SessionFiles { session }` (proposed, #17) | server | core or plugin, open |
| environments | envs plugin (config, SSH pools #20) | server and worker | plugin |
| workspace | workspace plugin | worker | plugin |
| terminals | terminal host process (#23), terminals plugin | separate process | plugin |
| models, credentials | models plugin, login job + flow | server | plugin |
| settings | `Settings` (single writer, #21) | server | core |
| prompt resources | prompt plugin (watchers in the session's environment) | worker | plugin |
| search | search plugin (index on the server, feed on workers) | both | plugin |
| remote access, forwards | radius plugin, ports plugin | server | plugin |
| logs and notices | `Notices` (one channel), log capture | server | core |
| dev and reload | the reload control, `reload_plugins` tool | server | plugin |
| web and TUI shells | UI facets over the objects above | clients | shells |

The rest of this chapter builds the core rows. Chapters XIX and XX build the plugins.

## The base code

```text
apps/p3/
  src/
    hosts.ts           Server, Session host kinds
    principal.ts       P, Revocation, principalKey, revokedBy, can()
    server/main.ts     createHost, load, route(Session), WebSocket and Radius entry points, supervisor
    worker/main.ts     createHost with the start data, connect to the parent
    core/              the core facets: Access, Catalog, SessionStatus, Settings, Notices (server);
                       SessionInfo, SessionLocation, Harness, ConversationStore (worker)
  plugins/             chat, subagents, codemode, envs, workspace, terminals, models, login,
                       prompt, search, ports, radius, files, dev
```

`hosts.ts`, `principal.ts`, the `SessionInfo` start data and the `Harness` object are the ones the guide already
built for Studio (chapters I, III, IX and XIV). Base code restarts the hosts when it changes; everything in
`plugins/` reloads.

## Who is calling: authentication

Chord stamps principals; the app produces them. p3's server has four ways in, each turned into a principal by
`authenticate(req)` when a WebSocket connects (chapter III):

| Way in | Principal |
| --- | --- |
| loopback without a cookie (TUI, CLI, first page load) | `{ kind: "owner", access: "local" }` |
| loopback owner browser cookie (a per-port secret file) | `{ kind: "owner", access: "local" }` |
| a device cookie (HMAC-signed, per port, 30 days), obtained with a one-time sign-in token | `{ kind: "owner", access: "device", device }` |
| a guest cookie from a share link | `{ kind: "guest", session, mode, grant, revision }` |
| the Radius relay channel | `{ kind: "owner", access: "relay" }` |

The checks that are not Chord's stay in this function: origin checks and Fetch Metadata (a browser request from
another site gets no principal, except a top-level navigation), proxy trust, the sign-in token rules (10 minutes,
single use, at most 32 outstanding, memory only), cookie expiry and revocation lists. A failed check closes the socket
before Chord sees it.

**One permission matrix.** Every function in the map names who may use it, and p2 checks those rules in several
places. p3 writes them once, in `principal.ts`, and every factory and `authorize` uses it:

```ts
// src/principal.ts
type Action = "read" | "send" | "upload" | "stop" | "workspace" | "terminal" | "manage";

export function can(p: P, action: Action, session?: string): boolean {
  if (p.kind === "owner" || p.kind === "server") return true;
  if (p.kind === "worker") return action !== "manage" && p.session === session;
  if (p.kind !== "guest" || p.session !== session) return false;
  if (action === "terminal" || action === "manage") return false;     // terminals: owner only
  if (p.mode === "read") return action === "read";                     // no workspace for guest read
  return true;                                                         // guest write: send, upload, stop, workspace
}
```

Factories pick variants from it (`can(p, "send", session) ? "writer" : "reader"`), so the matrix is visible in one
file and the members a caller lacks are simply not there.

## Access: grants, devices, share links

`Access` is the core owner of everything that lets someone in: share links per session and mode, guest records, the
device list and the signing key. It lives on the server as the chapter IV pattern: a `local` store that persists the
documents (only stable identities may), and a `remote` view for the owner's settings screen:

```ts
// src/core/access.ts (server, in the core server facet)
const Links = defineState("access.links", { schema: map(ShareLink), version: 1, persist: true,
  initial: () => ({}), checkpointWhen: (_v, _o, info) => info.deltasSinceBase > 64 });
const Guests = defineState("access.guests", { … });         // same shape: map(Guest), persisted
const Devices = defineState("access.devices", { … });       // map(Device), persisted

host.serve(AccessStore, (_input, self) => {                 // local: may persist, acts for the host
  const links = self.state(Links), guests = self.state(Guests), devices = self.state(Devices);
  return {
    links, guests, devices,
    removeGuest: async ({ grant }, ctx) => {
      await self.tx(async (tx) => { (await tx.draft(guests))[grant].blocked = true; }, ctx);
      host.revoke({ grant });                                 // live access ends now
    },
    resetLink: async ({ session, mode }, ctx) => {
      const blocked = await self.tx((tx) => rotateLink(tx, links, guests, session, mode), ctx);
      for (const grant of blocked) host.revoke({ grant });
    },
    signOut: async ({ device }, ctx) => {
      await self.tx(async (tx) => { (await tx.draft(devices))[device].revoked = true; }, ctx);
      host.revoke({ device });
    },
    …                                                         // shareLink, join, signOutAll
  };
});

host.serve(Access, (_input, principal, self) => {           // remote view: owner only
  if (!can(principal, "manage")) throw forbidden();
  const store = self.get(AccessStore, {});
  return {
    variant: "owner",
    guests: self.derive("guests", [store.guests], ([g]) => publicGuests(g)),   // names, modes; no tokens
    removeGuest: (args, ctx) => store.removeGuest(args, ctx),
    resetLink: (args, ctx) => store.resetLink(args, ctx),
    signOut: (args, ctx) => store.signOut(args, ctx),
  };
});
```

`authenticate` is base code on the same host and checks `AccessStore`'s current documents on every new connection
(it holds a reference to the store, taken with `server.root` at start). Live access and lasting denial stay separate, as chapter VII explained:

| Event | Lasting effect (data) | Live effect |
| --- | --- | --- |
| remove a guest | guest record blocked | `revoke({ grant })` |
| reset a share link | new token; its guests' grants blocked | `revoke({ grant })` for each |
| archive a session | grants of that session void while archived | `revoke({ session })` |
| restore a session | grants valid again; revision bumped | none: guests reconnect |
| sign out a device | device revoked until its expiry | `revoke({ device })` |
| sign out all devices | signing key rotated, tokens cleared | `revoke({ device })` for each |

A guest who rejoins with the same browser keeps its identity; a removed guest cannot mint a new one, because the
block is in `Guests` and `authenticate` refuses it. Names are unverified, cleaned, at most 40 characters, unique per
session ("Ann (2)").

## The catalog

`Catalog` owns the session records: id, title (and whether it was edited), location, model default, pinned,
archived, timestamps. It lives on the server, persisted, and it **never starts a worker**: listing sessions, showing
their status or their unread marks reads server-side copies only.

```ts
export const Catalog = remote("p3.catalog", {
  version: 1,
  input: obj({}),
  placement: () => Server(),
  variants: {
    owner: {
      state: { sessions: obj({ items: arr(SessionRow) }) },
      methods: {
        create: method(CreateArgs, str()), rename: method(RenameArgs), pin: method(PinArgs),
        archive: method(obj({ id: str() })), restore: method(obj({ id: str() })),
      },
    },
    guest: { state: { sessions: obj({ items: arr(SessionRow) }) } },     // only the guest's own session, if not archived
  },
});
```

Behind it sits a persisted `local` `CatalogStore`; the guest variant is a derive over it, as in chapter IV. The lifecycle operations (archive, clone, fork,
relocate, delete) are chapter XIX; here only the rule that keeps the catalog small: **the catalog does not know which
plugins exist.** Archiving a session writes `archived: true` and revokes the session; every plugin that keeps
per-session things reconciles from `catalog.sessions` with a routine (chapter X), as the notes plugin did. The ports
plugin closes forwards of archived sessions that way, also after a crash.

## On the worker: start data, location, harness

Three core objects exist on every worker from its start:

- **`SessionInfo`** (chapter IX): the start message as `constant(init)`, with the session id, data directory and the
  location the server chose at start.
- **`SessionLocation { session }`** (working name), lifetime host: the current cwd and environment, with a location
  revision. Relocation changes it while the worker runs (chapter XIX); natives that depend on the location follow it
  with a routine and a generation (chapter IX), and conversations that follow the session's cwd are listed in the core
  per-conversation policy document.
- **`Harness`** (chapter XIV): the Durable harness for the session's store, one SQLite database per session, opened
  under an exclusive lock keyed by the real data directory and session id. It refuses to start when the saved root
  model is not configured, and resumes interrupted Durable work on start.

`ConversationStore` and the `Conversation` views in front of it are chapter XIX.

## Workers: start, keep alive, stop

Starting, supervising and stopping workers is app code (chapter I); Chord only routes and counts. p3's supervisor is
`server.route(Session, { authorize, resolve })` plus a small server object that keeps per-session worker state:

:::steps | A worker's life, as the supervisor sees it
+++ Authorize, then start
A tab gets `Notes { S1 }`. `authorize` checks `can(p, "read", "S1")` and that the session exists and is not archived
(an archived session refuses, except an index rebuild that starts the worker without resuming work). `resolve` forks
`worker/main.ts` with the start data from the catalog, bounded by a 60 s readiness timeout.
+++ A start failure sticks
If the worker fails to start (an unconfigured environment, a missing model), the error is kept per session and
every `get` fails at once with it, until the owner presses Retry. That clears the error and the related notices.
Guests see that the session is unavailable, not the error text.
+++ Counting
The core facet on the worker reports `host.activity` (`{ references, calls, jobs, lingering }`) and the harness's
running Durable task count to the supervisor object, from a routine whenever either changes. The call carries
`ctx.incarnation`, so a report from an older worker incarnation is ignored (chapter X).
+++ Idle stop
When everything has been zero for five minutes (checked every second, as in p2), the supervisor stops the worker:
the worker closes its host (routines stop, natives close, storage flushes) and exits. Durable work stays persisted
and resumes on the next start. Detached work that must keep the worker alive (a shell command whose caller left) is
a job, so it counts.
+++ Crash
If the worker exits on its own, the link drops. The supervisor records the exit code and a redacted stderr tail
(at most 4,000 characters) for that incarnation and posts one notice. References that still exist make Chord call
`resolve` again with backoff; a passive viewer recovers without a click.
+++ Shutdown
On server shutdown the supervisor stops every worker, with a forced exit after three seconds. Durable work remains
persisted.
:::

## Status without a worker

The session list shows per session whether it is running, busy (which conversations), its task count, usage and cost,
and an error. None of that may start a worker. The pattern is chapter X's pub/sub: a reporter on each worker (a
routine over the harness's state) calls `SessionStatus.report(summary)` on the server; `SessionStatus` keeps the latest
value per session and ignores calls whose `ctx.incarnation` is older than the newest it has seen; clients read
`SessionStatus`, which lives on the server. Children lists, unread marks, search index rows and artifact lists use the
same pattern (chapter XIX).

## Settings and notices

**Settings** (default model and thinking, run settings, compaction, queue modes, code mode switch, owner name) have
**one writer**: a core `Settings` object on the server owns the file, validates writes and serializes them; every
other process follows its state through a reference instead of watching and rewriting the file itself. p2 watches
settings, models and auth in every process and writes them from two, which is decision #21.

**Notices** are one channel: one core `Notices` object on the server, written by everything that fails or finishes
(worker crashes, reload results, model errors, login outcomes, grants), keeping one latest notice per source, at most
50. The owner's shell reads one list; dismissing is a method. p2 has five notice channels for the same thing.

:::review | Review: settings and file formats (#21, #22)
Single writer for settings, models and auth (#21) and versioning on-disk formats such as `envs.json` like documents
(#22) are open p3 decisions in `design.md` §26. The construction above assumes "one owner on the server, others
follow its state" for #21.
:::

:::note | Built so far
Nothing of p3 exists. The functionality map is complete (`apps/p2/docs/p3-functions/`, five area files plus the
condensed `README.md`), and the design's app rules (`design.md` §25) are decided. p3 starts after the layered rebuild
and the playground's first real proof.
:::
