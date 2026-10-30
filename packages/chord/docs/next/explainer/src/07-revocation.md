
# Taking Access Away {#revocation lede="Revocation: how removing a guest ends their objects on every host at once, and why reconnecting does not bring access back."}

The owner removes Ann from S1. Her tab still has a WebSocket open and a `Notes { S1 }` view on worker S1. Both must end
now, on the server and on the worker, and her tab's automatic reconnect must not restore anything. Chord provides the
mechanism; the app decides who is blocked and remembers it.

## Labels, not predicates

The app declares, once, which **revocation labels** each principal carries. Revoking means revoking one label;
everything carrying it is hit.

```ts
// studio/src/principal.ts
export type Revocation = { grant: string } | { device: string } | { session: string };

export const revokedBy = (p: P): Revocation[] =>
  p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }]
  : p.kind === "owner" && p.access === "device" && p.device ? [{ device: p.device }]
  : [];

const server = createHost<P, Revocation>({ address: Server(), principal: { kind: "server" }, revokedBy });
// every worker is created with the same revokedBy
```

| Principal | Labels |
| --- | --- |
| guest Ann (grant g1) in S1 | `{ grant: "g1" }`, `{ session: "S1" }` |
| guest Bob (grant g2) in S1 | `{ grant: "g2" }`, `{ session: "S1" }` |
| owner on the paired phone | `{ device: "phone" }` |
| owner, local | none |

| Call | Hits |
| --- | --- |
| `server.revoke({ grant: "g1" })`: remove Ann | Ann |
| `server.revoke({ session: "S1" })`: archive S1 | Ann and Bob |
| `server.revoke({ device: "phone" })`: sign out the phone | the phone |

A label is plain data because revocation is an event that must travel from the server to the workers; a predicate
function could not be sent.

## What `revoke` does

`host.revoke(r)` ends every object and closes every link whose principal `p` has `r` in `revokedBy(p)` (compared by
canonical JSON; never the host's own principal), and passes `r` to its children, which apply their own `revokedBy`.

:::sequence animate | Removing guest Ann. The label travels down; her objects end on every host; her reconnect is refused by the app's own record.
actor owner "owner tab"
actor server "server" accent
actor worker "worker S1" blue
actor ann "Ann's tab" "guest g1" muted
owner -> server: Sharing.remove({ grant: "g1" })
server -> server: app: mark g1 blocked (document)
server => server: revoke({ grant: "g1" })
server -> ann: close link
server => worker: revoke { grant: "g1" }
worker -> worker: end Notes { S1 } as g1
ann -> server: reconnect
server -> server: authenticate: g1 blocked
server --> ann: refused (4401)
:::

On worker S1, for `revoke({ grant: "g1" })`:

| Object | Principal | Hit |
| --- | --- | --- |
| `Notes { S1 }` | owner, local | no |
| `Notes { S1 }` | guest g1 | **yes**: ends |
| `Notes { S1 }` | guest g2 | no |
| `NoteStore { S1 }` | none (local) | no |

Ending Ann's view releases its reference to the store, which keeps serving the others.

## Chord persists nothing here

`revoke` cuts live access only. Lasting denial lives in the app's data (the sharing plugin's guest records), which
`authenticate` checks on every new connection. After a server restart nothing live exists to revoke; every client
authenticates again and blocked grants are refused there.

**No re-stamping.** A changed grant (Ann moves from read to write) is a revocation of the old grant. Her link closes,
her tab reconnects and authenticates with the new grant revision, which gives a new principal key, and her references
re-hold by themselves, now as an editor. Reconnecting never restores revoked authority.

**Revocation beats jobs** (R11). Normally a running job keeps its object alive after the last reference is released
(a closed tab does not abort an import). Revoking a principal ends its objects at once regardless; their jobs get the
abort signal and the normal close timeout.

## Work in shared stores

Revocation ends objects whose principal carries the label. A shared store has no principal, so work it runs *on
behalf of* someone (a question waiting for Ann's answer, a shell command a guest started) is not ended by `revoke`.
Such a store keeps the grant as data with the work and reconciles from the grant owner's live state with a routine
(chapter X):

```ts
// in a shared store that runs work for guests
const sharing = self.get(Grants, {});                              // the sharing plugin's live grants
self.routines.on(sharing.live, async (live, ctx) => {
  for (const run of shell.running.value)
    if (run.args.grant && !live[run.args.grant]) shell.abort(run.id);   // idempotent
});
```

There is no revocation hook: a hook can be missed (a crash between revoke and hook), a routine over current state
cannot. The window between the revocation and the routine's run is accepted (R10); a step started in it still runs.

## Who does what

| Chord | The app |
| --- | --- |
| stamps principals on links | what a grant is; share links, cookies, `authenticate` |
| keeps one object per principal key | defines `Revocation` and `revokedBy` |
| on `revoke(r)`: ends matching objects and links, passes `r` down | decides when to revoke; stores who is blocked |
