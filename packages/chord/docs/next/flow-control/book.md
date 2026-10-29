---
title: Flow control for Chord links
cover: Slow / Links
kicker: A design note · Chord v2 slice 4 · 2026-10-22
subtitle: How a phone on a bad train connection keeps seeing the newest state of a streamed reply, and why the transport's own backpressure cannot do that
stats:
  - 9.4 s | how old the newest state was with transport backpressure only
  - 0.0 s | with an acknowledged window of two messages
  - 345 ms | another client's p95 during a call flood, without a call window
  - ~200 | lines for the converged design
note: |
  Written from the measurements and the cross-checked reports of the reviewers Astra and Fable (2026-10-22): Node 24.4.1,
  `ws` 8.22, separate server and client processes, a throttling proxy at 64 KiB/s. The numbers are single synthetic
  runs: they show failure modes, not production capacity. Relays: first decided as per-hop acknowledgements (b) on
  2026-10-23, then replaced by flow control per origin on 2026-10-24 after the slice 4a benchmarks (chapter VI).
colophon: Flow control for Chord links · fourth edition · 2026-10-24 · based on the reviewers' experiments and design §3, §22
---

# Before we begin {.preface}

Mario is on a train. His phone shows a p3 session in which the agent is writing a long reply. Every token is a small
state change: the worker commits it, the server relays it, the phone applies it. The train enters a tunnel and the
phone's link drops to a trickle, 64 KB per second. The worker keeps producing tokens at full speed.

Without flow control, every token still gets sent. The bytes pile up somewhere between the worker and the phone, and
when the train leaves the tunnel the phone has to work through a backlog of old tokens before it sees the current text.
It is not only slow: what it shows is minutes old, and nothing tells it so.

This note explains what keeps the phone current, why the obvious answer (let the transport push back) fails, and the
design Astra and Fable converged on after measuring it.

## Six things to know

:::findings
1. **Transport backpressure arrives too late.** The kernel's and a proxy's buffers take megabytes before a WebSocket
   reports anything buffered; the phone sees state 4 to 10 seconds old.
2. **Acknowledgements keep state fresh.** The receiving application acknowledges each message; at most two are in
   flight; the newest state was 0.0 seconds old on the same 64 KB/s link.
3. **Count messages, not bytes.** Each message carries everything that piled up since the last acknowledgement, so
   throughput adapts to the link by itself.
4. **Merge ops first, snapshot last.** 2,000 merged token appends cost 26 KB, sent one by one 46 KB; a snapshot of a
   member with 500 KB of history would cost 508 KB.
5. **Calls need their own window.** A tab firing 100,000 calls pushed another client's p95 to 345 ms; with a window of
   64 respected by the caller it stayed at 0.66 ms and the flood waited in the buggy tab.
6. **Nothing is refused for being too many** (decision K16): extra state is merged, extra calls wait.
:::

## Words used throughout

A **link** connects two hosts. The **provider** owns an object and sends its state; the **consumer** holds a
reference to it. A **hold** is one reference over a link, with its own stream of **ops** (Delta's changes). A
**snapshot** is a hold's whole state. An **acknowledgement** (`ack`) is a tiny message the consumer sends after it
applied a state message. **In flight** means sent and not yet acknowledged. **Coalescing** means merging the ops that
wait to be sent. A **relay** is a host in the middle (the server between worker and tab).

# Where the Bytes Hide {#hidden lede="Why the sender cannot see a slow phone."}

A WebSocket in Node reports `bufferedAmount`: bytes the library still holds. It looks like the perfect signal: stop
sending when it grows. The experiment says otherwise.

:::sequence animate | A flood of state messages to a slow phone through a proxy. The sender's buffer stays small; the kernel's and the proxy's do not.
actor worker "worker" "commits tokens" accent
actor ws "server WebSocket" "bufferedAmount"
actor kernel "kernel + proxy buffers" muted
actor phone "phone" "64 KB/s" blue
worker -> ws: token 1 … token 9,000
ws -> kernel: written at once (bufferedAmount stays near 0)
kernel -> phone: drains at 64 KB/s
note kernel: megabytes waiting
worker -> ws: token 9,001 (the newest)
ws -> kernel: queued behind everything
kernel --> phone: arrives seconds later
:::

| Flood, ~9,800 × 128 B per second, 64 KB/s link | Sender memory | Newest state the phone saw |
| --- | --- | --- |
| no flow control | 7.0 MB queued in the WebSocket, heap +18.5 MB | 9.4 s old |
| cap `bufferedAmount` at 64 KiB, merge pending state | +0.46 MB | **still 9.4 s old** |
| cap at 1 MiB (Fable's rerun) | small | 3.8 s, growing to 10.4 s |
| at most 1 to 4 acknowledged messages in flight, merge pending state | +0.4 MB | **0.0 s** |

The transport's backpressure protects the sender's memory, but freshness depends on buffers the sender cannot see:
the operating system's socket buffer, autotuned to hundreds of kilobytes, and every proxy on the way. A normal
streamed reply (50 tokens per second, 23 bytes each) never fills them; a burst or a tunnel does. Only the receiving
application knows what it has applied.

# Acknowledged Messages {#acks lede="A window of two messages in flight, and why it adapts to any link."}

The rule: a provider has at most **K = 2** state messages in flight per link. The consumer sends `ack` (three bytes in
the binary codec) after it applied one. While two are in flight, new commits do not produce messages; their ops wait,
merged per hold, and go out in the next message once an `ack` arrives.

:::steps | Two messages in flight on a slow link
+++ Fast link
Commits 1, 2, 3 each become a message; each is acknowledged before the next commit. Nothing waits: the window never
fills, so a normal stream behaves exactly as without flow control.
+++ The link slows
Messages 1 and 2 are in flight. Commits 3 to 400 arrive; their ops are folded into the pending queue of each member
they touch (chapter III). Memory: the net change, not the history; at most 10,000 ops per member.
+++ An ack arrives
`ack` for message 1. The provider sends message 3, carrying the folded ops of commits 3 to 400, encoded once.
The phone applies them as one batch and shows the newest text.
+++ Self-clocking
The slower the link, the more each message carries; the faster, the smaller and more frequent. Nobody measures
bandwidth: the acknowledgements pace the sender.
:::

:::raw
<div id="fc-sim" style="font-family: var(--sans, system-ui); margin: 1.5rem 0; padding: 1rem; border: 1px solid #d8d2c6; border-radius: 6px; background: #fbf9f4;">
  <div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:center; font-size:0.9rem;">
    <label>Link <input id="fc-rate" type="range" min="2" max="60" value="8"> <span id="fc-rate-v"></span> msgs/s</label>
    <label>Commits <input id="fc-prod" type="range" min="5" max="120" value="60"> <span id="fc-prod-v"></span> /s</label>
    <button id="fc-reset" style="font:inherit; padding:0.2rem 0.6rem;">Restart</button>
  </div>
  <canvas id="fc-canvas" width="640" height="220" style="width:100%; max-width:640px; display:block; margin-top:0.8rem;"></canvas>
  <div id="fc-stats" style="font-size:0.85rem; margin-top:0.4rem; color:#444;"></div>
</div>
<script>
(() => {
  const c = document.getElementById("fc-canvas"), g = c.getContext("2d");
  const rate = document.getElementById("fc-rate"), prod = document.getElementById("fc-prod");
  const rv = document.getElementById("fc-rate-v"), pv = document.getElementById("fc-prod-v");
  const stats = document.getElementById("fc-stats");
  let s;
  function reset() {
    s = { t: 0, commit: 0, naive: { queue: [], shown: 0, sent: 0 }, ack: { inflight: [], pending: 0, shown: 0, sent: 0, merged: 0 } };
  }
  function step(dt) {
    const r = +rate.value, p = +prod.value; rv.textContent = r; pv.textContent = p;
    s.t += dt;
    const commits = Math.floor((s.t) * p) - s.commit;
    for (let i = 0; i < commits; i++) {
      s.commit++;
      s.naive.queue.push(s.commit);
      s.ack.pending = s.commit;
    }
    // link capacity: r messages per second, shared model: each delivers one message per 1/r s
    s.naive.budget = (s.naive.budget || 0) + dt * r;
    while (s.naive.budget >= 1 && s.naive.queue.length) { s.naive.budget -= 1; s.naive.shown = s.naive.queue.shift(); s.naive.sent++; }
    s.ack.budget = (s.ack.budget || 0) + dt * r;
    while (s.ack.budget >= 1 && s.ack.inflight.length) { s.ack.budget -= 1; s.ack.shown = s.ack.inflight.shift(); }
    while (s.ack.inflight.length < 2 && s.ack.pending > (s.ack.inflight.at(-1) ?? s.ack.shown)) {
      s.ack.merged += s.ack.pending - (s.ack.inflight.at(-1) ?? s.ack.shown) - 1;
      s.ack.inflight.push(s.ack.pending); s.ack.sent++;
    }
  }
  function lane(y, label, queue, shown, color) {
    g.fillStyle = "#222"; g.font = "13px system-ui"; g.fillText(label, 8, y - 26);
    g.fillStyle = "#e9e3d6"; g.fillRect(8, y - 18, 520, 26);
    const n = Math.min(queue, 130);
    g.fillStyle = color;
    for (let i = 0; i < n; i++) g.fillRect(10 + i * 4, y - 15, 3, 20);
    g.fillStyle = "#222"; g.fillText(`waiting: ${queue}`, 540, y);
    const age = s.commit - shown;
    g.fillText(`phone shows commit ${shown}, ${age} behind`, 8, y + 28);
  }
  function draw() {
    g.clearRect(0, 0, c.width, c.height);
    lane(48, "No flow control: every commit is sent and queued", s.naive.queue.length, s.naive.shown, "#b5523b");
    lane(150, "Acknowledged window (K = 2), pending ops merged", s.ack.inflight.length, s.ack.shown, "#3b6fb5");
    stats.textContent = `newest commit ${s.commit} · window: ${s.ack.sent} messages carried ${s.commit} commits (${s.ack.merged} merged)`;
  }
  let last = performance.now();
  function frame(now) { step(Math.min((now - last) / 1000, 0.1)); last = now; draw(); requestAnimationFrame(frame); }
  document.getElementById("fc-reset").onclick = reset;
  reset(); requestAnimationFrame(frame);
})();
</script>
:::

The simulation above shows the same effect in miniature. Drag the link below the commit rate: the upper lane's queue
grows without bound and the phone falls further behind every second; the lower lane never has more than two messages
waiting, and the phone is at most a message behind.

# Fold the Backlog {#merge lede="What a waiting hold keeps while the window is full, and why it never measures sizes."}

While messages are in flight, each hold member keeps the ops of new commits in a **pending queue** and **folds** them:
a new op merges into the last pending op on the same path when that is safe, so a backlog keeps the net change, not
the history. When an acknowledgement frees a slot, the queue is encoded once into one message.

| Last pending op | New op | Kept |
| --- | --- | --- |
| `a text "Hel"` | `a text "lo"` | one `a text "Hello"` |
| `s count 41` or an append | `s count 42` | the `s`: it overwrites what came before |
| anything | `r value` | only the `r`: a replacement makes everything before it moot |
| anything on a path in the index | a structural op (`p`, `m`, `d`, `t`, `s` of an object) | appended; the index is cleared |

The merge partner is found through a **leaf index**: a map from path to the last pending append or primitive set on
that path. Leaf ops on different paths commute, so a new op may merge into an earlier one, not only into its
neighbour; a status field changing between two tokens no longer stops the reply from folding. Any structural op
clears the index, because after a splice `entries[7]` may name another entry. Past 10,000 pending ops the queue keeps
only "replace with the current value", which then costs nothing while the consumer stays slow.

**Why no size rule.** The first idea was to send a snapshot once the merged ops outgrow the member. The reviewers
measured it on real p2 data and it failed three ways: "snapshot bytes plus sent op bytes" is no bound (an interned path
lets a value grow faster than its ops: 5,404 B of snapshot after 832 B of ops), it drifts 1,254 times too high under
churn, and an exact size needs a size on every node of the value. Folding alone came within about 10% of an exact
oracle, with no measuring at all.

| 60 s stall, all workloads | Uncompressed | Compressed |
| --- | --- | --- |
| merged ops, no folding | 466 KB | 166 KB |
| adjacent folding | 399 KB | 147 KB |
| leaf index (the decision) | 372 KB | 145 KB |
| exact oracle (not buildable) | 335 KB | 136 KB |

**One queue for every slow consumer.** The same queue serves Chord's shared watch handle: a listener still busy with
the last frame gets the commits made meanwhile as one call with the newest value and the folded ops, instead of
today's "after 100 frames, replace everything". With a listener taking one second, a conversation view's watch went
from 402 calls and 17.9 MB of ops to 312 calls and 257 KB. Durable's event stream keeps a queue of its own, because
events are not state: folding would drop them.

:::raw
<p>Animation of the fold: <a href="https://radius.earendil.com/artifact/01m5nc9s24e9kscppen2fxgwye">How folding works</a>.</p>
:::

# Calls Get Their Own Window {#calls lede="Why acknowledged state does not protect against a call flood."}

Calls are small and the provider acknowledges nothing until they finish, so a byte or message window on state says
nothing about how many handlers run. A tab with a bug:

```ts
for (const note of notes) ref.add(note, ctx);   // 100,000 calls, none awaited
```

| 100,000 calls, handlers awaiting 10 ms | Finished in | Provider memory | Another client's p95 round trip |
| --- | --- | --- | --- |
| no limit | 0.66 s | +56.5 MB, 43,824 running | 129 ms (345 ms with trivial handlers) |
| provider-side semaphore of 64 | 15.9 s | +42.5 MB, 96,736 queued on the provider | 0.38 ms |
| caller-side window of 64 | 17.1 s | **+4 MB, nothing queued on the provider** | 0.66 ms |
| handlers doing 10 ms of CPU work | | | blocked about 1 s, with or without a limit |

The provider's `hello` announces a call window **N** (256 by default) per origin (chapter VI). A consumer keeps at
most N of its own calls unanswered per link; further calls wait in the link's call queue, in order. Nothing is refused (K16); a peer that sends
more than N is a protocol error. The flood waits in the tab that caused it. CPU-heavy handlers block the event loop
whatever the window: that stays the handler author's responsibility.

# Relays {#relays lede="One link to a worker carries many tabs. Decided: flow control per origin."}

The server relays every tab's holds to a session's worker over one link. Three ways to apply the acknowledged window
across that hop were considered:

:::flow wide animate | (a) End-to-end acknowledgements: the server acknowledges the worker only after the tab did.
row "Worker" accent
box w "worker" "K = 2 per link"
row "Server" muted
box s "server" "acks upstream after downstream"
row "Tabs" blue
box fast "fast tab" "desktop"
box slow "slow tab" "phone in a tunnel" dashed
arrow w -> s "state"
arrow s -> fast "state"
arrow s -> slow "state, slow"
arrow slow -> s "ack (late)" dashed
arrow s -> w "ack only when every tab acked" accent
note "Simplest, but the slow phone holds the worker's one window, so the fast tab's updates arrive in coarser, later batches too."
:::

:::flow wide animate | (b) Acknowledgements per hop: the server acknowledges at once and resets a slow tab.
row "Worker" accent
box w2 "worker" "K = 2 per link"
row "Server" muted
box s2 "server" "acks at once; window per tab"
row "Tabs" blue
box fast2 "fast tab" "desktop"
box slow2 "slow tab" "phone in a tunnel" dashed
arrow w2 -> s2 "state"
arrow s2 -> w2 "ack at once" accent
arrow s2 -> fast2 "state, current"
arrow s2 -> slow2 "window full: its parts dropped" dashed
arrow s2 -> w2 "reset: fresh snapshots" accent
note "The server cannot fold opaque parts, so it drops them and asks for snapshots. Built and measured in slice 4a: a 1 s stall cost three full snapshots (~1.5 MiB) and ~24 s to catch up under streaming."
:::

:::flow wide animate | (c) Flow control per origin (decided 2026-10-24): the worker keeps a window per tab; the relay only forwards.
row "Worker" accent
box w3 "worker" "K = 2 per (link, origin)"
row "Server" muted
box s3 "server" "forwards; FIFO of senders"
row "Tabs" blue
box fast3 "fast tab" "origin 1"
box slow3 "slow tab" "origin 2, in a tunnel" dashed
arrow w3 -> s3 "state @1, state @2"
arrow s3 -> fast3 "state, current"
arrow s3 -> slow3 "state, slow" dashed
arrow slow3 -> s3 "ack (late)" dashed
arrow s3 -> w3 "ack @2 when the tab acked" accent
note "The relay numbers each tab (an origin) and forwards at once; each tab's ack goes back to the worker that sent the message. The worker folds the slow tab's commits in that origin's pending queues, exactly as for a direct tab; the fast tab is another origin with its own window."
:::

How (c) works:

- **Origins.** The relay gives each downstream link a number, never reused; every message upstream carries it
  (`origin`), and the worker keys holds, calls, windows and acks by (link, origin, id). Ids are not renumbered.
- **What the relay keeps.** Per relayed hold its upstream link and its original `hold` message (to route calls and
  hold again after a worker restart); per tab a FIFO of which worker sent each message in flight, so each in-order
  `ack` goes back to the right worker. Nothing is parsed, folded, dropped or reset.
- **Calls.** N is per origin at the worker; the relay forwards calls at once, each tab bounded by its own window.
- **A tab leaves.** Its link closes; the relay sends `closed { origin }` to each worker it relayed to, which releases
  that origin's holds and aborts its calls.
- **Cost.** A tab served by W workers may have 2W messages in flight (plus the relay's own 2). Two bytes of origin per
  message on the worker link.

# What Changes in the Design {.epilogue lede="The converged scheme, what it replaces, and the relay decision."}

**Converged** (Astra and Fable, after cross-checking each other's experiments): at most K = 2 acknowledged state
messages in flight; pending ops folded per hold member through a leaf index, capped at 10,000; a call window N
announced in `hello`, extra calls queued by the caller; holds unlimited; size limits stay a separate check.

**Replaced** from the design (§3, §22): the byte window and its credit messages, snapshot admission and debt (R19, Q3),
cut C12's call-credit accounting, any adapter backlog API. IPC and WebSocket behave the same, because acknowledgements
are messages.

**Relays (owner):** per-hop acknowledgements (b) were decided on 2026-10-23 and built in slice 4a; the benchmarks
showed a slow tab recovering through resets far worse than a direct tab (24 s and three snapshots after a 1 s stall).
On 2026-10-24 they were replaced by **flow control per origin** (c): the worker keeps window, pending queues and calls
per (link, origin), the relay only forwards and returns acks. Measured after the rework: a slow tab through the relay
catches up exactly like a direct one. The circuit breaker stayed undecided; the heartbeat (15 s ping, 30 s close)
was built instead.

# Measurements {.appendix}

| Experiment | Setup | Result |
| --- | --- | --- |
| normal stream | 50 × 23 B/s through 64 KiB/s | no buffering, frames ≤ 2 ms old |
| flood, no control | ~9,800 × 128 B/s, 10 s | 7.0 MB in `bufferedAmount`, heap +18.5 MB, newest state 9.4 s old |
| flood, `bufferedAmount` ≤ 64 KiB + merging | same | heap +0.46 MB, newest state 9.4 s old |
| flood, 1 to 4 acked messages + merging | same | heap +0.4 MB, newest state 0.0 s old, 98 % fewer messages |
| client stops reading (loopback) | 20k × 90 B/s, 15 s | 23.4 MiB buffered, RSS +121 MB; merging above 1 MiB: flat |
| IPC to a busy child | 623k sends | `send()` false from ~64 KB, parent +1,035 MB; the callback acknowledges the write, not the handler |
| call flood | 100,000 calls, see chapter IV | caller-side window: +4 MB, other client p95 0.66 ms |
| slow tab through a relay, (b) resets | 64 KiB/s, 100 tokens/s into a 500 KB view, 1 s stall | ~24 s to catch up, three full snapshots (~1.5 MiB) |
| slow tab through a relay, (c) per origin | same, 1 s / 10 s / 60 s stall | caught up after 0.02 / 0.08 / 0.38 s, 485 B / 4.1 KiB / 23.7 KiB (same as direct) |
