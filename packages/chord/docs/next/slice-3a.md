# Slice 3a: remote objects over one link (spec, for the owner's approval)

Status: **approved (owner, 2026-10-22)**, after Astra's and Fable's spec reviews. Guiding rule (owner): **simple, fast,
correct**; where a choice was open, this spec takes the simplest option that is correct and cheap per hop.

Slice 3 of the plan is split: **3a** (this) gets two hosts talking over one link; **3b** makes the link survive drops
(re-holds, parking, `ref.state`, `host.hold`, `ref.retry()`, `linger`, `host.root`, `state: false`). Flow control, size
limits, compression, relays, routing by address and IPC/WebSocket stay in slice 4; trace carriers (R5) in slice 9. The
single source for building 3a, together with the feature map in `slices.md`, `design.md` read in full (most relevant:
§3 links and values, §4, §5, §7, §8, §22), the decision log (R1, R4, R6, R20, Q1, Q4, W1, D11), the carry-over (L5,
L6) and the root `AGENTS.md` style section. Builds on L1 and slices 1-2 (`da3a16e9f`).

## What an app can do after this slice

```ts
type P = { kind: "owner" } | { kind: "guest"; session: string } | { kind: "server" };

const Notes = remote("notes", {
  version: 1,
  params: { session: str() },
  variants: {
    editor: { state: { notes: arr(Note), count: int() }, methods: { add: method(obj({ text: str() })) } },
    reader: { state: { notes: arr(PublicNote), count: int() } },
  },
});

const facet = defineFacet<P>((host) => {
  host.serve(Notes, ({ session }, principal, self) => {
    const store = self.get(NoteStore, { session });          // a local shared store (slice 1)
    const count = self.derive([store.notes], ([n]) => n.length);
    if (principal.kind === "guest") {
      return { variant: "reader", members: { notes: self.derive([store.notes], redact), count } };
    }
    return { variant: "editor", members: { notes: store.notes, count, add: async (args, ctx) => store.add(args, ctx) } };
  });
});

const server = createHost<P>({ principal: { kind: "server" }, onError });
await server.load([{ name: "@app/notes", facet }], ctx);
server.accept(link.a, { principal: { kind: "guest", session: "S1" } });   // the entry point authenticated it

const client = createHost<P>({ onError });                 // a tab: no principal of its own
await client.load([], ctx);
client.connect(link.b, { principal: { kind: "server" } });
const notes = await client.get(Notes, { session: "S1" }, ctx);
if (notes.variant === "reader") console.log(notes.notes.value);   // narrowed by variant
```

## 1. Hosts and links

- `createHost({ principal?, principalKey?, onError, … })`: a host with a `principal` acts as it for its own requests;
  a host without one (a client) has no principal. `principalKey` defaults to L1's canonical JSON.
- **A link** is an ordered, bidirectional channel of `Uint8Array` messages: `send(message)`, `onMessage(listener)`,
  `close()`, `onClose(listener)`. This slice ships `memoryLinkPair()`, which delivers each message one task later (as
  every link kind will). `send` after close is a no-op.
- `host.accept(link, { principal })`: a link from a child. Every hold and call arriving on it acts as `principal`,
  stamped by this host. `host.connect(link, { principal })`: this host's parent link (at most one; a second `connect`
  throws). In 3a a host serves over `accept` links and requests over its `connect` link; the `connect` principal is
  stored for 3b and slice 4 (nothing arrives for it yet).
- **Handshake:** each side sends `hello { protocol, incarnation }` first and nothing else until it received the
  peer's. A message before `hello`, a second `hello`, or another `PROTOCOL_VERSION` (L1) closes the link. `incarnation`
  is a uuidv7 minted per host; calls arriving on an `accept` link get the peer's as `ctx.incarnation` (R20).
- **Where a reference goes:**

  | Type | Served on this host | Not served here |
  | --- | --- | --- |
  | `local` | local (slices 1-2) | fails `unavailable` (local types never cross a link) |
  | `remote` | local, as the requester's principal (table below) | over the `connect` link; without one, `unavailable` |

  Any object may reference remote types, local objects included (a client's local view may `self.get` a server type).
  Remote objects live while referenced, also with empty params; `load` never activates them (Q-A).
- **Which principal a same-host remote reference uses:**

  | Requester | Principal |
  | --- | --- |
  | `host.get` | the host's `principal` (a host without one fails `forbidden`) |
  | `ctx.get` in a handler | `ctx.principal` (a guest's call gets the guest's view); a local handler: the host's |
  | `self.get` in a remote object's factory | that object's principal |
  | `self.get` in a local object's factory or a facet | the host's |

- **Closing:** a link closing (either side) ends what was bound over it: on the consumer, references through it end
  (`released`, watches `ended`) and pending calls and gets reject `unavailable`; on the provider, its holds are
  released. `host.close` closes its links first, then ends its objects (no `gone` to closed links). Surviving a drop
  is slice 3b.

## 2. Messages (R1, R4, Q1, Q4, §22)

```
| u32 header length, big-endian | header JSON (UTF-8) | part 0 | part 1 | … |
```

- **One format on every link.** The header is a JSON object, a tagged union over `kind`, defined as a TypeBox schema;
  every received header is checked with the compiled schema (the wire is a trust boundary; skipping it on trusted IPC
  links comes with IPC in slice 4). The header lists its parts: `parts: [{ json, bytes }]`, the JSON text's byte length and
  the byte lengths of the segments that follow it (`bytes: []` for state parts and arguments without bytes).
- **Kinds,** consumer → provider: `hello`, `hold { hold, type, version, fingerprint, params }`, `release { hold }`,
  `call { call, hold, method }` (1 part: the arguments), `cancel { call }`. Provider → consumer: `hello`, `bound {
  hold, variant, failed? }` (1 part: the snapshot), `state { holds: [{ hold, failed? }] }` (1 part per listed hold),
  `failed { hold, cause }`, `result { call }` (1 part), `error { call, error }`, `gone { hold, error }`.
- **Ids** are numbers chosen by the sender, unique per link and direction, never reused while in use (a counter).
  Ids a receiver does not know are ignored (Q1: a `result` crossing a `cancel`, a `state` part crossing a `release`).
  A `hold` or `call` reusing a live id is a protocol error.
- **One Delta encoder per state member** (owner, 2026-10-22, after the code review): the snapshot part is `{ [member]:
  value }` (each member's encoder restarted); a `state` part is `{ [member]: WireOp[] }` with only the members that
  changed (a derive's change is its `diffRevisions` ops; a retired singleton is `[["r", initial]]`).
- **A failed member** is listed in the header (`failed: [{ member, error }]`) of the `bound` or `state` that carries the
  failure, never in the part; the consumer's replica of that member then fails (reads throw the error, watches end
  `failed`), the others keep updating (W1).
- **Argument and result parts** are JSON text followed by raw byte segments: a `Uint8Array` leaf is written as
  `{"$bytes": i}`, segment `i`'s length in the part's header entry. Decoding replaces each reference with a `subarray`
  view of the received buffer (no copy). Example: `upload({ name: "chart.png", data: <1 MiB>, thumbs: [<2 KiB>, <512 B>]
  })` travels as header `…"parts":[{"json":74,"bytes":[1048576,2048,512]}]`, then the JSON
  `{"name":"chart.png","data":{"$bytes":0},"thumbs":[{"$bytes":1},{"$bytes":2}]}`, then the three raw segments. Encoding uses the
  `JSON.stringify` replacer only for methods whose schema contains a `bytes()` leaf (decided once per method); others
  are plain `JSON.stringify`. The key `$bytes` is reserved in those methods only (see below). State parts are plain JSON (state is JSON
  only).
- **Protocol errors close the link:** a header failing the schema, a part that is not valid JSON or whose wire ops fail
  Delta's checks, an id reused while live, traffic before or a second `hello`. These are structural checks of the wire,
  never checks of application state (state is never validated).
- **Errors on the wire** are a tagged union: `{ kind: "chord", error }` (a `ChordError`'s JSON, L1) or `{ kind:
  "plugin", code, message, details? }` (open point 3). Never a stack or a cause.

## 2b. Codecs, the `Message` type and checks (owner, 2026-10-22, after the code review)

Replaces the JSON-header framing of section 2 (`| u32 header length | header JSON | parts |`); the message kinds, ids,
races and rules of section 2 stay.

- **`Message`** is a tagged union defined once as a TypeBox schema (`MESSAGE`; `type Message = Static<typeof
  MESSAGE>`): `hello { protocol, incarnation }`, `hold { hold, type, version, fingerprint, params }`, `release { hold
  }`, `call { call, hold, method, args? }`, `cancel { call }`, `bound { hold, variant, members: [{ member, value }],
  failed: [{ member, error }] }`, `state { holds: [{ hold, members: [{ member, ops }], failed: [...] }] }`, `failed {
  hold, cause }`, `result { call, value? }`, `error { call, error }`, `gone { hold, error }`. Values (`params`, `value`,
  `ops`, arguments) are `unknown()` in the schema. `args` absent: a method without arguments; `value` absent: `null`.
  A payload that may carry bytes is marked so by the protocol layer (decided once per method from its schema).
- **Names are indexes:** `member`, `method` and `variant` are indexes into the **hold's bound version's** names,
  sorted per variant. Both sides hold that version's description (version and fingerprint matched at `hold`). An index
  is valid only while its hold is bound to that version; a provider that stops accepting a version ends that version's
  holds with `gone` (contract_mismatch) before its new code serves anything (slice 7 builds the reload side; carry-over).
- **`Codec { name, encode(message): Uint8Array, decode(bytes): Message }`**, chosen per link
  (`host.accept(link, { principal, codec? }, context)`, `host.connect(...)`, default `binaryCodec`); both ends use the
  same; a mismatch fails the first `hello` (a protocol error naming the expected codec). No negotiation.
  - **`binaryCodec`:** a kind byte, then that kind's fields as unsigned varints (ids, indexes, counts, lengths),
    length-prefixed UTF-8 strings, the incarnation as 16 raw bytes and the fingerprint as 8 raw bytes; values as varint
    length plus JSON text; byte segments (payloads marked as carrying bytes) as a count, lengths, raw bytes, referenced
    from the JSON by `{"$bytes": i}`. No outer length (links deliver whole messages).
  - **`textCodec`:** one JSON tuple per message, Delta style (a short kind tag, positional fields, no field names):
    `["h", protocol, incarnation]`, `["H", hold, type, version, fingerprint, params]`, `["R", hold]`, `["c", call, hold,
    method, args?]`, `["x", call]`, `["b", hold, variant, [[member, value]…], [[member, error]…]?]`, `["s", [[hold,
    [[member, ops]…], [[member, error]…]?]…]]`, `["f", hold, "t"|"b", error]`, `["r", call, value?]`, `["e", call,
    error]`, `["g", hold, error]`; byte segments follow the tuple (their lengths in it).
  - `describeMessage(message)` prints any message readably (the text tuple form) for logs and tests.
- **Who checks what** (layers 1-3 failing is a protocol error that closes the link):

  | Layer | Checks |
  | --- | --- |
  | 1. codec `decode` | lengths and varints fit, the buffer consumed exactly, a known kind, strict UTF-8, each JSON value parses, segment counts and references valid and only in payloads with bytes |
  | 2. `MESSAGE` schema (protocol layer, after any codec) | the envelope: kinds, ids and indexes are integers, lists and error shapes; not the values |
  | 3. the hold's bound version (protocol layer) | ids not reused while live (unknown ids ignored), indexes within the bound version's lists, order (`hello` first, `bound` before `state`) |
  | 4. owners | `params`: `checkParams` (a broken `failed`, link stays); arguments: `checkArgs` (`error { call, invalid/args }`, link stays); ops: Delta's decoder and `applyImmutable` before anything is adopted (protocol error); errors: `chordErrorFromJson` (protocol error); snapshots and results: never validated (R9) |

- **Memory link:** delivers with `queueMicrotask` (portable, asynchronous, no reentrancy); no Node-specific APIs.

## 3. Remote objects (§4, §5, §6)

- `host.serve(remoteContract, (params, principal, self) => ({ variant, members }))`: the factory returns one variant of
  the contract with exactly that variant's members. L1's `Implementation<C>` for a remote contract becomes the tagged
  union `{ [V in Variants]: { variant: V; members: VariantImplementation<V> } }[Variants]` (an L1 change); a local
  contract's stays its members. An unknown variant, or missing or extra members of the chosen variant, fails the
  activation broken (the member check, slice 1).
- Identity: `(type, params key, principal key)` (L1 `identityKey`).
- **Calls are checked against the binding's variant:** a call whose method is not in that variant fails
  `invalid/member` before anything else (a reader cannot call `add` by forging a message); then L1's `checkArgs` checks
  the arguments with the current version.
- **Contract match (R6):** a `hold` binds only when its version and fingerprint equal the provider's current ones
  (`accepts` is slice 7); otherwise `failed { hold, cause: broken contract_mismatch }`.
- **A hold's activation** follows slice 2 on the provider: a broken failure is sent as `failed { hold, cause }` and is
  final (the provider releases the hold); a transient one is sent as `failed { hold, cause }` with the hold kept
  pending while the object retries; going live sends `bound`. The provider has no deadline of its own for a hold: the
  consumer's getter deadline decides (it releases the hold when it gives up). A hold arriving before `load` resolved
  waits for it; one arriving while the previous instance of its identity tears down waits for that (slice 2).

## 4. References over a link (§7)

- `host.get(Remote, params, ctx, { readyTimeout? })` sends `hold` and resolves with a live, hydrated reference on
  `bound`. A `failed` with a broken cause rejects at once; a transient one is remembered while the get keeps waiting;
  at its deadline (or cancellation) the get sends `release` and rejects with the last cause's error (or `unavailable`
  if none arrived). `self.get(Remote)` follows slice 2 (R18): its object waits for `bound`, and a broken or transient
  `failed` fails it as a failed dependency.
- `ref.variant` is the variant's name and the discriminant TypeScript narrows on; a local reference has no `variant`.
- **Replicas:** each state member of a remote reference is a watchable on the consumer, built from the snapshot and
  then by Delta's `applyImmutable` of its ops (no validation, no copy). One `state` message is applied as **one batch**
  of the consumer host, for all its holds, before any watch frame, so no consumer sees half a provider commit (W1).
- `ref.method(args, ctx)` (or `ref.method(ctx)` without arguments) sends `call` and resolves with its `result`, or
  rejects with its `error`. A call before `bound` cannot be made (the reference does not exist yet); a forged one is
  answered `error { call, not_ready }`. The caller's cancellation sends `cancel` and rejects the caller at once; the
  provider aborts that call's context.
- **Release** (open point 1): `ref.release()` rejects the pending calls made through that reference with `released`,
  sends `release`, and the provider aborts the handler contexts of that hold's calls and unholds (an object with params
  ends with its last reference, local or remote). The same rule applies to local references (a change from slices
  1-2, where a release left its pending calls running).
- `gone { hold, error }` (the provider object ended): the reference ends (`released`, watches `ended`) and its pending
  calls reject with the error; no per-call errors are sent.
- Two references to one object from one host are two holds, each with its own encoder (two tabs are two clients).

## 5. The provider side: one message per link per commit (W1)

- A hold attaches to its object's state members as a **synchronous subscriber**: `Source` gets a second set of
  subscribers besides its watches, fed `(value, ops)` inside the batch's delivery; a hold counts as watching, so exposed
  derives recompute in the batch. Taking the snapshot and attaching happen in one synchronous step, so the first
  `state` part continues exactly from the snapshot.
- During a batch each touched hold collects its members' ops; at the **end of the batch** (a hook `Batch.commit` runs
  after its delivery loop) each touched hold encodes its collected ops **once** into its part, and each link with
  touched holds sends **one** `state` message. A link that closed meanwhile drops it.
- A hold whose object ends sends `gone`; a failed member is announced once in the next `state` (or the `bound`).

## 6. `ctx` (§8)

`ctx.principal` (the stamped caller; on a local handler the host's), `ctx.incarnation` (the calling host's over a link,
the own host's otherwise, R20), `ctx.get(Type, params)` (a reference released when the **handler** settles; a
`ctx.get` after that throws `released`), the abort signal and telemetry.

## Races

1. A `result` crossing a `cancel`; a `call` crossing `gone`; a `state` crossing a `release`; a `bound` crossing a
   `release` (the consumer ignores a `bound` for a hold it released): ignored by id (Q1).
2. A commit between binding a hold and sending `bound`: the snapshot and the subscription are taken in one synchronous
   step.
3. A forged call before `bound`: `error { call, not_ready }` (parking is slice 3b).
4. The provider object ends with calls pending: `gone`; the consumer rejects those calls itself.
5. The consumer releases with calls pending: rejected locally `released`; the provider aborts the hold's calls.
6. `release` while the provider is still activating for that hold: unhold (may end the object, slice 2); `bound` is
   never sent.
7. A `hold` while the previous instance of its identity tears down: waits (slice 2's endings).
8. One object held over two links, one link closes: only that link's holds are released; the other keeps updating.
9. A link closing during a batch: its `state` message is dropped; holds and calls on it end (section 1).
10. A handshake that never completes: nothing else is accepted; a get over it waits up to its deadline.
11. A `ctx.get` finishing after its handler settled: the late reference is released at once.
12. A failed member and healthy members of several holds in one batch: each hold's part carries its healthy ops, its
    header the failure.

## Benchmarks (owner: light benchmarks for memory, timing and wire size)

A script `packages/chord/test/next/bench/links.ts` (run by hand, not in CI) prints one table **per codec, side by
side** (owner: both codecs, memory and compute); results are recorded in `packages/chord/docs/next/benchmarks.md` for
later slices to compare against. Per case and codec: wire bytes per message; compute (encode and decode time per
message over many messages, and commit-to-frame time end to end); memory (heap allocated per message while encoding and
decoding 10,000 messages, measured with `--expose-gc`, and memory retained per hold). Payloads modelled on p2:

| Case | Measured |
| --- | --- |
| hold of a notes list of 1,000 items; of a 500 KB document | snapshot encode/decode time, wire bytes |
| one appended item, one changed field, one removed item | commit-to-frame time on the consumer, wire bytes per message, encodes per hold |
| a streamed reply: 2,000 small text appends to one entry | time and bytes per append, total bytes |
| 1 and 10 holds of one object on one link | memory per hold (encoder and replica), messages per commit |
| a call with a small argument; with a 1 MiB `bytes()` argument | round trip, wire bytes (about 1 MiB, not 1.33) |

## Carry-over taken by this slice

L6: `PROTOCOL_VERSION` in the handshake; one message per link per commit; bytes as raw segments; a malformed error
envelope closes the link; the plugin error shape. L5: `ctx.get`, `ctx.principal`. Moved to 3b in the feature map:
`host.root`, C8 (`state: false`).

## Tests

- Messages: every kind round-trips; parts with byte segments; `$bytes` refused in methods with bytes and plain data elsewhere; each protocol error closes
  the link; unknown ids ignored; id reuse refused.
- Handshake: traffic before `hello`, a second `hello`, protocol mismatch; incarnations stamped.
- Remote objects: variant per principal; identity per principal key; a call outside the binding's variant fails
  `invalid/member` (forged at the wire, not just in types); arguments checked; contract mismatch; invalid variant or
  members fail activation broken; remote objects with empty params are not activated by `load`.
- Principals: the four same-host cases of section 1.
- References: hydrated on get; broken `failed` rejects at once; transient `failed` keeps waiting and the deadline
  rejects with the last cause and releases the hold; replicas apply one message as one batch (a consumer derive over two
  members never sees half a commit); calls, results, cancel, errors of both kinds; release rejects pending calls (local
  and remote); `gone`.
- One message per commit: three holds on one link, one message; a derive with its source; two links, two messages.
- Every race above.
- Cost guards: one encode per hold part; no validation or copy of state on either side.
- GC: a closed link and a released reference, **retained** by the test, hold no holds, encoders, replicas or objects.
- Examples: `08-remote.ts` (two hosts, variants per principal), `09-calls.ts` (calls, results, errors, cancellation,
  release).

## Decided with the owner (2026-10-22)

Slice 3 is split into 3a and 3b; a remote factory returns `{ variant, members }`; `ref.variant` is the discriminant
(C15: no `inVariant`/`expectVariant`; `variant` reserved as a member name); headers are checked on every link for now.
Release rejects the calls made through the released reference, locally and over links (their handlers' contexts are
aborted). `$bytes` is reserved in the arguments and results of methods whose schema has a `bytes()` leaf (encoding
refuses it with `invalid/args`); elsewhere it is plain data, since only parts with byte segments resolve references
(owner, 2026-10-22, narrowing the first decision). Plugin errors: `new PluginError(code, message, details?)`; any other thrown value crosses
as `{ kind: "plugin", code: "internal", message }`; only code, message and details cross; same-host callers get the
thrown value; the consumer rethrows a `PluginError`.

## Size

About 1,500-2,000 source lines (both reviewers), including the L1 change and the batch's subscriber hook.
