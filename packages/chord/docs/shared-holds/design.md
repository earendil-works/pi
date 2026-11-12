# References sharing one wire hold

Status: design, third draft (2026-11-12): the second answered the reviews by GPT-6 Astra (adversarial, probes) and GPT-6.1 Sol
(against design.md), the third adds the goal that nothing changes on the surface (§2, §6); the first draft is
502f79e3e. Owner agreed to the change on 2026-11-09 (p3 `efficiency.md` §3:
"sounds ok") and asked for it now (2026-11-12). Sections cited: design §3 (holds, routes, flow control), §5 (event
eligibility), §7 (references), §19 (presence), §21 (reload), §22 (wire), §29 (telemetry), §30 (cost), §31 (rejected);
`src/remote/README.md`; decisions D8 (no consumer-side linger), R1 (relays), Q5 (activation chains), "A reloaded UI
part shows its loading state", "Shared work".

## 1. Problem

Every remote reference is its own `RemoteObject` with its own hold on the link (`host.bind` creates one per
`Binding`; `RemoteObject.hold(binding)` takes "its one reference"). N references to the same remote object on one host
cost N `hold` messages, N snapshots, N hold entries with N delta encoders at the provider and N decoders here, and N
holders in the provider's presence. The provider's window counts messages, not holds: waiting bindings already leave
together in one `bound` per freed slot (`ProviderSide.#slotFreed`), so duplicates cost snapshots and encoding more
than window slots.

Measured in p2 (2026-11-12, Chromium at phone size, 4x CPU, 150 ms round trip; switching back to a session with three
Markdown artifact views): the page sends about 40 holds; `p2.views` is held 3 times, `p2.chat` and `p2.chat-mode`
twice each, the artifacts store once per Markdown pane. The visible view showed at 693 ms, all panes at 966 ms; server
and worker work under 1 ms per hold. Components holding an object other components already hold is the normal shape
of a React page; its cost should not depend on how many do.

Local references already share their object: a host has one `ChordObject` per identity (type, params, principal key),
and every `Binding` is one of its holders. Remote references should behave the same.

## 2. Goal: nothing changes on the surface

Owner, 2026-11-12: "this needs to be water tight; on the surface nothing should change at all." Sharing is an
implementation of today's semantics, not a new one: every observable behaviour of a reference (its state, values,
calls, events, failures, retries, release) and every observable behaviour at the provider (`host.references`,
`host.activity`, calls, variants, revocation) is what it is with one hold per reference, up to timing that is already
nondeterministic today (a joining reference may go live sooner than a new hold would bind; a local reference to a live
object is live at once too). Telemetry is not surface: spans may differ. Where sharing would change an observable
behaviour, the design adds what keeps it (the event fence and the reference count, §6); where it cannot, it does not
share.

## 3. Decision

A host shares one `RemoteObject`, and with it one wire hold, one snapshot and one replica per member, among its
references that would send the same `hold`: same path, same type, version and fingerprint, same params, same computed
address, same caller (principal and incarnation). Each `host.get`, `host.hold`, `ctx.get` and `self.get` still returns
its own reference with its own `Binding`: its own release, state, watches, event subscriptions, parked calls and calls.
The `RemoteObject` ends, and its hold is released on the link, when its last binding releases or ends.

The address is part of the key because `hostAddress` is not in the contract fingerprint (design §3, §5): two contract tokens
of one name, version and fingerprint (old and new code during a reload, or copied contracts) may place the same params
at different addresses over the same parent path, and each such hold must reach its own provider and placement check
(`invalid/host_address`). The contract token itself is not part of the key: equal contracts bundled separately share.

Not shared:

- **`self.get` references**, activating or not: their holds carry the dependent's activation chain (Q5), and two
  dependents have two chains. They stay one `RemoteObject` each, as today, also on re-holds.
- **Relayed holds:** a relay forwards each downstream hold as its own upstream hold (R1 stays), also two downstream
  holds of one origin and caller.
- **A reference made after the last binding ended**, even in the same turn: the hold is released at once and a new one
  made. Keeping a hold past its last reference is consumer-side linger (D8, §31).
- **A reference that retries after `too_large/part`** (§5): it gets a private remote object, as its own hold today.

## 4. The sharing key

One table per path (`WeakMap<Path, Map<string, RemoteObject>>`; one `Path` per path: the parent, or a route address's
path). The key is an injective encoding of the tuple, built with Chord's existing escaped key join (`joinKey`, the one
local identities use), with an explicit tag for the principal's absence:

```ts
key = joinKey([
	Type.name, String(Type.version), Type.fingerprint,
	params.key,                                   // CheckedParams' identity key
	address.key,                                  // the Address hostAddress computed (`session|S1`), from the placement
	caller.principal === undefined ? "-" : `+${principalKey(caller.principal, context, host's principalKey)}`,
	caller.incarnation,
]);
```

- `joinKey` escapes its separator and backslash in every part, so params with any characters (NUL included) and any
  custom principal key stay distinct; "no principal" and a principal whose custom key is `""` differ by the tag.
- The caller decides on every link kind: on a route link it is what the hold's `principal`/`incarnation` fields carry
  (`actingFor`); on a parent link no fields are sent, but a worker's `ctx.get` for two callers still keeps two holds,
  so a provider serving per-principal variants is never asked once for two.
- Entries are owned: an entry is removed only by the `RemoteObject` it maps to (`if (table.get(key) === this)
  table.delete(key)`), when it ends (last release, `gone`, revocation, host close) or leaves its path (`tooLarge`
  moves it to `unplaced`).

Cost: one key string per remote reference made (its parts exist already), one map lookup; nothing per message.

## 5. Behaviour

| Event | Today (one hold per reference) | Shared |
| --- | --- | --- |
| a second reference with the same key | new `RemoteObject`, new `hold` | joins the existing `RemoteObject`; no message. Live: its binding is live in the same turn, reading the replicas. Loading or failed (any cause): it sees that state |
| a join while the path's route failed to resolve and has no link | the new reference's `attach` makes the route resolve again | the join tells the path a new request arrived (`path.requested()`): a route treats it as it treats an attach (resolve now unless suspended or resolving), so a new `get` still recovers the address; no second hold |
| a reference releases, others remain | `release` sent, the hold's calls end hold-wide | no `release`. Its watches and subscriptions end; its calls reject `released`: its queued calls leave the call queue unsent first, all of them, then its sent calls are aborted (`abort`, freeing their slots at the provider); other bindings' calls go on |
| the last reference releases | `release` sent | `release` sent, entry removed |
| `failed`, `loading`, `bound` (rebind, another variant), `gone`, host close | told to its one binding | told to every binding: all retarget in one batch, then each is told (`moved()`), as a local object tells its holders; each binding ends exactly once |
| a call | over its hold | over the shared hold, from its own binding (parked per binding while loading, as today) |
| `ref.retry()` | `retry` on its hold | `retry` on the shared hold, from any binding |
| `too_large/part` on a snapshot or state part | that reference fails broken, moves to `unplaced` | every binding of the group fails broken (they share the member); the group leaves the table. A `retry` from one binding takes **that binding alone** out into a private remote object, placed anew as its own hold (today only the retrying reference is held again); the others stay failed until they retry. A private object never rejoins or replaces a table entry; a new reference meanwhile makes a new group |
| revocation of the principal on this host | each reference ends | the group ends, every binding with it |
| link drop, re-hold on the next link | each `RemoteObject` re-holds | one re-hold for the group |
| events | per binding: the events emitted at the provider after its hold's `bound` was sent there (the provider's counter, events spec §2.4) | the same rule, kept by the event fence (§6): a joining binding gets the events the provider emitted after it learned of the join |
| presence and activity at the provider (`host.references`, `host.activity`) | one entry and one count per consumer reference | the same: the hold carries how many references share it (§6), and the provider lists and counts each |

## 6. What keeps the surface

Two behaviours depend on the provider seeing each reference; sharing keeps them with two small protocol additions.
Neither changes a message that exists.

**The event fence.** Today a binding gets the events its provider emits after the binding's `bound` was sent (events
spec §2.4: the provider's emit counter at that moment). A reference joining a group whose hold was already sent must
not get an event emitted before the provider knew of it, even one still in transit or being inflated when it joins
(Astra's trace: the provider emits E, delivery is delayed, B joins, E arrives: with its own hold B never gets E). So:

- A join to a group with event members whose hold is sent on the current link sends `mark { origin?, hold, mark }`
  (consumer to provider, a control message; `mark` a counter per hold). The joining binding gets no events until the
  matching `marked`.
- The provider, handling `mark`, takes its emit counter `c`. If its event list holds no entry for that hold with
  `n <= c` (nothing waiting for the flush), it sends `marked { origin?, hold, mark }` at once; otherwise it sends it
  right after the flush's `event` message that carries those entries. A dropped entry (full event window) is dropped
  for every binding, as today.
- Links and relays keep order per direction, and a relay forwards `marked` as it forwards `event` (at once, envelope
  only), so every event emitted before `c` arrives before `marked` and every one after arrives after it. The consumer
  starts the joining binding's eligibility at the first event entry after `marked`.
- A join before the hold is sent (no link, or the group is new in this turn) needs no fence: the hold goes out once,
  and its `bound` starts every binding's eligibility at the same provider counter, as holds sent in one flush do today.
  A re-hold after a link drop is one hold; all bindings start at its `bound`.
- Contracts without event members never send `mark`.

**The reference count.** Today the provider lists one `host.references` entry per consumer reference and counts each
in `host.activity`. A shared hold carries the count: `hold` gains `refs?` (absent: 1), and `refs { origin?, hold, n }`
(consumer to provider, control) reports a change. The provider lists the hold's entry `n` times (each is the same
tuple, as two references of one caller are today) and counts `n`. A join or a non-last release sends `refs` with the
new count (coalesced per hold within a turn: several joins in one render send one); the last release sends `release`
as today. A relay forwards `refs` and `mark` unchanged, as it forwards `retry`.

Both cost nothing on the common path of a page: one small control message per join or release of a shared group,
none for a group of one.

## 7. What changes in the design

- **§7 References**, after "Members": "Remote references share (decision "References share one wire hold"). A host
  keeps one remote object per (path, type, version, fingerprint, params, address, caller); references made with that
  key bind to it and share its hold, snapshot, replicas and state; each keeps its own release, watches, subscriptions
  and calls. Releasing one rejects its own calls (queued ones leave unsent, sent ones are aborted); the hold ends with
  the last reference. `self.get` references are never shared (their holds carry an activation chain), nor a group a
  `too_large/part` pushed out."
- **§7 event members and the events spec §2.4:** unchanged rule; add "a binding joining a shared remote object starts
  at its event fence (`marked`)".
- **§3:** "Every reference is a request" stays for the consumer (each reference is one holder of its object, the
  shared remote object); add "a remote object shared by references (§7) is one hold". "Failure and re-resolve": add
  "a reference joining a remote object on a route path that failed to resolve counts as a new request (it resolves
  again unless suspended)".
- **§19 Presence:** unchanged rule; add "a hold shared by n references (§7) is listed n times (its `refs` count)".
- **§22 Wire:** the control messages `mark`/`marked` and `refs`, and `hold.refs?` (§6); `PROTOCOL_VERSION` stays 1
  until p3 ships (§22's rule).
- **§21** "What a user sees during a reload", the web or terminal plugin row: "a remounted component's new remote
  reference is live at once when it joins a group another component still holds, as a local reference to a live
  object is; otherwise it loads as before. Nothing is kept across the last release." This is the one visible timing
  difference (§2).
- **decisions.md:** "A reloaded UI part shows its loading state" refined: it shows its loading state unless its new
  reference joins a held group; its rejected borrowed references and leases stay rejected. **§31:** sharing one wire
  hold among references held at the same time is allowed; keeping one past the last release, leases and borrowed
  references are not.
- **§29 Telemetry:** the shared hold is shared work: its `chord.hold` span is a root on the host's adapter, linked to
  its first trigger (the first reference's context), and every getter waiting on it links to it while it is open
  (decision "Shared work"); calls keep their own `chord.call` spans. The span description "a remote reference's hold"
  becomes "a remote object's hold (shared by its references)".
- **§30 Cost:** per binding: its watches, subscriptions, calls and one key lookup; per shared remote object: its
  replicas and decoders; per wire hold: the hold, snapshot and per-member encoder at the provider. §22's per-hold
  encoder and the two-tab rule stay.
- **`src/remote/README.md`:** `RemoteObject` "one per remote reference" becomes "one per sharing key (§7)"; the rule
  "two references from one host are two holds" becomes "references from one host with the same key are one hold; two
  downstream holds a relay forwards are two holds"; `ConsumerSide`: cancelling one binding's calls, `mark` and `refs` (below); `ProviderSide`: the fence and the count.
- **decisions.md** new entry "References share one wire hold (owner, 2026-11-09 and 2026-11-12)": §2 with its
  exceptions, the event fence and the reference count.

## 8. Build

- **`src/host/host.ts` `bind`:** for a `path` placement without a dependent, compute the key and look it up in the
  path's table: join the `RemoteObject` found (and, if it is failed waiting on an unlinked path, call
  `path.requested()`), else create it, attach it to the path and store it. With a dependent, as today.
- **`src/remote/path.ts` and `src/host/route.ts`:** `Path.requested()` tells its owner a request arrived without a new
  holder; a route handles it like `attached` (resolve if not linked, not suspended, not resolving).
- **`src/remote/remote-object.ts`:** a set of bindings; `hold` adds (a live object retargets and tells the new binding
  at once), `unhold` removes: not the last, cancels that binding's calls on the current hold (below); the last,
  `release` as today. `#move`, `lost`, `revoke`, `tooLarge`, `#end` tell every binding (retarget all in one batch,
  then `moved()` each). `#end` and `tooLarge` remove the table entry by identity (a callback the host gives).
  `tooLarge` marks the group private: `#place` after a retry attaches it without registering it.
- **`src/remote/consumer.ts`:** calls remember the binding that made them (an owner token passed with `call`);
  `cancelCalls(hold, owner, error)` first takes every queued call of that owner out of the call window's queue
  (rejected, unsent), then aborts its sent calls (each `abort` frees its slot), so no queued call of the releasing
  binding leaves while others are freed. Relayed calls are unaffected (relays share nothing).
- **Telemetry:** the shared hold's span as in §5 (§29); a joining getter links to the open span; nothing when bound.
- **`src/remote/consumer.ts` and `provider.ts`:** `mark`/`marked` (consumer: per hold a mark counter and, per joining
  binding, eligibility from the first entry after its `marked`; provider: the counter check against its pending event
  list, `marked` after the flush that carries older entries); `refs` (consumer: coalesced per hold per turn; provider:
  the hold's count, listed and counted `n` times in `host.references` and `host.activity`). Relays forward both.
- **`src/link/message.ts` and both codecs:** the three control messages and `hold.refs?`.
- No change to the window or to existing message kinds.

## 9. Tests (one file per source file, per the Chord code style)

Sharing and keys:
- Two `host.hold`s of one remote object: one `hold`, one snapshot; both live; a commit at the provider reaches both in
  one batch.
- Separate holds for a different principal, incarnation, version, fingerprint, params, address or path.
- Key collisions: params with NUL, separators and backslashes against principal keys built to collide; an absent
  principal against one whose custom key is `""`: separate holds.
- Two contract tokens with one name, version and fingerprint whose `hostAddress` places the same params at different
  addresses over the parent path: two holds, each reaching its own provider (a misplaced one refused there).
- `self.get` while activating, after, and on a re-hold: never shared.
- Two downstream holds of one origin and caller through a relay: two upstream holds.

Joining and releasing:
- A join while loading, failed transient (with `retryAt`), failed broken, failed waiting, and live (live in the same
  turn, values readable at once).
- Releasing one: no `release`; the other keeps receiving. Releasing the last: one `release`. A reference after it: a
  new `hold` (no linger), also in the same turn.
- A getter timing out or aborted (before and after the first binding) releases only its own binding.
- Non-last release with a finite call window and interleaved calls (A1 sent, A2 and B1 queued): the wire carries
  `abort(A1)`, never `call(A2)`; B1 is sent; the provider's handler for A1 is cancelled and its slot reused. Direct and
  relayed providers, asserting exact wire messages.
- Calls through two references both answered; parked calls per reference sent in order when live.

State changes:
- Rebind to another variant: every binding moves in one batch; a member the new variant lacks fails for all.
- Provider type removed and served again: both references wait and come back, no new consumer hold.
- Reload at the provider (§21): both follow the restart; a version no longer accepted unbinds both.
- `gone` and host close: every binding ends exactly once (watches, subscriptions, calls); the entry is gone; a later
  reference makes a new hold.
- Revocation: both end. Link drop: one re-hold, both live again.
- Route recovery: A on a route whose resolve failed stays held; a second `get` with the same key makes the route
  resolve again; both go live (and none while suspended).
- `too_large/part`: all fail broken; a new reference C makes a new group; `retry` from A1 takes A1 alone into a
  private hold (A2 stays failed until it retries); ending the old group, A1's and C's in any order leaves the table
  right (C's entry untouched); a later reference joins C's group if C lives.

Events:
- Two references subscribed to one event member each get every event once; stopping one's subscription leaves the
  other's.
- The fence: A live and subscribed; the provider emits E1, E1's delivery is delayed (a slow link, a pending inflate);
  B joins; E1 arrives: A gets it, B does not; E2 emitted after the provider handled `mark` reaches both. Also: an entry
  waiting in the provider's event list at `mark` (sent after it, `marked` after that message); a join before the hold
  was sent (no `mark`); a contract without event members (no `mark`); through a relay.

Presence, telemetry, memory, cost:
- Presence and activity at the provider: two references sharing one hold are two entries and two counts, as two
  holds are today; a non-last release takes one away; several joins in one turn send one `refs`.
- Telemetry: the shared `chord.hold` root linked to the first trigger; a joining getter's link while it is open;
  an untraced first getter followed by a traced joiner; the NOOP path.
- GC (`WeakRef` probes, as for the other caches): no `RemoteObject` in the table after the last release while the path
  lives; a released binding is not retained by a live sibling group; a released reference kept by the app does not
  retain the group; a dropped route path takes its table.
- Cost guard: two references, one hold: `chord.link.encodes` counts one encode per commit.
- An example, `test/examples/NN-shared-holds.ts`: three components holding one remote object over a link, the hold
  count printed.

## 10. Not decided here: first bindings and the window

The provider's window (K = 2 `bound`/`state` messages per origin) sends every binding waiting at a freed slot in one
`bound` message. Holds that become ready after a slot was taken wait for the next `ack`. Whether first bindings
should be exempt is a separate question, decided after a trace with p2's telemetry, once sharing is built, shows the
message and ack boundaries of a session switch.
