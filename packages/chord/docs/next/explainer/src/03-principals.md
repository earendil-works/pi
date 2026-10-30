
# Who Is Calling {#principals lede="Principals: how Chord knows who calls, why a caller cannot lie about it, and how the answer picks the object and its members."}

The owner may add and remove notes. Ann, a read-only guest, may only read them and should not even see who wrote
what. The object must therefore know who is calling, and the caller must not be able to claim to be someone else. In
Chord the answer is a **principal**, a small JSON value the app defines and the links stamp.

## The app's principal type

Chord defines no principal kinds; the app does. Every variant has a `kind`. Studio uses p2's set:

```ts
// studio/src/principal.ts
export type P =
  | { kind: "owner"; access: "local" | "relay" | "device"; device?: string }
  | { kind: "guest"; session: string; mode: "read" | "write"; grant: string; revision: number }
  | { kind: "server" }
  | { kind: "worker"; session: string };
```

| `kind` | Who |
| --- | --- |
| `owner` | the person running the app, on loopback, through the relay, or on a paired device |
| `guest` | someone invited into one session, with a mode and the grant (and its revision) that let them in |
| `server` | the server's own code calling a worker |
| `worker` | a session worker calling the server |

## Links stamp principals

A principal never comes from a request's data. The server authenticates a client once, when its WebSocket connects,
and stamps the result on the whole link (`server.accept(link, { principal })`). The server tells Chord who each worker
is when it resolves it (`return { link, principal }`). When the server relays a client's request to a worker, Chord
writes the client's principal into the forwarded request; a principal field coming from a client is always
overwritten, and only a trusted parent link may carry one.

Where principals come from is app code. Studio's sharing feature creates a share link per session and mode; a guest
who opens it gets a guest record (grant `g1`) and a cookie; `authenticate(req)` turns the cookie into
`{ kind: "guest", session: "S1", mode: "read", grant: "g1", revision: 1 }` on every new connection. Chord never sees
cookies or grants, only the finished principal.

## The caller is part of the identity

A `remote` object exists once per **(type, input, principal key)**. The **principal key** is a string computed from
the principal; by default its canonical JSON (sorted keys). The app may pass its own `principalKey` to `createHost`,
and must pass the same function on every host, or identities split silently.

```ts
const principalKey = (p: P) =>
  p.kind === "owner" ? `owner:${p.access}:${p.device ?? ""}`
  : p.kind === "guest" ? `guest:${p.grant}:r${p.revision}`
  : p.kind === "worker" ? `worker:${p.session}`
  : p.kind;
```

The design wants the key to include how the client is connected and the grant's revision, so that two access paths
never share objects and a changed grant never reuses the old grant's object:

| Caller | Principal key | `Notes { S1 }` object |
| --- | --- | --- |
| owner, tab A, local | `owner:local:` | 1 |
| owner, tab B, local | `owner:local:` | 1 (shared with tab A) |
| owner through the relay | `owner:relay:` | 2 |
| guest g1, revision 1 | `guest:g1:r1` | 3 |
| guest g1 after a change to write mode, revision 2 | `guest:g1:r2` | 4 (new) |

## Variants

The contract lists named sets of members; the factory receives the principal and returns the variant that principal
may use:

```ts
// notes/contract.ts (version 1, final form for now)
variants: {
  editor: {
    state: { notes: obj({ items: arr(Note) }) },
    methods: { add: method(obj({ text: str({ min: 1, max: 2000 }) }), str()), remove: method(obj({ id: str() })) },
  },
  reader: {
    state: { notes: obj({ items: arr(PublicNote) }) },     // no `by`: authors are hidden
  },
},
```

```ts
// notes/worker.ts
host.serve(Notes, ({ session }, principal, self) => {
  if (canWrite(principal, session)) return { variant: "editor", notes: …, add: …, remove: … };
  return { variant: "reader", notes: … };
});
```

A reader has no `add` at all. Chord refuses a call to a member that is not in the caller's variant, so `add` needs no
check of its own. Three rules keep variants compatible: a member name has the same kind (state or method) in every
variant that has it; a method has the same arguments and result in every variant; only state schemas may differ per
variant (the reader's notes have no authors). `remote(...)` enforces them at the type level, and at runtime for
contracts that arrive as data.

## How a facet knows `P`

`P` is Studio's type, not Chord's, and every host is created with it (`createHost<P>`). A plugin's facets are written
and compiled separately, then handed to `host.load` as values, so the type checker cannot infer `P` from the host into
the factory's `principal`. Studio's base code therefore exports its own `defineFacet`, already bound to `P`, and every
facet of every plugin imports that one instead of Chord's:

```ts
// studio/src/facet.ts (base code, exported as @studio/core)
import { bindFacet } from "@earendil-works/chord/next";
import type { P } from "./principal.ts";

export const defineFacet = bindFacet<P>();         // a facet's principals are Studio's P
export type { P, Revocation } from "./principal.ts";
```

```ts
// notes/worker.ts (server.ts, web.tsx and tui.ts import the same defineFacet)
import { defineFacet } from "@studio/core";

export default defineFacet((host, self) => {
  host.serve(Notes, ({ session }, principal, self) => {   // principal: P
    if (principal.kind === "guest" && principal.mode === "read") return { variant: "reader", notes: … };
    …
  });
});
```

The import is cheap: `@studio/core` is a host package plugins already import at runtime (the contract imports `Session`
from it), `P` is a type-only import, and `bindFacet` is a one-line function. The host checks the pairing: `load`
accepts only facets typed for its own `P`, so a facet compiled against another app's principal type, or one built with
Chord's untyped `defineFacet`, does not compile into Studio's start code. Client facets (`web.tsx`, `tui.ts`) use the
same `defineFacet`; they rarely see a principal, because clients serve only `local` types.

None of this is checked at runtime, and none of it needs to be: the principal a factory receives is the one the link
stamped.

:::review | Review: binding facets to the app's principal type (open)
The design shows `defineFacet((host, self) => …)` without saying how `P` reaches the factory. The frozen kernel takes
it as an explicit type parameter, `defineFacet<P>(…)`, defaulting to `{ kind: string }`
(`packages/chord/src/next/facet.ts`), and the playground writes `defineFacet<AppPrincipal>(…)`. The pre-bound
`defineFacet` above (`bindFacet` is a working name) is the owner's preferred direction, recorded as an open point in
`packages/chord/docs/next/layer-1.md` §4.
:::

## Narrowing on the caller's side

Owner and guest run the same `web.tsx`, and which variant they get is known only at runtime. The types force every
caller to narrow before using variant members:

```ts
const notes = await client.get(Notes, { session: "S1" });
notes.add({ text: "hi" });                         // type error: `add` exists only in "editor"
if (inVariant(notes, "editor")) await notes.add({ text: "hi" });
expectVariant(notes, "editor");                    // or assert (throws)
function Editor({ notes }: { notes: RefIn<typeof Notes, "editor"> }) { … }
```

The protection is not the type checker; it is Chord refusing the call at the provider. A client that ignores the
types gets the same error.

## Admission before a worker starts

Principals also decide whether a caller may reach a host at all. `route(Session, { authorize })` runs before Chord
resolves an address, so a guest of S1 asking for anything in S2 is refused at the server, and no worker starts for
them. Finer authority lives in the per-principal view's methods; there is no asynchronous "may this caller activate
this object" guard. An object whose address carries authority (say, a login flow by id) may exist; what a caller can
see and do is decided by the variant its factory picks.

## Inside methods

`ctx.principal` is the caller of the current call. In Studio's notes the editor's `add` uses it to record the
author:

```ts
add: ({ text }, ctx) => store.add({ text, by: authorOf(ctx.principal) }, ctx),
```

Where principals act, in summary:

| Purpose | Where |
| --- | --- |
| identity: which object a caller gets | principal key |
| variant: which members | the factory |
| admission: whether a host is reachable | `route.authorize` |
| attribution and fine checks | `ctx.principal` in methods |
| revocation | `revokedBy` (chapter VII) |

## The bug from chapter II

Now the bug is visible. The owner's `Notes { S1 }` and Ann's `Notes { S1 }` are two objects (rows 1 and 3 above), and
each declared its own `NoteList`. The owner's notes are not in Ann's list. Per-caller objects must not hold the data;
they must be views over something that exists once. That is the next chapter.
