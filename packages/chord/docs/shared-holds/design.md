# References sharing one wire hold

Status: design, fifth draft (2026-11-12), for review, then build. The owner's model: sharing is the consuming host's
business. A reference to a remote object this host already holds for the same caller joins that hold: no message, no
round trip; the host counts its references and releases the hold when the last one goes. Drafts 1–4 (502f79e3e …
ec1ffa15c) and two review rounds (GPT-6 Astra, GPT-6.1 Sol) are in this file's history; their findings are answered
below or listed as accepted differences (§2).

Sections cited are design.md's unless marked: §3 (holds, routes, relays, flow control), §4 (principals), §7
(references), §11 (state, watches), §19 (presence), §21 (reload), §22 (wire), §29 (telemetry), §30 (cost); the events
spec (`docs/events/spec.md`) §2.4; decisions D8, R1, Q5, "A reloaded UI part shows its loading state", "Shared work".

## 1. Problem

Every remote reference holds its object separately: N references to one object on one host cost N `hold` messages,
N snapshots (encoded at the provider, sent, parsed here), N encoders at the provider and N decoders and replicas
here, every commit encoded N times, and N bindings waiting in the provider's window (K = 2 per origin). In p2 a page
holds `p2.views` 3 times, `p2.chat` and `p2.chat-mode` twice, and the artifacts store once per Markdown pane (measured
2026-11-12); a React page normally has several components showing one object. Local references already share their
object (one `ChordObject` per identity, every `Binding` one of its holders). Remote references should too.

## 2. Decision, and what differs

A host keeps one `RemoteObject` per sharing key (§3). A reference whose key it already holds binds to that
`RemoteObject` at once: it is live at once if the object is live, with the object's replicas; nothing is sent. Each
reference keeps its own `Binding`: release, state, watches, event subscriptions, parked calls, calls. The hold is
released on the link when the last binding releases or ends; a reference made after that holds anew (no linger, D8).

Unchanged: every reference's own behaviour (states, values, calls and their order and errors at the caller, parked
calls, retries, release at the caller), the provider object's behaviour, code reloads (a restarted provider object
re-binds the one hold; every binding follows, as each followed its own hold), revocation, link drops and re-holds,
relays, the wire.

Differs (owner, 2026-11-12, accepted):

1. **Provider presence and activity count holds, not components.** `host.references` lists one entry per hold, so
   several references of one host and caller are one entry; `host.activity` counts likewise. Every user in p2 asks
   "who", not "how many components": `login` asks whether the owner still holds `ProviderLogin` (`some`), `sharing`
   maps guests by id, `status` counts viewers as a `Set` of the `viewer` param, the counter example dedupes names.
2. **A joining reference skips the provider's admission and first snapshot.** It is not authorized again at relays
   (the same caller and address passed already; withdrawing access is revocation, which ends the hold), not checked
   against a just-reloaded contract while the old attempt still serves it, and reads the replica as it is: a change
   still in transit is seen a moment later than a fresh snapshot would have shown it.
3. **Events in transit reach a joiner.** A joining reference gets the events that arrive after it joined, also one
   the provider emitted before it joined that was still on the way.
4. **Releasing one of several references aborts its running calls at the provider with `aborted`** (an `abort` per
   call), not `released` (the reason a `release` gives). The caller still gets `released`; the work is cancelled
   either way.
5. **Part limits apply to received parts.** A joiner receives no snapshot, so a value that grew past a part limit
   through deltas does not fail it with `too_large/part` as a fresh snapshot would.
6. **Shared values are identical.** `a.member.value === b.member.value` is `true` where two snapshots parsed two
   copies. Values are immutable by convention.
7. **Timing:** a joining reference is live at once (as a local reference to a live object is), where a new hold took
   a round trip and a window turn.

Telemetry is not surface.

## 3. The sharing key

One table per path (`WeakMap<Path, Map<string, RemoteObject>>`; one `Path` per path: the parent, or a route
address's path). The key is an injective tuple built with Chord's escaped key join (`joinKey`, as local identities):

```ts
key = joinKey([
	Type.name, String(Type.version), Type.fingerprint,
	params.key,                                                     // CheckedParams' identity key
	joinKey([address.kind, canonicalJson(address.params)]),         // the WireAddress the placement computed
	caller.principal === undefined ? "-" : `+${canonicalJson(caller.principal)}`,   // cached per principal object (WeakMap)
	caller.incarnation,
]);
```

- **The address** is in the key because `hostAddress` is not in the fingerprint (§3, §5): old and new code may place
  the same params at different addresses over one parent path; each must reach its own provider.
- **The caller** is in the key because a hold acts for its caller (`actingFor`, `src/remote/README.md`): a server
  handler's `ctx.get` holds for whoever called it, and two callers must not share a hold (their variants and
  `ctx.principal` at the provider differ). On a page or TUI every reference is the host's own principal. The whole
  principal is compared, not only its key: equal keys with different data stay separate.
- `joinKey` escapes every part, so no params or principal content can collide; "no principal" (`-`) and a principal
  are distinct.

Not shared:

- **`self.get` references** (activating or not): their holds carry the dependent's activation chain (Q5).
- **Relayed holds:** a relay forwards each downstream hold as its own upstream hold (R1).
- **A reference after the last release**, even in the same turn: a new hold (D8).
- **A reference that retries after `too_large/part`:** it moves into a private `RemoteObject` of its own (§4).
- **A `RemoteObject` failed broken** leaves the table (by identity): a new reference holds anew, as a new hold would
  have been checked anew.

Entries are owned: removed only by the `RemoteObject` they map to (`if (table.get(key) === this) table.delete(key)`),
when it ends (last release, `gone`, revocation, host close), fails broken, or leaves its path.

## 4. Behaviour

| Event | Shared |
| --- | --- |
| a reference with a held key | binds to the `RemoteObject`: live at once if it is live (values from its replicas), else loading or failed as it is. A binding records which members it has seen: members failed, or missing from the bound variant, when it joins are "not seen": a watch on one rejects with its error, as on a fresh failed snapshot, until a value arrives (no inherited last value) |
| a join while the path's route failed to resolve and has no link | the join tells the path a request arrived (`path.requested()`); a route treats it as an attach: it resolves again unless suspended or resolving |
| a reference releases, others remain | no `release`. Its watches and subscriptions end; its calls reject `released`: its queued calls leave the call window's queue unsent first, all of them, then its sent calls are aborted (`abort`) |
| the last reference releases | `release` sent, entry removed |
| `failed`, `loading`, `bound` (a restart, another variant), `gone`, host close, revocation | every binding is told: all retarget in one batch, then each is told (`moved()`), as a local object tells its holders; each ends exactly once |
| a call | over the shared hold from its own binding (parked per binding while loading) |
| `ref.retry()` | `retry` on the shared hold (the provider object retries for every holder, as today) |
| `too_large/part` on a part | every binding fails broken (they share the part); the object leaves the table. A `retry` from one binding moves **that binding alone** into a new private `RemoteObject`, placed anew; the others stay failed until they retry |
| link drop | one re-hold on the next link for the object |
| events | the object's nodes; each binding taps them through its own subscriptions from the counter value it bound at (§11); see §2.3 |
| telemetry | the first reference's `chord.hold` span is the hold's; it is shared work (§29): a root on the host's adapter, linked to its first trigger; a joining getter links to it while open |

## 5. What changes in the design

- **§7 References**, after "Members": "Remote references of one host share a hold (decision "References share one
  wire hold"): a reference to a remote object this host holds for the same type, version, fingerprint, params,
  address and caller binds to that hold's remote object, with no message; each keeps its own release, watches,
  subscriptions and calls; the hold ends with the last reference. Releasing one cancels its own calls (queued ones
  unsent, sent ones aborted). `self.get` references never share."
- **§3:** "Every reference is a request" gains: "a remote reference joining a held remote object (§7) is a holder of
  that object on this host; the provider sees one hold". Routes: "a reference joining a remote object on a route path
  that failed to resolve counts as a new request".
- **§19 Presence:** "a hold shared by references of one host (§7) is one entry".
- **§21** reload row for web and terminal plugins: "a remounted component's new remote reference is live at once when
  it joins a hold another component still has, as a local reference is; otherwise it loads as before".
- **decisions.md:** "A reloaded UI part shows its loading state" refined accordingly; borrowed references and leases
  stay rejected; §31: sharing a hold among references held at the same time is allowed, keeping one past the last
  release is not. New entry "References share one wire hold (owner, 2026-11-09 and 2026-11-12)": §2 with its
  differences.
- **§29:** the shared hold's span is shared work; "a remote reference's hold" becomes "a remote object's hold".
- **§30:** per binding: watches, subscriptions, calls, one key lookup; per shared object: one hold, snapshot, encoder
  at the provider, decoders and replicas here.
- **Events spec §2.4:** "a binding joining a shared remote object gets the events that arrive after it bound".
- **§22:** no change; "two holds of the same principal (two tabs) encode the same ops separately" stays.
- **`src/remote/README.md`:** `RemoteObject` one per sharing key; "two references from one host are two holds"
  becomes "references from one host with the same key are one hold; two downstream holds a relay forwards are two";
  `ConsumerSide`: cancelling one binding's calls.

## 6. Build

- `host/host.ts` `bind`: for a `path` placement without a dependent, compute the key and look it up in the path's
  table; join the `RemoteObject` found (and call `path.requested()` if it is failed waiting on an unlinked path), else
  create, attach and store it. With a dependent, as today.
- `remote/path.ts`, `host/route.ts`: `Path.requested()`; a route handles it like an attach.
- `remote/remote-object.ts`: a set of bindings; `hold` adds (a live object retargets and tells the new binding at
  once); `unhold` removes: not the last, cancels that binding's calls on the current hold; the last, `release`.
  `#move`, `lost`, `revoke`, `tooLarge`, `#end` tell every binding (retarget all in one batch, then `moved()` each).
  Table removal by identity through a callback the host gives. A retry after `too_large/part` moves the retrying
  binding into a new private `RemoteObject` (the `Target.retry` call gains the binding; an atomic transfer keeps its
  public reference, watches, subscriptions, calls and last values).
- `host/reference.ts`, `host/reference-source.ts`: a binding's seen members (a member failed or missing at the join is
  not seen until a value arrives; its watches open as on a fresh failed snapshot).
- `remote/consumer.ts`, `remote/calls.ts`: calls remember their owner (the binding); `cancelCalls(hold, owner, error)`
  takes every queued call of that owner out of the call window's queue first (rejected, unsent), then aborts its sent
  calls, so no queued call of the releasing binding leaves while slots are freed.
- `data/principal.ts`: the canonical JSON of a principal cached per principal object (a `WeakMap`).
- Telemetry per §4. No change to `ProviderSide`, relays, the window or the wire.

## 7. Tests (one file per source file, per the Chord code style)

Sharing and keys:
- Two `host.hold`s of one remote object: one `hold`, one snapshot; the second is live at once; a commit reaches both
  in one batch.
- Separate holds for a different principal (also equal key, different data), incarnation, version, fingerprint,
  params, address or path; key collisions (params with separators, backslashes, NUL; an absent principal against one
  whose canonical form is empty-like): separate.
- Two contract tokens with one name, version and fingerprint placing the same params at different addresses over the
  parent path: two holds.
- `self.get` while activating, after, and on a re-hold: never shared. Two downstream holds through a relay: two
  upstream holds.

Joining and releasing:
- A join while loading, failed transient (`retryAt`), failed waiting, live (live in the same turn); a join to a failed
  broken object makes a new hold.
- Seen members: a join to a live object with a failed member: its watch rejects with the error (no last value) until
  a value arrives; a member missing from the current variant: likewise.
- Releasing one: no `release`; the other keeps receiving. The last: one `release`. A reference after it (also in the
  same turn): a new `hold`.
- A getter timing out or aborted (before and after the first binding) releases only its own binding.
- Non-last release with a finite call window and interleaved calls (A1 sent, A2 and B1 queued): the wire carries
  `abort(A1)`, never `call(A2)`; B1 is sent. Direct and relayed, asserting exact wire messages.
- Calls through two references both answered; parked calls per reference sent in order when live.

State changes:
- Rebind to another variant: every binding moves in one batch; a member the new variant lacks fails for all.
- Provider type removed and served again; a provider reload (§21): both references follow; a version no longer
  accepted unbinds both.
- `gone` and host close: every binding ends exactly once; the entry is gone. Revocation: both end. Link drop: one
  re-hold, both live again.
- Route recovery: A on a route whose resolve failed stays held; a new `get` with the same key re-resolves; both live
  (none while suspended).
- `too_large/part`: all fail broken; a new reference C makes a new hold; `retry` from A1 moves A1 alone into a private
  hold (A2 stays failed); ending the old object, A1's and C's in any order leaves the table right.

Events, presence, telemetry, memory, cost:
- Two references subscribed to one event member each get every event once; stopping one leaves the other's.
- Presence at the provider: one entry for two references of one host and caller; two for two hosts.
- Telemetry: the shared `chord.hold` root linked to its first trigger; a joining getter's link while open; an
  untraced first getter followed by a traced joiner; the NOOP path.
- GC (`WeakRef` probes): no `RemoteObject` in the table after the last release while the path lives; a released
  binding not retained by a live sibling object; a released reference kept by the app does not retain the object; a
  dropped route path takes its table; the principal cache.
- Cost guard: two references, one hold: `chord.link.encodes` counts one encode per commit.
- An example, `test/examples/NN-shared-holds.ts`: three components holding one remote object over a link; holds and
  snapshots printed.

## 8. The window

The provider's window (K = 2 `bound`/`state` messages per origin) sends every binding waiting at a freed slot in one
`bound` message (`ProviderSide.#slotFreed`). With sharing, duplicate holds disappear; distinct holds sent together
cost at most one extra round trip (the first two `bound`s, then one with all the rest). p2's measured session switch
also chained loads (views, then each pane's artifacts hold, then its `read`); that chain is p2's to shorten. Whether
first bindings should be exempt is decided after a trace of the switch with p2's telemetry once this is built.
