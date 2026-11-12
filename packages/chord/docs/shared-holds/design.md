# References sharing one wire hold

Status: design, fourth draft (2026-11-12). Drafts 1–3 (502f79e3e, 20a6e09dc, 7a1c1f61e) shared one hold among
references and patched what that lost (an event fence, a reference count); two review rounds by GPT-6 Astra
(adversarial, with probes) and GPT-6.1 Sol (against design.md) showed that a shared request cannot be made
indistinguishable from separate ones. This draft keeps **one request per reference** at every hop and shares only the
state stream underneath it (the join model). Owner, 2026-11-12: "this needs to be water tight; on the surface nothing
should change at all"; the two differences in §2 are accepted ("that sounds fine"; "that's the whole point").

Sections cited are design.md's unless marked: §3 (holds, routes, relays, flow control), §4 (principals), §7
(references), §11 (state, watches), §19 (presence), §21 (reload), §22 (wire), §29 (telemetry), §30 (cost); the events
spec (`docs/events/spec.md`) §2.4 (eligibility) and §2.6 (wire, windows); decisions D8, R1, Q1, Q5.

## 1. Problem

Every remote reference holds its object separately: N references to one object on one host cost N snapshots (encoded
at the provider, sent, parsed here), N delta encoders at the provider and N decoders and replicas here, and every
commit encoded N times. In p2 a page holds `p2.views` 3 times, `p2.chat` and `p2.chat-mode` twice, and one artifacts
store per Markdown pane (measured 2026-11-12); a React page normally has several components showing one object.
Local references already share their object (one `ChordObject` per identity, every `Binding` one of its holders).

What this change saves: snapshots, encoding, bytes and parsing for every reference after the first. What it does not
change: when a reference binds. Each reference's request still takes its turn in the provider's window (K = 2), so
the time to first value of a session switch is unchanged by this design; that is §12's separate question.

## 2. Goal and the two accepted differences

Every observable behaviour stays as it is today, for the reference (its state and the order of its transitions, its
values, readiness of `host.get`, calls, their order, their errors and the provider's cancellation reasons, parked
calls, events and their eligibility, retries, release, error codes, `host.activity`) and at the provider
(`host.references` entries, their order and timing, `host.activity`, `ctx.principal` and `ctx.incarnation` of calls,
variants, revocation, keep-alive, reload). Telemetry is not surface.

Accepted differences (owner, 2026-11-12):

1. **Part limits apply to the parts a request receives.** A joined reference receives no snapshot, so a value that
   grew past a link's part limit through small deltas does not fail a new reference with `too_large/part`, as a fresh
   snapshot would. Delta parts are encoded per carrier, so their sizes may differ slightly from what a separate hold's
   encoder would make; a part past the limit fails every reference sharing it.
2. **References sharing a stream share values.** Two references read the same replica: `a.member.value ===
   b.member.value` is `true` where separate snapshots parsed two copies. Values are immutable by convention.

## 3. The model

- **A request** is what one reference sends: today's hold, with its own id, principal, incarnation, placement,
  admission, presence entry, activity count, calls, notices (`failed`, `loading`, `gone`), retry and release. Every
  reference has exactly one, at every hop, as today.
- **A carrier** is a request that also carries the state stream: its `bound` brings the snapshot, its subscription
  brings deltas and events. Today every request is a carrier.
- **A join** is a request that names a carrier it would share a stream with. Every hop places, admits and records it
  as the hold it is. The provider answers it with `joined` instead of `bound` when, and only when, it can prove the
  join would have seen exactly the carrier's stream: same object instance, same variant, same version. Any hop that
  cannot prove it treats the join as an ordinary hold, and its `bound` makes it a carrier of its own. So the fallback
  of every case is today's behaviour.
- **A group** on the consumer is one carrier and the joins confirmed against it: one set of replicas, read by every
  member's binding.

## 4. Consumer

**Groups.** A host keeps per path (`WeakMap<Path, Map<string, Group>>`) the groups of its references by key:

```ts
key = joinKey([Type.name, String(Type.version), Type.fingerprint, params.key, addressKey, callerKey, caller.incarnation])
// addressKey: joinKey([address.kind, canonical JSON of address.params]) of the placement's WireAddress
// callerKey: "-" without a principal, else "+" + the principal's canonical JSON (cached per principal object, WeakMap)
```

`joinKey` escapes every part, so params and principals of any content cannot collide. The key only decides which
carrier a new reference names; correctness never depends on it, because every hop checks the join itself (§3).
`self.get` references (activation chains, Q5) never join and are never named as carriers.

**Making a reference.** `host.bind` places it as today (`Destination.reference`: routes, `authorize` on this host).
Then:

- no group for the key, or the group has no carrier request on the current link: the reference sends a plain `hold`
  and becomes the group's carrier (a new group if none);
- otherwise it sends `hold` with `carrier: <the carrier's hold id>` on the same link, in order with everything else it
  sends (so its request precedes its later calls, exactly as a hold does today).

Until its own `joined` or `bound` arrives the reference is `loading`, as today, whatever its group shows.

**`joined { hold, carrier, cutoff }`** (an entry of a `bound` message, below): the reference becomes a member of the
carrier's group and goes live in that message's batch, reading the group's replicas. It records:

- **which members it has seen**: members that are failed or that the bound variant lacks at this point are "not seen"
  for this binding: a watch opened on one rejects with its error, as on a fresh failed snapshot; a later value makes
  it seen. (A fresh snapshot carries no history; Sol's trace: a joiner must not see a failed member's last value.)
- **its event cutoff**: the provider's emit counter `cutoff` at the moment its `joined` was sent. It receives the
  carrier's event entries with `n > cutoff` (events spec §2.4: entries after its binding was sent).

**`bound` for a join** (a hop could not confirm it): the reference leaves the group it named and becomes a carrier of
a new group with its own replicas, exactly as a separate hold.

**Per request, as today:** `failed`, `loading`, `gone`, `result`, `error` address the request's own id and change only
its own binding. Calls go over the reference's own id. `ref.retry()` retries its own request; after `too_large/part`
it is placed anew as a plain `hold`. Releasing sends `release` for its own id (the provider cancels its calls with
`released`, as today), with one exception:

**The carrier's reference releases while members remain:** it sends `leave { hold }` instead. The provider treats it
as a release of the request (presence entry and activity count removed, its calls cancelled with `released`, its
`chord.hold` ended) but keeps the carrier's subscription for the members. The consumer keeps the left carrier as the
group's stream until the last member releases, then sends `release` for it.

**Link drop.** Every request re-holds on the next link, as today: the group's first live reference sends a plain
`hold` (the new carrier; a left carrier is not re-held), the others `hold` with `carrier` naming it.

**`too_large/part` on a carrier's part:** every request of the group fails broken `too_large/part`, each released at
the provider (a separate hold receives the same part today); the group is removed from the table.

**Table hygiene.** A group is removed (by identity: `if (table.get(key) === group)`) when its last request ends, when
it leaves its path, or when it fails broken; a later reference makes a new group.

## 5. Provider

A `hold` with `carrier` is a hold: placed, admitted, refused, retried, listed, counted and called exactly as one
(`ProviderSide`, `Hold`). Only its binding differs:

- When the join's object goes live for it (the moment a `bound` would be sent), the provider answers `joined` instead
  of `bound` if the named carrier is a hold of the same `ProviderSide` (link and origin), bound or binding in this
  same message to the same object instance, variant and version, and still subscribed. Otherwise it sends `bound`, as
  for any hold.
- `joined` is an entry of the `bound` message (`bound.joined?: [{ hold, carrier, cutoff }]`), so it takes the window
  exactly as the `bound` it replaces: the reference binds at the same moment a separate hold would. Before a `bound`
  message with `joined` entries, the provider sends the carriers' waiting state (as before a call's answer, §3 "a
  call's answer follows its state"), so the group's replicas show at least what a snapshot taken now would show.
- `cutoff` is the host's emit counter when the message is sent, the value a separate hold's binding records (events
  spec §2.4).
- A joined hold has no subscription and no encoder: its state is the carrier's. Its `failed`, `loading` and `gone`
  notices are sent to it as to any hold. A rebind (a restart, another variant) sends the carrier `bound` and each
  member `joined` again, in the same message, under the same rule.
- Event entries carry the emitting host's counter value: `event.events[i].n` (present on links whose peer announced
  `joins`). An entry for a carrier is sent when some request of its group is eligible (`n` above the lowest cutoff
  among the carrier and its joined holds); the consumer filters per binding. (Re-exposed events keep the counter of
  the host that sent them, as `at`.)
- `leave { hold }`: the request ends (presence, activity, calls with `released`, telemetry), its subscription stays
  while joined holds name it; once none do and the consumer releases it, it goes as any hold.
- A carrier that ends for a reason of its own (released, revoked, gone) while joined holds remain cannot happen
  without `leave` (the consumer leaves, never releases, a carrier with members); revocation and `gone` end the object
  or the principal's requests, joins included. If it happens anyway (a misbehaving peer), each remaining join gets a
  fresh `bound` and becomes a carrier.

## 6. Relays

A relay places every hold it receives by its address, as today (`host.place`, routes, `authorize`), joins included:

- A join placed on the same upstream link as its carrier's relayed hold (same origin) is forwarded with `carrier`
  unchanged (relayed holds keep their ids, §3 "Relays"). Placed elsewhere, or with a carrier the relay did not relay,
  or upstream that did not announce `joins`, it is forwarded without `carrier`: the provider binds it fully and the
  consumer makes it a carrier.
- A join refused at the relay (`authorize`, invalid params, the route failed) gets its own `failed`, as a hold does;
  route recovery runs for it as for any new hold (it is attached to the route's path).
- `leave` is forwarded like `release` but the relayed hold stays for the stream; on an upstream re-hold a left carrier
  is not re-held, and joins naming it go without `carrier`.
- `bound` with `joined` entries and `event` entries with `n` are forwarded unchanged (envelope only).

## 7. Wire

| Change | Where |
| --- | --- |
| `hello.joins?: true` | both sides: this side handles `carrier`, `joined`, `n` and `leave`. A side sends `carrier` and `leave` only to a peer that announced it, and `joined` and `n` only to a consumer that announced it; to any other peer it sends what it sends today |
| `hold.carrier?: id` | to provider: the hold this request would share a stream with (an id of the same origin on this link) |
| `bound.joined?: [{ hold, carrier, cutoff }]` | to consumer, in the same message and batch as `bound.holds` |
| `event.events[i].n?: int` | to consumer: the emitting host's emit counter value of the entry |
| `leave { origin?, hold }` | to provider: the request ends, its stream stays for its joins |

- Codecs: `hold`'s optional-field flags gain `carrier`; `bound` gains a trailing count and entries (absent: 0); event
  entries gain `n` behind a flag in the message header; `leave` takes an unused kind byte (binary) and tag (text).
  Each exact layout is fixed in `link/binary.ts` and `link/text.ts` with round-trip tests, existing layouts unchanged.
- `MESSAGE` gains the fields and kind; checks by layer as §22. Q1: a `carrier` naming an id the provider does not know
  as a hold of that side is a plain hold (bound fully); a `joined` naming an unknown hold or carrier is ignored; a
  `leave` for an unknown id is ignored, for a hold with no joins it is a `release`.
- Resources: a join is a hold (one presence entry, one activity count, the same checks), so it adds no amplification.
- `PROTOCOL_VERSION` stays 1: peers that did not announce `joins` see today's messages only.

## 8. Why each observable stays the same

| Observable | Why it is unchanged |
| --- | --- |
| a reference's states and their order | its own request gets every notice, as a hold does; it goes live at its `joined`, which takes the window as its `bound` would |
| its first values | its `joined` follows the carrier's waiting state, so the replicas show at least the provider's state when `joined` was sent, as a snapshot taken then; members failed or missing then are "not seen" for it |
| later values and their batches | one `state` message per commit per link and origin already carries every touched hold; the group's replicas apply the carrier's entry in that batch, as each hold's would |
| `host.get` readiness | live at `joined`, the moment a separate `bound` would have been sent |
| calls, their order, `ctx.principal`, errors, cancellation reason | over its own request id, sent in order after its `hold`; release cancels them at the provider with `released` |
| events and eligibility | its cutoff is the counter value its own binding would have had; `n` on each entry decides per binding, also within one flush |
| retry, refusals, `too_large` retry | per request; a refused or retried join is placed and checked on its own |
| route admission and recovery, at this host and at relays | every join is placed and authorized at every hop as a hold |
| reload (a version no longer accepted) | each join is checked against the served contract as a hold; one refused gets `failed` |
| `host.references` entries, order, timing; `host.activity` | one provider hold per reference, made when it arrives and removed at its own `release` or `leave` |
| revocation, `gone` | per request and per object, as today |
| peers without the feature | they never see a new field or message |

## 9. What changes in the design

- **§7 References:** add after "Members": "References share their state stream (decision "References share one
  stream"): a reference to a remote object another reference of this host already holds (same type, version,
  fingerprint, params, address, principal and incarnation) is its own request naming that hold as its carrier; the
  provider confirms it with `joined`, and it reads the carrier's replicas. A request the provider cannot confirm binds
  fully. `self.get` references never share."
- **§3:** holds may name a carrier (`hold.carrier`), relays forward it when they place the join on the carrier's link;
  `leave`; `hello.joins`. "Every reference is a request" stays as it is.
- **§22:** the message table rows and codec notes of §7.
- **Events spec §2.4:** entries carry `n` on links that announced `joins`; a joined binding's counter is its `cutoff`.
- **§30 Cost:** a snapshot, encoder and decoder per carrier, not per reference; a request per reference as before.
- **§2 accepted differences** in §22 (part limits apply to received parts) and §7 (shared values are identical).
- **`src/remote/README.md`:** groups, carriers, joins, `leave`.
- **decisions.md:** "References share one stream (owner, 2026-11-09 and 2026-11-12)": the model, the accepted
  differences, and that drafts 1–3's shared requests were rejected because a shared request cannot keep each
  reference's admission, presence, principal, cancellation and event boundary.

## 10. Build

- `link/message.ts`, `link/binary.ts`, `link/text.ts`: the fields and kind of §7.
- `remote/host-link.ts`: `hello.joins`; dispatch of `leave` and of `bound.joined`.
- `remote/consumer.ts`: holds with `carrier`; `bound.joined` (batch with the message's `bound` entries, then the ack);
  `bound` for a join (split); event entries filtered per binding by `n`.
- `remote/remote-object.ts`: split into the request (one per reference: id, state, calls, path attachment, re-hold)
  and the group (replicas, event nodes, carrier); `leave`; split on `bound`; per-binding seen members.
- `host/host.ts` `bind`: the group table and key; `host/reference.ts` and `reference-source.ts`: a binding's seen
  members and its event cutoff.
- `remote/provider.ts` and `remote/hold.ts`: `joined` instead of `bound` under §5's rule; the carriers' waiting state
  before such a message; `n` on event entries; `leave`; rebind re-joins.
- `remote/relay.ts`: carrier forwarding or stripping; `leave`; re-holds without left carriers.
- `host/events.ts`: entries keep their counter value for the wire.

## 11. Tests (one file per source file, per the Chord code style)

Each of Astra's and Sol's traces, asserting today's outcome:

- Custom principal keys equal, principal data different: two carriers (key), and with equal keys forced, calls report
  each reference's own `ctx.principal`.
- Relay `authorize` turns false: a new reference is refused, the existing one stays; turns true again: the new one
  binds while the old one stays failed.
- Readiness: a commit completed at the provider before `get`, delivery held: the joiner's first value includes it.
- A reference made and called in one turn: the provider's method sees both references in `host.references`.
- Presence order X1, Y, X2: releasing X1 leaves [Y, X2]; releasing X2 leaves [X1, Y].
- Non-last release with a call running: the provider's handler is aborted with `released`; with a finite call window,
  queued calls of the released reference never reach the wire; the sibling's calls go on.
- Two references to an unserved type: retrying one moves only it (`loading` → `failed`); the other has no transition.
- Event entries around a join within one flush (E1 before, E2 after the `joined` send): the joiner gets E2, not E1;
  two joins in one flush; a full state window delaying a join's `joined` while the carrier receives events: the joiner
  gets none of them, then those after its `joined`.
- A joiner on a live object with a failed member: its watch rejects with the error (no last value), as with a fresh
  snapshot; a member the current variant lacks: likewise.
- Reload dropping the version while the old attempt drains: a new join is refused `contract_mismatch` while the old
  reference stays live.
- Route recovery on this host and through a relay: a new join re-resolves.
- Relay reconnect: joins re-hold with the new carrier; a left carrier is not re-held; its joins bind fully.
- Old peers: a consumer or relay whose peer did not announce `joins` sends plain holds; a provider without the
  feature never receives `carrier`; mixed builds over two relays.
- `leave`: the carrier's reference released while members remain: its presence entry goes, its calls are cancelled
  with `released`, members keep receiving; the last member's release releases the carrier.
- Fallback: a join whose carrier the provider cannot confirm (another instance, variant, version, unknown id) gets a
  `bound` and its own replicas.
- `too_large/part` on a carrier part: every reference of the group fails broken; a new reference makes a new group.
- The accepted differences, asserted as documented: a value grown past the limit by deltas does not fail a joiner;
  `a.value === b.value`.
- Codecs: round trips of every new field and kind, both codecs, with origins; existing layouts byte-identical.
- GC (`WeakRef` probes): no group in the table after its last reference ends while the path lives; a released binding
  retained by no group; a dropped route path takes its table; per-binding seen sets and cutoffs gone with the binding.
- Cost guard: two references, one carrier: one snapshot and one encode per commit (`chord.link.encodes`).
- An example, `test/examples/NN-shared-streams.ts`: three components holding one remote object over a link; snapshots
  and encodes printed.

## 12. Not decided here: first bindings and the window

Each request still waits for the provider's window (K = 2 `bound`/`state` messages per origin) as today; every binding
waiting at a freed slot leaves in one `bound` message. Whether first bindings should be exempt (the main cost of p2's
session switch) is a separate decision, to be traced with p2's telemetry once this is built.
