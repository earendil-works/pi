# Rooms: view principals, the view kit and methods for the agent

Status: built 2026-11-11 (p3 session 8b6ab5cc's brief, `apps/p3/docs/views.md` §4a); reviewed by two models. Plugin:
`plugins/views`; base changes in `src/runtime/{principals,chord,server}.ts` and `src/hosts/server.ts`. No Chord change.

## 1. The view principal and its link

```ts
type ViewPrincipal = {
	kind: "view"; session: string; view: string;
	opening: string;                                // which opening of the view (below)
	mode: "read" | "write";                        // what the frame may do in its room (below)
	for: { name: string; role: "owner" | "guest" }; // names and presence only, never authority
	link: string;                                   // the token's ID: each frame link its own principal, and its peer ID
	editor: string;                                 // the frame's first link ID: one frame across its reconnects
	viewer: Revocation[];                           // revokedBy(viewer) when the token was made
};
```

- **Openings.** Each time a custom view is added to a session (not when it is updated) the worker gives it a new
  opening ID (a uuid, kept in its views document beside the view, `opened[id]`; a view from before has `"0"`). Closing
  and reopening a view under the same ID is a new opening. `ViewOpenings { session }` (worker, server only) states the
  current opening of every custom view. Tokens, view principals and rooms carry the opening; a token is refused at
  redemption unless its opening is the view's current one, and a room whose opening stops being current (closed, or
  closed and reopened) revokes its frames. Revocation is edge-triggered in Chord (no deny list), so nothing relies on
  watching a boolean: a fold of "closed, reopened" into one change still shows another opening ID.
- **A closed view's objects.** Closing retires the view's state and room documents. `ViewState` and `ViewBacking`
  held after that (a page that has not seen the close, another device, a reconnect; the server's room lingering after
  its frames were revoked, held again on a restarted worker) activate cleanly: they read the documents' initial value,
  as earlier holders of the retired documents do, and their writes are refused (`ViewState.set`: no view; the
  backing's `write`: false). Nothing about a closed view fails an activation, so it never shows up as an owner notice.
- **Token.** The page asks `ViewLinks { session }` (server, remote, variant `viewer`) for `token({ view })`, which answers `{ token, opening }` (the opening read from `ViewOpenings` in a server root; no
current opening: refused). Its factory
  admits `canView(principal, session)`; the `token` method then awaits `mayReach` for guests (factories are
  synchronous), so a stale grant is refused. The token is 32
  random bytes, single use, valid 60 s, at most 8 outstanding per `ViewLinks` object; it is dropped when that object
  ends, so revoking the viewer (which ends its objects) also kills its unused tokens. Redemption checks again: the
  opening must be current, and a guest viewer must still reach the session (`mayReach` with the guest principal the
  token was made for); revoking a view's room also drops that opening's unused tokens. `mode` is `write` when the viewer
  `canSend`, else `read`; `for.name` is the owner's configured name or the guest's.
- **Link.** The frame (opaque origin) opens `ws(s)://<server>/chord/view?token=…` itself, only when its code first
  asks for a room or offers methods. `src/hosts/server.ts` handles this path only: the Host header must be valid (as
  for every request: loopback or an allowed tunnel, or a relay resolver's), `Origin` must be `null` or the server's
  own; cookies are ignored; the principal comes from the `LinkTokens` registry entry `view` (views plugin) by the
  token alone; no token, no link. Reconnects take a new token through the bridge.
- **Revocation.** `Revocation` gains `{ view: "<session>/<view>/<opening>" }`. `revokedBy(view principal)` is that plus
  `viewer`: revoking the viewer's device or guest grant (sharing does this on every grant change) closes its frames'
  links and ends their objects; a room that sees its opening is no longer current revokes `{ view }` (§3).
- **Deny by default.** p2's `defineFacet` wraps every `serve` of a remote type: a factory called for a view principal
  throws `forbidden` unless its contract was declared with `forViews(remote(...))`. Only `ViewRoom` is. Workers are
  unreachable anyway (`mayReach` admits owners, the server and guests). So a frame never gets the viewer's powers, and
  no frame message acts as the page's user: the bridge keeps doing only what it did (its own view's state and selection).

## 2. The view kit

One IIFE built by the server with esbuild (`buildBrowserScript`, as test fixtures) from `plugins/views/kit/main.ts`
on first request, named by content: `GET /view-kit/<sha256>.js`, public (no principal; it is code), `Cache-Control:
public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy:
cross-origin`. `/view-frame` injects `<script src=…>` right after the bridge and adds the server's origin to the
frame CSP's `script-src` and its WebSocket origin to `connect-src`. A sandboxed frame's requests say `Origin: null`
(also for a script): the server answers such a GET or HEAD of the kit's path as nobody (cookies unread); every other
`Origin: null` request is still refused (403). The kit holds a Chord client (`createHost`, `webSocketLink`, no facets), the room, methods
and text clients, and articulated's `IdList`: 443 KB minified, 136 KB gzipped, mostly Chord's host (`createHost`
pulls the whole kernel; a smaller client host is a Chord change, not made), downloaded once per browser. articulated
is a host package of server facets (`src/hosts/plugins.ts`), as plugins cannot bundle the app's hoisted packages. It
extends `window.p2view`:

```js
const room = p2view.room("live" | "log" | "text", { maxInFlight });   // one room per view; the first call opens the socket
room.me; room.peers; room.leader; room.isLeader; room.onPeers(fn)
room.emit(data, { key })   // motion: an event to every frame there now; unnumbered, never kept, latest-only when busy
room.onEvent(fn)           // fn({ from, key, at, data }) per event, own ones included; returns the removal
room.send(data, { key })   // numbered (key: newer replaces undelivered older, kept for joiners); resolves its outcome
room.onMessage(fn)         // fn({ seq, from, key, data }), in seq order, own messages included
room.now(); room.rtt()     // server clock (re-sampled every 10 s), the shortest recent round trip
room.onReset(fn); room.snapshot(state)       // log: fn(state, seq) on join and reset; the leader snapshots
const text = p2view.room("text"); text.bind(textarea); text.value; text.onChange(fn); text.onCursors(fn)
p2view.methods.offer({ name: { description, args /* JSON Schema */, run: async (args) => result } })
```

Which to use: events for motion (a sample is worthless a moment later), keyed messages for what a joiner needs (the
newest per key), unkeyed sends (log rooms) for commands every frame must get in one order.

- **Motion outbox** (`kit/outbox.ts`, `Motion`): while the room is joined, an emit leaves at once as an `emit` call,
  at most `maxInFlight` (default 32) unanswered; past it a keyed emit replaces the waiting one with its key (at most one
  waits per key; they leave together when an answer frees a slot) and an unkeyed one is dropped. Not joined
  (connecting, reconnecting, the reference loading): dropped, never queued or replayed. Leaving joined (the link
  closes) empties it and retires its generation: an answer of an earlier generation's emit changes nothing of the new
  count, and nothing sent before is sent again. The room's event listeners belong to the connection: each new
  reference (every rejoin) subscribes them, the released old one ends its subscription.
- **Reliable sends** (`Sends`): `send` waits until the room is joined (the first join of a log or text room starts it
  over at a new base, which would pass over a command sent ahead of it; after a reconnect, until the rejoin): messages
  sent in one turn leave in one batch, batches in
  order without waiting for earlier answers (Chord keeps a link's calls in order; the room numbers in that order).
  Outcome: `{ kind: "sent", seq }` (the number from the numbering transaction), `"superseded"` (a keyed message
  replaced in the outbox before it left), `"refused"` with the error (the budget, a frame that may only watch), or
  `"uncertain"` (its link closed before the answer: it may or may not have been numbered). Nothing is replayed by
  itself; a lockstep game dedupes resends by its own command IDs. A connection closed for good (`close`) resolves what waits, and
  every later send, `uncertain`.
- **Clock:** a few samples of `now()` at the first join, then one every 10 s; the shortest round trip of the last six
  (measured with `performance.now()`) sets the offset and `rtt()`.
- **Quiet reconnects:** a call rejected because the frame's own link closed (a reconnect, a lag eviction: revoked
  `{ link }`) is not logged; a refused token (a revoked grant, a closed view) still is, and that is what reports them.

## 3. Rooms (server, in memory)

**Contract versions.** `ViewRoom` version 2 adds the `peer` variant's event member `stream` (`{ from, key?, data }`)
and the method `emit({ messages })` (writers only), and `send` answers the numbers it gave. Version 1 (`ViewRoomV1`,
verbatim as 682c7b93c released it: the kits built then are cached by hash and keep it) is served through `accepts`:
its frames bind without events, and their `send` answers `null`.

`ViewRoom { session, view, opening }` (server, remote, `forViews`): variant `peer` for view principals of that opening,
variant `worker` for the session's worker (which passes the current opening). Both share one `RoomStore { session,
view, opening }` (local, linger 10 s; in-memory documents, one per state member: a member's pending ops fold only
within that member), which holds `ViewOpenings { session }` and `ViewBacking { session, view, opening }` (worker,
remote, server only: the view's state, the room's own document, a conditional `write`; refused unless the opening is
current). When the opening stops being current, the store calls `Server.revokeFrames`, which also revokes single
links (`{ link }`, below). One store per room with params, not keyed documents of one host-lifetime store: each room
then has its own dependencies on the worker, its own line, and its own end.

- **Presence** derives from `host.references(ViewRoom)`: view principals of this opening, in bind order (the server's
  own admission order); a peer is `{ id: link, name, role, mode }`. The peer ID is the principal's `link`, minted by the
  server, never the reference's incarnation (a client's hello claims that: a raw link could pose as another peer). Two
  frames of one viewer are two peers. The **leader** is the oldest present `write` peer. `join({ kind })` returns the
  caller's peer ID. Read peers watch: `send`, `offer`, `answer`, `snapshot` and `edit` need `write`.
- **Bounded delivery.** Chord sends a held member whole in a snapshot, and a member over the part limit fails the hold
  (`too_large/part`). So the history (the journal: unkeyed messages kept by the rules below) is in in-memory documents
  no member exposes, keyed by block (256 message numbers each): an append drafts one block, never the whole journal
  (a test keeps the cost of appends flat with 22,000 kept messages), a trim retires whole blocks (deciding what it drops and frees inside its transaction, so concurrent trims count a
  block once and the journal's start never moves back), and `history` pages
  by number from the block it needs. The member `log` is a window `{ start, messages }` holding every journal message
  after `start`, at most 256 messages and 512 KiB (UTF-16) of data. A peer behind `start` (a joiner, a slow one, a
  reconnected one) pages `history({ after, limit })` up to `start`, then applies the window; when the room no longer
  has what it missed (a live room trimmed it while the frame was away), it goes on from the window as a joiner does.
  No retention cap: delivery is bounded, not history. Keyed messages are one member: a keyed send is refused
  `too_large` when the member's encoded size would pass the part limit of client links (`MAX_CLIENT_FRAME`, 1 MiB),
  so a joiner's snapshot always fits. The size is counted as the wire carries it: each entry's key and data as JSON
  strings in UTF-8 (escapes included), plus measured bytes for an entry's fields, a peer and the root; kept as a
  running total, computed per update for that one key (tested with quotes, backslashes and non-ASCII text). A paged keyed snapshot for joiners is the later, fuller fix.
- **Cost.** Members are the store's documents (`room-store.ts`), re-exposed by every peer's `ViewRoom` as reference
  members: no derive maps or filters the log per peer; presence is derived once per room.
- **Messages.** `send({ messages: [{ key?, data }], ack? })` numbers each message (`seq`, per room). `data` is a JSON
  string (the kit stringifies and parses), so the server never walks it. Unkeyed ones go to the member `log`; keyed
  ones to the member `keyed`, `{ [peer]: { [key]: { seq, data } } }`: the entry object is created once, and a newer
  message sets only its two primitive leaves. Chord's pending queue (`delta/pending.ts`) folds primitive sets on one
  path, but any structural op clears its index, which is why keyed messages are a member of their own and never
  replace objects: between structural changes (a peer's first message under a new key, a peer leaving) a peer whose
  link stalls gets only the newest `seq` and `data` of each key; across such a change it may get some values in
  between. Tested over a link that holds back the server's messages (so the frame's acknowledgements stop and the
  server's window fills): fifty 2 KB updates reach it as about 6 KB (the two messages in its window and one folded
  update). A peer's keyed messages go when it leaves. **Live:** `log` keeps messages until every present peer
  acknowledged them (`ack({ seq })`, or `send`'s `ack`; the kit acknowledges what it applied, at most every 100 ms:
  with the window delivered and the keyed messages taken, that is the room's number, keyed messages included, so a
  room that sends keyed messages only never leaves a peer behind a later joiner and its links are not cut).
  No size limits; a peer that never acknowledges holds the log while connected (a writer could equally flood).
- **Base** (log and text): `{ seq, epoch, value }`. A joiner (or a peer that fell behind a trim) resets from it, then
  applies `log` entries after `base.seq`. **Log:** `log` keeps messages since the base; the leader's
  `snapshot({ seq, value })` writes the view's state through `ViewBacking.write`, becomes the base and trims the log.
  A change of the view's state the room did not write (the agent's `update`) resets the room: new base, `epoch` + 1.
- **A store's incarnation.** The room's facts carry the store's ID (`store`, made with its documents): a store made
  after the last one ended (its linger past, or the server restarted) numbers from 0 again, so a reconnecting frame
  that sees another store clears what it applied and goes on as a joiner (tested in Chromium: both frames away past
  the linger, then a message of the new store reaches them). A frame whose page does not answer a token request
  within 10 s asks again.
- **The last revision taken is the room's.** Which revision of the view's state the room took last is in its
  accounting document, so a reload's new attempt compares it at its first look and takes a change made meanwhile
  before anything is saved over it (tested: the agent changes the state while the plugin reloads).
- **Snapshots are compare-and-set.** The worker's view state carries a `revision` (grows with every write) and `by`
  (`room` or `other`: the agent, a page). `ViewBacking` states `{ value, revision, by }`; `write({ revision, ... })`
  writes only if the revision is still the one the room last saw, and the room serializes its writes. On a conflict
  the room first takes the outside update (a log room resets to it, a text room diffs it in as an edit), then writes
  again. A log snapshot carries `{ epoch, term, seq }` (`term` grows with
  each change of leader) and is refused unless it is the leader's, of the current epoch and term, and newer than the
  base: a delayed snapshot from an old leader cannot overwrite a newer state or the agent's reset. Its cost (the new
  base less the old base and the journal it replaces) is reserved against the budget before the view's state is
  written, and the base and the trim of the journal it replaces are one transaction: a snapshot the room cannot take
  writes nothing (tested).
- **Clock:** `now()` returns the server's `Date.now()`.
- **Events** (`emit`, `stream`): the store's `stream` is an event source (Chord events, `packages/chord/docs/events`),
  re-exposed by every peer's `ViewRoom`; `emit` emits each message in order as `{ from: peer, key?, data }`. Events
  take no room number and touch no journal, acknowledgement, trim, base, watermark or memory budget; a peer bound when
  the event flushes gets it (read-only peers too), a joiner gets none from before, and a peer that cannot keep up
  (Chord's event window, 32 messages per link) loses some. Only writers emit.
- **Monotonic acknowledgements:** the room keeps each peer's acknowledgement as the highest it saw (`ack`, a send's
  piggybacked `ack`), never past its last number: with sends pipelined, a delayed send's older acknowledgement cannot
  move it back.
- **A text room's text is saved from its documents.** The room's accounting document records the message that last
  changed the text and the one written last; the save routine follows that difference, so after a plugin reload the
  new attempt writes at once what the old one had not (tested: edit, reload, the text reaches the view's state). A
  room that opens over a stored document whose text differs from the view's current text (the agent changed it while
  no room was open) takes the current text as one edit over the stored IDs (tested with the room ended between).
- **Text state is the room's.** The id list and the editors' watermarks never live in the view's writable state: the
  worker keeps them in its own document family `p2.view-room` (keyed by view, retired with it), which only
  `ViewBacking.write` (server) changes. The view's state carries only `text` (what the agent and the page read). A
  change of `text` made elsewhere (the agent, a page's `setState`) reaches the room as an outside change and goes
  through the validated edit path (one diff edit); over 100,000 characters it is ignored. A stored room document is
  checked before use (shape, `IdList.loadCompact` in a try, id count equal to the text's length); a bad one starts over
  from the view's text with fresh ids.
- **Text** (server rules, jot's id-based editing, Weidner's articulated 1.4.0, MIT, 24 KB minified): the room's
  document is `{ text, textIds, textMarks }` (`textIds` articulated's compact saved `IdList`); the view's state gets
  `text` (other keys kept). `edit({ n,
  edits })` takes `insert { before, id, content, inWord }` / `delete { start, end, length }` (ids as `{ b, c }`); the
  server applies each with `applyEdit` (`text.ts`, shared with the kit: unknown `before` or known `id` drops an insert,
  an in-word insert after a deleted char is dropped, a delete covering more than `length + 10` is dropped, text at
  most 100,000 characters), logs every batch with its editor and `n`. The editor is the view principal's `editor`: the page passes the
  frame's first token's editor when it asks for a reconnect's token, and the server checks that editor was minted for
  the same viewer and opening, so it is server-derived and stable across reconnects. The server keeps a watermark per
  editor (in the room's document too, `textMarks`) and makes a batch at or below it a no-op (logged empty, so the sender drops
  it): a pending delete resent after a reconnect never deletes text inserted since. It writes the snapshot 500 ms after the
  last edit, and makes a new base every 200 entries. An outside change of `text` (the agent) becomes one server edit
  (common prefix and suffix kept), so pending edits survive it. Clients keep confirmed state + pending edits, apply
  logged edits with the same function, drop their own pending up to `n`, replay the rest; cursors are keyed messages
  `cursor` holding ids.
- **Room kinds** are fixed by the first `join`; another kind is refused while peers are present, else it resets. Only a
  frame that may write changes the kind (a reset trims the history): a read-only frame's `join` of another kind is
  refused. A frame that only offers methods joins without a kind. One frame has one room (one kind).

## 4. Methods and calls

`offer({ methods: [{ name, description, args }] })` stores a peer's list; the room's list is the leader's. The worker
variant has `methods()` and `call({ method, args })`: with no write peer present it fails "not open" at once;
otherwise the call joins `calls`, pinned to the leader and its offer number; the `view_call` tool checks the args
against the offered schema first. Only that peer's `answer({ id, result } | { id, error })` is accepted. If it leaves,
or offers again, before answering, the call fails "uncertain: it may or may not have run" (a method offered with
`idempotent: true` is given to the next leader instead); "uncertain" also when that was the last frame ("not open" is
only for a call made with no frame). Nothing is stored. A call waits for its answer, a 60 s timeout (Chord's `sleep`)
or its caller's cancellation, whichever comes first, and then leaves the room's calls in the store's own scope. The worker
gets `view_methods({ view })` and `view_call({ view, method, args })`, both `callers: ["tools"]` (code mode only,
`agent` and code mode MCP tools do the same). The `view` tool's `help` documents rooms, kinds and methods. Results are
untrusted input: any write peer may answer.

## 5. Decisions taken without the owner (conservative)

1. `mode` on the view principal (from the viewer's grant at mint): read-only viewers' frames only watch. Without it a
   view-only guest's frame (or a script with its token) could edit the text or answer the agent.
2. Deny-by-default through p2's `defineFacet`, not an audit of every factory.
3. Keyed messages replace "peer state": the latest keyed message per (peer, key) is peer state. It held: one numbering
   orders keyed and unkeyed messages, joiners get every present peer's keys, and a departed peer's keys go. Keyed data
   carries a one-character tag (`KeyedSchema`) so that Delta writes it as a set, which folds.
4. Through Radius the frame's kit script and socket carry no cookies; they work where the transport passes
   credential-less requests (loopback, tunnels). Radius relays are not verified: open item.
5. Overload (for the owner to review): (a) a live room's peer that stays behind every other peer's acknowledgement
   for longer than Chord's heartbeat close timeout (30 s) is disconnected (`revokeFrames({ link })`) and stops holding
   messages back; it reconnects with a new token and joins after the messages it missed. (b) One memory budget for
   all rooms, settings.json `viewRoomsMemory` (MiB, default 64): past it `send` and `edit` fail `room_full`; nothing is
   truncated. A room is charged, checked and counted in the same transaction step that keeps the thing: each journal
   message's strings as UTF-16 (data and sender) plus 128 bytes for its entry (measured on Node 24: 117 bytes for the
   message's two objects, in the journal and the window), each keyed entry's strings plus the same entry cost, and
   each base by its JSON (a text room's text, IDs and watermarks). No other limits of the room's own (owner,
   2026-11-11: no hard-coded limits); Chord's part limits apply to each call and each member.
6. The text room's IDs and watermarks live in the worker's `p2.view-room` documents, which only the room writes; a
   page's `setState` can change `text` only, which the room takes as one validated edit.

## 6. Tests

`test/p2/rooms.test.ts` (each case its own session): the token path over a real socket (a bad Host with a valid token,
reuse, cookie-only, `Origin: null` on `/chord` and on routes other than the kit, two redemptions at once); a view
principal's reach; a closed and reopened view; a closed view's state and backing held again (a late page, a restarted
worker under the lingering room) without an activation failure; a revoked guest grant; presence and leader handover; keyed folding over
a stalled link, joiners' keyed snapshot, the keyed member's part limit; a read-only frame cannot change or reset the
room; flat append cost with 22,000 kept messages, paged history; the memory budget charging empty messages; unkeyed
order and acknowledgement trimming; log snapshots (stale term, overtaken snapshot) and reset; text convergence,
watermark dedupe, the agent's text as an edit, over-limit text; the view's text changed while no room was open; a
reload before the text's save; calls: answered, not open, uncertain (leader left; last frame left), cancelled by the
caller, offered without a room. `test/p2/views-text.test.ts`: `applyEdit` (overlapping ID ranges, bad counters,
overflow, the limit), stored documents, the client's pending replay. `test/p2/ui-rooms.test.ts`: two Chromium
browsers share a text room both ways and see each other; a live room's frame reconnects after its link was cut and
goes on; the agent's call runs in the leader's frame.

## 7. Open

- Not tested: the lag eviction (5a) itself (that a frame which keeps acknowledging is not evicted is tested:
  `rooms-events.test.ts`, two frames of a keyed-only room past the lag limit, one over a slow path, no reconnect), a
  cost test of encodes with many peers.
- Radius (decision 4). The TUI shows no views, so no rooms.
- A paged keyed snapshot for joiners (now a keyed send past the link part limit is refused).
